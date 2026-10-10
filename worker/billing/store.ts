/** What billing keeps per account; D1 in production, memory in tests. */
import type { Entitlements } from "../../src/storage/account-protocol.ts";

/** A subscription's state as of one Stripe event. */
export type SubscriptionChange = {
  readonly eventId: string;
  /** Stripe event `created`, seconds; an older change never overwrites a newer one. */
  readonly eventCreated: number;
  readonly userId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly status: string;
  /** Epoch ms Pro lasts until, or null when the subscription doesn't grant it. */
  readonly proUntil: number | null;
};

export interface EntitlementStore {
  entitlementsOf(userId: string): Promise<Entitlements | null>;
  customerOf(userId: string): Promise<string | null>;
  userOfCustomer(customerId: string): Promise<string | null>;
  /** Links an account to its Stripe customer (creating its row if needed). */
  saveCustomer(userId: string, customerId: string, now: number): Promise<void>;
  /**
   * Applies a change once per event id, and only if it isn't older than the last applied one.
   * Returns false when the event was already handled.
   */
  applySubscription(change: SubscriptionChange, now: number): Promise<boolean>;
}
