/**
 * Pro subscriptions: send a signed-in player to Stripe Checkout or the Customer Portal, and turn
 * Stripe's verified webhook events into entitlements. The client never decides what it has paid for.
 */
import type { ProPlan } from "../../src/storage/account-protocol.ts";
import type { User } from "../api/store.ts";
import type { PaymentGateway } from "./gateway.ts";
import { parseBillingEvent } from "./events.ts";
import { isAuthenticStripeEvent } from "./signature.ts";
import type { EntitlementStore } from "./store.ts";

export type BillingConfig = { readonly prices: Readonly<Record<ProPlan, string>>; readonly webhookSecret: string };

export type RedirectResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly failure: "already_subscribed" | "no_subscription" };
export type WebhookResult = "applied" | "duplicate" | "ignored" | "unverified" | "unknown_customer";

type Clock = () => number;

export class BillingService {
  private readonly store: EntitlementStore;
  private readonly gateway: PaymentGateway;
  private readonly config: BillingConfig;
  private readonly now: Clock;

  constructor(store: EntitlementStore, gateway: PaymentGateway, config: BillingConfig, now: Clock) {
    this.store = store;
    this.gateway = gateway;
    this.config = config;
    this.now = now;
  }

  /** A Checkout page for Pro; one Stripe customer per account, reused on every attempt. */
  async checkout(user: User, plan: ProPlan, origin: string): Promise<RedirectResult> {
    const current = await this.store.entitlementsOf(user.id);
    if (current?.proUntil && current.proUntil > this.now()) return { ok: false, failure: "already_subscribed" };
    let customerId = await this.store.customerOf(user.id);
    if (!customerId) {
      customerId = await this.gateway.createCustomer(user.id, user.username);
      await this.store.saveCustomer(user.id, customerId, this.now());
    }
    const url = await this.gateway.createCheckout({
      customerId,
      priceId: this.config.prices[plan],
      userId: user.id,
      successUrl: `${origin}/?billing=success`,
      cancelUrl: `${origin}/?billing=cancelled`,
    });
    return { ok: true, url };
  }

  /** The Customer Portal, for accounts that have ever checked out. */
  async portal(user: User, origin: string): Promise<RedirectResult> {
    const customerId = await this.store.customerOf(user.id);
    if (!customerId) return { ok: false, failure: "no_subscription" };
    return { ok: true, url: await this.gateway.createPortal(customerId, `${origin}/`) };
  }

  /** Verifies, parses and applies one webhook delivery. Only a verified event can change entitlements. */
  async handleWebhook(rawBody: string, signatureHeader: string | null): Promise<WebhookResult> {
    const nowMs = this.now();
    if (!(await isAuthenticStripeEvent(rawBody, signatureHeader, this.config.webhookSecret, Math.floor(nowMs / 1000)))) return "unverified";
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch (error) {
      if (error instanceof SyntaxError) return "ignored";
      throw error;
    }
    const event = parseBillingEvent(raw);
    switch (event.kind) {
      case "ignored":
        return "ignored";
      case "checkout":
        // The customer is normally linked when checkout starts; this covers a lost write in between.
        if (!(await this.store.userOfCustomer(event.customerId))) await this.store.saveCustomer(event.userId, event.customerId, nowMs);
        return "applied";
      case "subscription": {
        const userId = (await this.store.userOfCustomer(event.customerId)) ?? event.userIdHint;
        if (!userId) return "unknown_customer";
        const isNew = await this.store.applySubscription(
          { eventId: event.eventId, eventCreated: event.eventCreated, userId, customerId: event.customerId, subscriptionId: event.subscriptionId, status: event.status, proUntil: event.proUntil },
          nowMs,
        );
        return isNew ? "applied" : "duplicate";
      }
    }
  }
}
