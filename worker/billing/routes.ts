/** HTTP for /api/billing: parse, call the billing service, shape the response. No rules live here. */
import { CheckoutRequestSchema } from "../../src/storage/account-protocol.ts";
import type { AccountService } from "../api/accounts.ts";
import { failure, isSameOrigin, json, readBody, sessionTokenOf } from "../api/http.ts";
import { PaymentProviderError } from "./gateway.ts";
import type { BillingService } from "./service.ts";

export const BILLING_PREFIX = "/api/billing/";
/** Webhook payloads are small JSON objects; anything bigger isn't Stripe. */
const MAX_WEBHOOK_BYTES = 512 * 1024;

const FAILURE = {
  already_subscribed: { status: 409, message: "You already have Pro. Manage it from the billing portal." },
  no_subscription: { status: 404, message: "There's no subscription on this account yet." },
} as const;

/** `billing` is null until the Stripe keys are configured; every billing route then answers 503. */
export async function handleBilling(request: Request, accounts: AccountService, billing: BillingService | null): Promise<Response> {
  const { pathname, origin } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  if (!billing) return failure("billing_unavailable", "Billing isn't set up yet.", 503);

  try {
    switch (route) {
      case "POST /api/billing/webhook": {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) return failure("invalid", "Payload too large.", 413);
        const result = await billing.handleWebhook(rawBody, request.headers.get("stripe-signature"));
        // Stripe retries anything that isn't 2xx: refuse forgeries, acknowledge everything verified.
        return result === "unverified" ? failure("forbidden", "Signature check failed.", 400) : json({ received: true, result });
      }
      case "POST /api/billing/checkout":
      case "POST /api/billing/portal": {
        if (!isSameOrigin(request)) return failure("forbidden", "Cross-site requests are not allowed.", 403);
        const user = await accounts.userFor(sessionTokenOf(request));
        if (!user) return failure("signed_out", "Sign in to manage Pro.", 401);
        let result;
        if (route === "POST /api/billing/checkout") {
          const body = await readBody(request, CheckoutRequestSchema);
          if (!body.ok) return body.response;
          result = await billing.checkout(user, body.data.plan, origin);
        } else {
          result = await billing.portal(user, origin);
        }
        if (!result.ok) return failure(result.failure, FAILURE[result.failure].message, FAILURE[result.failure].status);
        return json({ url: result.url });
      }
      default:
        return failure("not_found", `No route for ${route}.`, 404);
    }
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    return failure("payment_provider", "The payment provider couldn't be reached. Try again in a minute.", 502);
  }
}
