/**
 * What earned money buys. Today: the step-by-step solution to a live incident — priced so it
 * always costs more than the incident pays, and dearer the harder the incident and the more
 * senior you are. A bought solution makes the run assisted: no bonus, no experience.
 */
import type { Level } from "./career.ts";
import { LEDGER_LIMIT, type LedgerEntry, type Wallet } from "./economy.ts";

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
  const ref = purchaseRef(purchase);
  if (wallet.ledger.some((entry) => entry.ref === ref)) return { ok: true, wallet };
  const price = solutionPriceCents(purchase.tier, purchase.level);
  if (price > wallet.balanceCents) return { ok: false, shortByCents: price - wallet.balanceCents };
  const entry: LedgerEntry = {
    seq: wallet.nextSeq,
    at,
    reason: purchase.kind,
    ref,
    amountCents: -price,
    units: 1,
    note: `Solution bought · ${purchase.title}`.slice(0, 120),
  };
  return {
    ok: true,
    wallet: {
      ...wallet,
      balanceCents: wallet.balanceCents - price,
      spentCents: { ...wallet.spentCents, solution: wallet.spentCents.solution + price },
      boughtUnits: { ...wallet.boughtUnits, solution: wallet.boughtUnits.solution + 1 },
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
