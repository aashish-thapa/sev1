/** The browser's side of /api/billing: start a Stripe Checkout or open the Customer Portal, then go there. */
import { z } from "zod";
import { API_ERRORS, type ApiError } from "./account-protocol.ts";

/** Flip when Stripe is set up: until then the profile shows Pro as coming soon and never calls billing. */
export const IS_PRO_ON_SALE = false;

export const PRO_PLANS = ["pro-monthly", "pro-yearly"] as const;
export type ProPlan = (typeof PRO_PLANS)[number];

/** What each plan's button says. Stripe holds the prices themselves; change both together. */
export const PRO_PLAN_LABELS: Readonly<Record<ProPlan, string>> = { "pro-monthly": "$4.99 a month", "pro-yearly": "$39 a year" };

const RedirectSchema = z.object({ url: z.url() });
const ErrorSchema = z.object({ error: z.enum(API_ERRORS) });

/** Why a billing step didn't go through, in terms the profile can explain. */
export type BillingProblem = "signed_out" | "not_configured" | "already_pro" | "never_subscribed" | "provider_down" | "unreachable";

/** The server's error codes (API_ERRORS) a billing call can answer with, and what each means here. */
const PROBLEM_BY_ERROR: Readonly<Partial<Record<ApiError, BillingProblem>>> = {
  signed_out: "signed_out",
  billing_unavailable: "not_configured",
  already_subscribed: "already_pro",
  no_subscription: "never_subscribed",
  payment_provider: "provider_down",
};

export type BillingOutcome = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly problem: BillingProblem };

export interface BillingApi {
  checkout(plan: ProPlan): Promise<BillingOutcome>;
  portal(): Promise<BillingOutcome>;
}

export class HttpBillingApi implements BillingApi {
  checkout(plan: ProPlan) {
    return post("/api/billing/checkout", { plan });
  }

  portal() {
    return post("/api/billing/portal", {});
  }
}

async function post(path: string, body: unknown): Promise<BillingOutcome> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = RedirectSchema.safeParse(json);
      return parsed.success ? { ok: true, url: parsed.data.url } : { ok: false, problem: "unreachable" };
    }
    // The body's code says what went wrong; the status alone is ambiguous (409 is "already subscribed").
    const error = ErrorSchema.safeParse(json).data?.error;
    return { ok: false, problem: (error && PROBLEM_BY_ERROR[error]) ?? "unreachable" };
  } catch {
    return { ok: false, problem: "unreachable" };
  }
}
