import { z } from "zod";
import type { Entitlements } from "../../src/storage/account-protocol.ts";
import type { EntitlementStore, SubscriptionChange } from "./store.ts";

const CosmeticsSchema = z.array(z.string());

function parseCosmetics(text: string): string[] {
  try {
    const parsed = CosmeticsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export class D1EntitlementStore implements EntitlementStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async entitlementsOf(userId: string): Promise<Entitlements | null> {
    const row = await this.db.prepare("SELECT pro_until, cosmetics FROM entitlements WHERE user_id = ?").bind(userId).first<{ pro_until: number | null; cosmetics: string }>();
    return row ? { proUntil: row.pro_until, cosmetics: parseCosmetics(row.cosmetics) } : null;
  }

  async customerOf(userId: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT stripe_customer_id FROM entitlements WHERE user_id = ?").bind(userId).first<{ stripe_customer_id: string | null }>();
    return row?.stripe_customer_id ?? null;
  }

  async userOfCustomer(customerId: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT user_id FROM entitlements WHERE stripe_customer_id = ?").bind(customerId).first<{ user_id: string }>();
    return row?.user_id ?? null;
  }

  async saveCustomer(userId: string, customerId: string, now: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO entitlements (user_id, stripe_customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at")
      .bind(userId, customerId, now)
      .run();
  }

  async applySubscription(change: SubscriptionChange, now: number): Promise<boolean> {
    const seen = await this.db.prepare("SELECT 1 FROM stripe_events WHERE event_id = ?").bind(change.eventId).first();
    if (seen) return false;
    // One batch is one transaction: the entitlement and the "handled" mark land together or not at all.
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO entitlements (user_id, stripe_customer_id, pro_until, subscription_id, subscription_status, subscription_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, pro_until = excluded.pro_until, subscription_id = excluded.subscription_id, " +
            "subscription_status = excluded.subscription_status, subscription_event_at = excluded.subscription_event_at, updated_at = excluded.updated_at " +
            "WHERE excluded.subscription_event_at >= entitlements.subscription_event_at",
        )
        .bind(change.userId, change.customerId, change.proUntil, change.subscriptionId, change.status, change.eventCreated, now),
      this.db.prepare("INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING").bind(change.eventId, now),
    ]);
    return true;
  }
}
