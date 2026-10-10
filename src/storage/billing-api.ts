/** The browser's side of /api/billing: start a Stripe Checkout or open the Customer Portal, then go there. */
import { z } from "zod";

export const PRO_PLANS = ["pro-monthly", "pro-yearly"] as const;
export type ProPlan = (typeof PRO_PLANS)[number];

/** What each plan's button says. Stripe holds the prices themselves; change both together. */
export const PRO_PLAN_LABELS: Readonly<Record<ProPlan, string>> = { "pro-monthly": "$4.99 a month", "pro-yearly": "$39 a year" };

const RedirectSchema = z.object({ url: z.url() });
const ErrorSchema = z.object({ error: z.string() });

/** Why a billing step didn't go through, in terms the profile can explain. */
export type BillingProblem = "signed_out" | "not_configured" | "never_subscribed" | "unreachable";

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
    const error = ErrorSchema.safeParse(json).data?.error;
    if (response.status === 401 || error === "signed_out") return { ok: false, problem: "signed_out" };
    if (response.status === 503 || error === "billing_not_configured") return { ok: false, problem: "not_configured" };
    if (response.status === 409) return { ok: false, problem: "never_subscribed" };
    return { ok: false, problem: "unreachable" };
  } catch {
    return { ok: false, problem: "unreachable" };
  }
}
