import { afterEach, describe, expect, it } from "vitest";
import { HttpBillingApi } from "./billing-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("billing client", () => {
  const billing = new HttpBillingApi();

  it("follows the checkout URL Stripe hands back", async () => {
    answer(200, { url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    expect(await billing.checkout("pro-monthly")).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  });

  it("explains each refusal the server can give", async () => {
    answer(401, { error: "signed_out" });
    expect(await billing.checkout("pro-yearly")).toEqual({ ok: false, problem: "signed_out" });
    answer(503, { error: "billing_unavailable" });
    expect(await billing.checkout("pro-yearly")).toEqual({ ok: false, problem: "not_configured" });
    answer(409, { error: "already_subscribed" });
    expect(await billing.checkout("pro-monthly")).toEqual({ ok: false, problem: "already_pro" });
    answer(404, { error: "no_subscription" });
    expect(await billing.portal()).toEqual({ ok: false, problem: "never_subscribed" });
    answer(502, { error: "payment_provider" });
    expect(await billing.portal()).toEqual({ ok: false, problem: "provider_down" });
  });

  it("treats a network failure or a malformed answer as unreachable", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    expect(await billing.portal()).toEqual({ ok: false, problem: "unreachable" });
    answer(200, { nope: true });
    expect(await billing.portal()).toEqual({ ok: false, problem: "unreachable" });
  });
});
