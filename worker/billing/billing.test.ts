import { describe, expect, it } from "vitest";
import type { Entitlements } from "../../src/storage/account-protocol.ts";
import { AccountService } from "../api/accounts.ts";
import type { AccountStore, User } from "../api/store.ts";
import type { CheckoutRequest, PaymentGateway } from "./gateway.ts";
import { handleBilling } from "./routes.ts";
import { BillingService } from "./service.ts";
import { isAuthenticStripeEvent, signPayload } from "./signature.ts";
import type { EntitlementStore, SubscriptionChange } from "./store.ts";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 9, 10, 12);
const NOW_SECONDS = Math.floor(NOW / 1000);
const PERIOD_END = NOW_SECONDS + 30 * 24 * 3600;
const user: User = { id: "user-1", username: "maya", passwordHash: "x", createdAt: NOW };

class MemoryEntitlementStore implements EntitlementStore {
  readonly rows = new Map<string, { customerId: string | null; proUntil: number | null; eventAt: number; status: string | null }>();
  readonly events = new Set<string>();

  async entitlementsOf(userId: string): Promise<Entitlements | null> {
    const row = this.rows.get(userId);
    return row ? { proUntil: row.proUntil, cosmetics: [] } : null;
  }
  async customerOf(userId: string) {
    return this.rows.get(userId)?.customerId ?? null;
  }
  async userOfCustomer(customerId: string) {
    return [...this.rows.entries()].find(([, row]) => row.customerId === customerId)?.[0] ?? null;
  }
  async saveCustomer(userId: string, customerId: string) {
    const row = this.rows.get(userId);
    this.rows.set(userId, { proUntil: null, eventAt: 0, status: null, ...row, customerId });
  }
  async applySubscription(change: SubscriptionChange) {
    if (this.events.has(change.eventId)) return false;
    this.events.add(change.eventId);
    const row = this.rows.get(change.userId);
    if (!row || change.eventCreated >= row.eventAt) {
      this.rows.set(change.userId, { customerId: change.customerId, proUntil: change.proUntil, eventAt: change.eventCreated, status: change.status });
    }
    return true;
  }
}

class FakeGateway implements PaymentGateway {
  customers = 0;
  checkouts: CheckoutRequest[] = [];
  async createCustomer() {
    this.customers += 1;
    return `cus_${this.customers}`;
  }
  async createCheckout(request: CheckoutRequest) {
    this.checkouts.push(request);
    return "https://checkout.stripe.com/c/pay/cs_test_1";
  }
  async createPortal(customerId: string) {
    return `https://billing.stripe.com/p/session/${customerId}`;
  }
}

function setup() {
  const store = new MemoryEntitlementStore();
  const gateway = new FakeGateway();
  const billing = new BillingService(store, gateway, { prices: { "pro-monthly": "price_month", "pro-yearly": "price_year" }, webhookSecret: SECRET }, () => NOW);
  return { store, gateway, billing };
}

function subscriptionEvent(id: string, type: string, status: string, created = NOW_SECONDS, customer = "cus_1") {
  return JSON.stringify({ id, type, created, data: { object: { id: "sub_1", customer, status, items: { data: [{ current_period_end: PERIOD_END }] }, metadata: {} } } });
}

async function signed(body: string, at = NOW_SECONDS) {
  return `t=${at},v1=${await signPayload(SECRET, at, body)}`;
}

describe("webhook signatures", () => {
  const body = subscriptionEvent("evt_1", "customer.subscription.created", "active");

  it("accepts Stripe's signature and ignores other schemes", async () => {
    expect(await isAuthenticStripeEvent(body, `${await signed(body)},v0=deadbeef`, SECRET, NOW_SECONDS)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a missing header and a stale timestamp", async () => {
    const header = await signed(body);
    expect(await isAuthenticStripeEvent(body.replace("active", "trialing"), header, SECRET, NOW_SECONDS)).toBe(false);
    expect(await isAuthenticStripeEvent(body, header, "whsec_other", NOW_SECONDS)).toBe(false);
    expect(await isAuthenticStripeEvent(body, null, SECRET, NOW_SECONDS)).toBe(false);
    expect(await isAuthenticStripeEvent(body, await signed(body, NOW_SECONDS - 600), SECRET, NOW_SECONDS)).toBe(false);
    expect(await isAuthenticStripeEvent(body, `t=${NOW_SECONDS}`, SECRET, NOW_SECONDS)).toBe(false);
  });
});

describe("checkout and portal", () => {
  it("creates one customer per account and reuses it", async () => {
    const { billing, gateway, store } = setup();
    expect(await billing.checkout(user, "pro-monthly", "https://sev1.test")).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    await billing.checkout(user, "pro-yearly", "https://sev1.test");
    expect(gateway.customers).toBe(1);
    expect(gateway.checkouts[1]?.priceId).toBe("price_year");
    expect(gateway.checkouts[0]).toMatchObject({ customerId: "cus_1", priceId: "price_month", userId: "user-1", successUrl: "https://sev1.test/?billing=success" });
    expect(await store.customerOf("user-1")).toBe("cus_1");
  });

  it("won't sell Pro twice, and only opens the portal for customers", async () => {
    const { billing, store } = setup();
    expect(await billing.portal(user, "https://sev1.test")).toEqual({ ok: false, failure: "no_subscription" });
    await store.saveCustomer("user-1", "cus_1");
    await billing.handleWebhook(subscriptionEvent("evt_1", "customer.subscription.created", "active"), await signed(subscriptionEvent("evt_1", "customer.subscription.created", "active")));
    expect(await billing.checkout(user, "pro-monthly", "https://sev1.test")).toEqual({ ok: false, failure: "already_subscribed" });
    expect(await billing.portal(user, "https://sev1.test")).toEqual({ ok: true, url: "https://billing.stripe.com/p/session/cus_1" });
  });
});

describe("subscription lifecycle", () => {
  async function deliver(billing: BillingService, body: string) {
    return billing.handleWebhook(body, await signed(body));
  }

  it("grants Pro until the period end, keeps it through retries, and clears it when cancelled", async () => {
    const { billing, store } = setup();
    await store.saveCustomer("user-1", "cus_1");
    const created = subscriptionEvent("evt_1", "customer.subscription.created", "active");
    expect(await deliver(billing, created)).toBe("applied");
    expect(await deliver(billing, created)).toBe("duplicate");
    expect((await store.entitlementsOf("user-1"))?.proUntil).toBe(PERIOD_END * 1000);

    expect(await deliver(billing, subscriptionEvent("evt_2", "customer.subscription.updated", "past_due", NOW_SECONDS + 10))).toBe("applied");
    expect((await store.entitlementsOf("user-1"))?.proUntil).toBeNull();

    expect(await deliver(billing, subscriptionEvent("evt_3", "customer.subscription.deleted", "canceled", NOW_SECONDS + 20))).toBe("applied");
    expect((await store.entitlementsOf("user-1"))?.proUntil).toBeNull();
  });

  it("never lets an older event overwrite a newer one", async () => {
    const { billing, store } = setup();
    await store.saveCustomer("user-1", "cus_1");
    await deliver(billing, subscriptionEvent("evt_new", "customer.subscription.deleted", "canceled", NOW_SECONDS + 60));
    await deliver(billing, subscriptionEvent("evt_old", "customer.subscription.created", "active", NOW_SECONDS));
    expect((await store.entitlementsOf("user-1"))?.proUntil).toBeNull();
  });

  it("refuses unsigned events and ignores customers it can't place", async () => {
    const { billing, store } = setup();
    const body = subscriptionEvent("evt_1", "customer.subscription.created", "active");
    expect(await billing.handleWebhook(body, null)).toBe("unverified");
    expect(await deliver(billing, subscriptionEvent("evt_2", "customer.subscription.created", "active", NOW_SECONDS, "cus_stranger"))).toBe("unknown_customer");
    expect(await store.entitlementsOf("user-1")).toBeNull();
    expect(await deliver(billing, JSON.stringify({ id: "evt_3", type: "invoice.paid", data: { object: {} } }))).toBe("ignored");
  });

  it("links the customer from a completed checkout if the earlier write was lost", async () => {
    const { billing, store } = setup();
    const completed = JSON.stringify({ id: "evt_c", type: "checkout.session.completed", data: { object: { customer: "cus_9", client_reference_id: "user-1" } } });
    expect(await deliver(billing, completed)).toBe("applied");
    expect(await store.userOfCustomer("cus_9")).toBe("user-1");
  });
});

describe("billing routes", () => {
  const accounts = new AccountService({} as AccountStore, () => NOW);

  it("answer 503 until Stripe is configured", async () => {
    const response = await handleBilling(new Request("https://sev1.test/api/billing/checkout", { method: "POST" }), accounts, null);
    expect(response.status).toBe(503);
  });

  it("require sign-in for checkout and refuse unsigned webhooks", async () => {
    const { billing } = setup();
    const checkout = await handleBilling(new Request("https://sev1.test/api/billing/checkout", { method: "POST" }), accounts, billing);
    expect(checkout.status).toBe(401);
    const webhook = await handleBilling(new Request("https://sev1.test/api/billing/webhook", { method: "POST", body: "{}" }), accounts, billing);
    expect(webhook.status).toBe(400);
  });

  it("validate the plan before anything reaches Stripe", async () => {
    const { billing, gateway } = setup();
    const signedIn = new AccountService({ findSessionUser: async () => user } as unknown as AccountStore, () => NOW);
    const ask = (body: string) =>
      handleBilling(new Request("https://sev1.test/api/billing/checkout", { method: "POST", headers: { cookie: "sev1_session=t" }, body }), signedIn, billing);
    expect((await ask(JSON.stringify({ plan: "pro-lifetime" }))).status).toBe(400);
    const yearly = await ask(JSON.stringify({ plan: "pro-yearly" }));
    expect(yearly.status).toBe(200);
    expect(gateway.checkouts.at(-1)?.priceId).toBe("price_year");
  });

  it("refuse checkout started from another site", async () => {
    const { billing } = setup();
    const request = new Request("https://sev1.test/api/billing/checkout", { method: "POST", headers: { origin: "https://evil.test" } });
    expect((await handleBilling(request, accounts, billing)).status).toBe(403);
  });
});
