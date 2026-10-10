import { describe, expect, it } from "vitest";
import { isPlausibleProgress } from "./audit.ts";
import { INCIDENT_CENTS_PER_POINT_BY_TIER, payRef } from "./economy.ts";
import { earn, emptyProgress, type Progress } from "./progress.ts";
import { earnGrant, hasBoughtSolution, purchaseRef, solutionPriceCents, spend, type SolutionPurchase } from "./purchases.ts";

const AT = Date.UTC(2026, 9, 10, 12);
const tierOf = (id: string) => (id === "scaled-to-zero" ? 1 : id === "checkout-meltdown" ? 5 : undefined);
const purchase: SolutionPurchase = { kind: "solution", scenarioId: "scaled-to-zero", runStartedAt: AT, tier: 1, level: 0, title: "Scaled to zero" };

/** A player who has earned `incidents` perfect incident bonuses. */
function richPlayer(incidents: number): Progress {
  let progress = emptyProgress();
  for (let index = 0; index < incidents; index += 1) {
    progress = earn(progress, { kind: "incident", ref: payRef.incident(`run-${index}`, AT + index), points: 100, tier: 1, title: "x", isTeam: false }, AT);
  }
  return progress;
}

function buy(progress: Progress, what: SolutionPurchase = purchase): Progress {
  const outcome = spend(progress.wallet, what, AT);
  if (!outcome.ok) throw new Error("expected the purchase to go through");
  return { ...progress, wallet: outcome.wallet };
}

describe("solution prices", () => {
  it("climb with incident tier and with seniority", () => {
    expect(solutionPriceCents(1, 0)).toBeLessThan(solutionPriceCents(2, 0));
    expect(solutionPriceCents(5, 0)).toBeLessThan(solutionPriceCents(5, 4));
    expect(solutionPriceCents(5, 4)).toBe(3 * solutionPriceCents(5, 0));
  });

  it("cost Staff more than a perfect run pays on the two hardest tiers", () => {
    for (const tier of [4, 5] as const) expect(solutionPriceCents(tier, 4)).toBeGreaterThan(100 * INCIDENT_CENTS_PER_POINT_BY_TIER[tier]);
  });
});

describe("spend", () => {
  it("charges once per run and records the purchase", () => {
    const before = richPlayer(1);
    const after = buy(before);
    expect(after.wallet.balanceCents).toBe(before.wallet.balanceCents - solutionPriceCents(1, 0));
    expect(hasBoughtSolution(after.wallet, purchase)).toBe(true);
    expect(buy(after).wallet).toBe(after.wallet);
  });

  it("refuses when the wallet can't cover it, saying how short it is", () => {
    const outcome = spend(emptyProgress().wallet, purchase, AT);
    expect(outcome).toEqual({ ok: false, shortByCents: solutionPriceCents(1, 0) });
  });
});

describe("server audit of purchases", () => {
  it("accepts an honestly priced purchase", () => {
    const before = richPlayer(1);
    expect(isPlausibleProgress(before, buy(before), 60, tierOf)).toBe(true);
  });

  it("refuses a purchase charged below its tier's price", () => {
    const before = richPlayer(3);
    const cheap = buy(before, { ...purchase, scenarioId: "checkout-meltdown", tier: 1 });
    expect(isPlausibleProgress(before, cheap, 60, tierOf)).toBe(false);
  });

  it("refuses purchases it can't price, and forged balances that skip the charge", () => {
    const before = richPlayer(1);
    const bought = buy(before);
    expect(isPlausibleProgress(before, bought, 60)).toBe(false);
    const unpaid = { ...bought, wallet: { ...bought.wallet, balanceCents: before.wallet.balanceCents } };
    expect(isPlausibleProgress(before, unpaid, 60, tierOf)).toBe(false);
    expect(purchaseRef(purchase)).toBe(`solution:scaled-to-zero:${AT}`);
  });
});

describe("company money in the wallet", () => {
  it("spends a company seed once under its funding ref, and refuses when short", async () => {
    const { fundCompany } = await import("./purchases.ts");
    const before = richPlayer(1);
    const funded = fundCompany(before.wallet, "company:fund:c1:n1", 10_000, AT);
    if (!funded.ok) throw new Error("expected the seed to be spent");
    expect(funded.wallet.balanceCents).toBe(before.wallet.balanceCents - 10_000);
    expect(funded.wallet.spentCents.company).toBe(10_000);
    expect(fundCompany(funded.wallet, "company:fund:c1:n1", 10_000, AT)).toEqual({ ok: true, wallet: funded.wallet });
    expect(fundCompany(before.wallet, "company:fund:c2:n2", before.wallet.balanceCents + 1, AT)).toEqual({ ok: false, shortByCents: 1 });
  });

  it("earns a payout once, however many times it's claimed", async () => {
    const { earnPayroll } = await import("./purchases.ts");
    const payout = { id: "c1:1:u1", amountCents: 12_000, workDay: 1 };
    const once = earnPayroll(richPlayer(0).wallet, payout, AT);
    expect(once.earnedCents.payroll).toBe(12_000);
    expect(earnPayroll(once, payout, AT)).toBe(once);
  });
});

describe("earnGrant", () => {
  it("credits a grant once, booked under its own reason with its note", () => {
    const once = earnGrant(emptyProgress().wallet, { id: "g1", amountCents: 50_000, note: "for testing" }, AT);
    expect(once.balanceCents).toBe(50_000);
    expect(once.earnedCents.grant).toBe(50_000);
    expect(once.ledger.at(-1)).toMatchObject({ reason: "grant", ref: "grant:g1", note: "Grant · for testing" });
    expect(earnGrant(once, { id: "g1", amountCents: 50_000, note: "for testing" }, AT)).toBe(once);
  });
});
