import { useState } from "react";
import { isPro, PRO_PERKS, type Entitlements } from "../domain/entitlements.ts";
import { PRO_PLAN_LABELS, type BillingApi, type BillingProblem, type ProPlan } from "../storage/billing-api.ts";

type Props = {
  entitlements: Entitlements | null;
  isSignedIn: boolean;
  billing: BillingApi;
  /** Where a successful step sends the browser; injected so tests needn't navigate. */
  go: (url: string) => void;
  now: number;
  onSignUp: () => void;
};

const PROBLEM_TEXT: Readonly<Record<BillingProblem, string>> = {
  signed_out: "Sign in first: Pro belongs to your account, so it follows you to any device.",
  not_configured: "Pro isn’t on sale yet. Check back soon.",
  never_subscribed: "There’s no subscription on this account to manage.",
  unreachable: "Couldn’t reach the payment page. Try again in a moment.",
};

/** Pro in the profile: what it adds, and the way to get or manage it. Never touches rank: no XP, pay or promotions. */
export function ProPanel({ entitlements, isSignedIn, billing, go, now, onSignUp }: Props) {
  const [busy, setBusy] = useState<ProPlan | "portal" | null>(null);
  const [problem, setProblem] = useState<BillingProblem | null>(null);
  const isActive = isPro(entitlements, now);

  const run = async (step: ProPlan | "portal") => {
    setBusy(step);
    setProblem(null);
    const outcome = step === "portal" ? await billing.portal() : await billing.checkout(step);
    setBusy(null);
    if (outcome.ok) go(outcome.url);
    else setProblem(outcome.problem);
  };

  return (
    <section className="pro" aria-labelledby="pro-title">
      <header className="badges__head">
        <h2 id="pro-title" className="home__heading">
          sev1 Pro
        </h2>
        {isActive && entitlements?.proUntil && (
          <p className="badges__count">Active until {new Date(entitlements.proUntil).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
        )}
      </header>
      <p className="pro__lede">More practice and a few comforts. Promotions, pay and the leaderboard are earned the same way by everyone.</p>
      <ul className="pro__perks">
        {PRO_PERKS.map((perk) => (
          <li key={perk.id}>
            <strong>{perk.title}</strong>
            <span>{perk.description}</span>
          </li>
        ))}
      </ul>
      <div className="pro__actions">
        {isActive ? (
          <button type="button" className="button button--ghost" disabled={busy !== null} onClick={() => void run("portal")}>
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </button>
        ) : !isSignedIn ? (
          <button type="button" className="button button--primary" onClick={onSignUp}>
            Sign up to go Pro
          </button>
        ) : (
          <>
            <button type="button" className="button button--primary" disabled={busy !== null} onClick={() => void run("pro-monthly")}>
              {busy === "pro-monthly" ? "Opening checkout…" : PRO_PLAN_LABELS["pro-monthly"]}
            </button>
            <button type="button" className="button button--ghost" disabled={busy !== null} onClick={() => void run("pro-yearly")}>
              {busy === "pro-yearly" ? "Opening checkout…" : PRO_PLAN_LABELS["pro-yearly"]}
            </button>
          </>
        )}
      </div>
      <p className="pro__status" role="status">
        {problem ? PROBLEM_TEXT[problem] : isActive ? "Thanks for keeping sev1 running." : "Cancel any time from here; Pro runs to the end of the period you paid for."}
      </p>
    </section>
  );
}
