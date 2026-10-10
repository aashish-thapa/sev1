/**
 * What earned money buys. Today: the step-by-step solution to a live incident — priced so it
 * always costs more than the incident pays, and dearer the harder the incident and the more
 * senior you are. A bought solution makes the run assisted: no bonus, no experience.
 */
import type { Level } from "./career.ts";
import { LEDGER_LIMIT, pay, payRef, type LedgerEntry, type SpendReason, type Wallet } from "./economy.ts";

export type SolutionTier = 1 | 2 | 3 | 4 | 5;

/** Base price by incident tier, before seniority. A tier-1 guided incident is the cheapest lesson. */
export const SOLUTION_BASE_CENTS: Readonly<Record<SolutionTier, number>> = { 1: 5_000, 2: 15_000, 3: 40_000, 4: 90_000, 5: 180_000 };

/** Seniors are expected to know: each level adds half the base again (Staff pays 3×). */
export function solutionPriceCents(tier: SolutionTier, level: Level): number {
  return (SOLUTION_BASE_CENTS[tier] * (2 + level)) / 2;
}

export type SolutionPurchase = {
  readonly kind: "solution";
  readonly scenarioId: string;
  readonly runStartedAt: number;
  readonly tier: SolutionTier;
  readonly level: Level;
  readonly title: string;
};

/** One purchase per incident run; reloading or retrying never charges twice. */
export function purchaseRef(purchase: Pick<SolutionPurchase, "scenarioId" | "runStartedAt">): string {
  return `solution:${purchase.scenarioId}:${purchase.runStartedAt}`;
}

/** The scenario a purchase line was for, or null if the ref isn't a solution purchase. */
export function scenarioOfPurchase(ref: string): string | null {
  const match = /^solution:(.+):\d+$/.exec(ref);
  return match ? match[1] : null;
}

export type SpendOutcome = { readonly ok: true; readonly wallet: Wallet } | { readonly ok: false; readonly shortByCents: number };

/** Charges for a purchase once. Already bought under this ref: the wallet comes back unchanged. */
export function spend(wallet: Wallet, purchase: SolutionPurchase, at: number): SpendOutcome {
  const price = solutionPriceCents(purchase.tier, purchase.level);
  return charge(wallet, { reason: purchase.kind, ref: purchaseRef(purchase), cents: price, note: `Solution bought · ${purchase.title}` }, at);
}

/**
 * Puts your money into a company: the server issued `fundingRef` and the exact amount, and credits
 * the company when this spend reaches it in a save. Spending again under the same ref changes nothing.
 */
export function fundCompany(wallet: Wallet, fundingRef: string, cents: number, at: number): SpendOutcome {
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, shortByCents: 0 };
  return charge(wallet, { reason: "company", ref: fundingRef, cents, note: "Invested in your company" }, at);
}

/** Pay a company booked for you, earned into the wallet once under `payroll:<id>`. */
export function earnPayroll(wallet: Wallet, payout: { readonly id: string; readonly amountCents: number; readonly workDay: number }, at: number): Wallet {
  return pay(wallet, { kind: "payroll", ref: payRef.payroll(payout.id), amountCents: payout.amountCents, workDay: payout.workDay }, at);
}

/** Money an admin granted, earned into the wallet once under `grant:<id>`. */
export function earnGrant(wallet: Wallet, grant: { readonly id: string; readonly amountCents: number; readonly note: string }, at: number): Wallet {
  return pay(wallet, { kind: "grant", ref: payRef.grant(grant.id), amountCents: grant.amountCents, note: grant.note }, at);
}

type Charge = { readonly reason: SpendReason; readonly ref: string; readonly cents: number; readonly note: string };

function charge(wallet: Wallet, { reason, ref, cents, note }: Charge, at: number): SpendOutcome {
  if (wallet.ledger.some((entry) => entry.ref === ref)) return { ok: true, wallet };
  if (cents > wallet.balanceCents) return { ok: false, shortByCents: cents - wallet.balanceCents };
  const entry: LedgerEntry = { seq: wallet.nextSeq, at, reason, ref, amountCents: -cents, units: 1, note: note.slice(0, 120) };
  return {
    ok: true,
    wallet: {
      ...wallet,
      balanceCents: wallet.balanceCents - cents,
      spentCents: { ...wallet.spentCents, [reason]: wallet.spentCents[reason] + cents },
      boughtUnits: { ...wallet.boughtUnits, [reason]: wallet.boughtUnits[reason] + 1 },
      nextSeq: wallet.nextSeq + 1,
      ledger: [...wallet.ledger, entry].slice(-LEDGER_LIMIT),
    },
  };
}

/** Whether a run already has its solution bought. */
export function hasBoughtSolution(wallet: Wallet, purchase: Pick<SolutionPurchase, "scenarioId" | "runStartedAt">): boolean {
  const ref = purchaseRef(purchase);
  return wallet.ledger.some((entry) => entry.ref === ref);
}
