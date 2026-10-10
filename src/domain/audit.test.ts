import { describe, expect, it } from "vitest";
import { isPlausibleProgress, type TierOf } from "./audit.ts";
import { INCIDENT_CENTS_PER_POINT_BY_TIER, payRef } from "./economy.ts";
import { earn, emptyProgress, type Progress } from "./progress.ts";
import type { Tier } from "./tier.ts";

const AT = Date.UTC(2026, 9, 10, 12);
const tierOf: TierOf = (scenarioId) => (scenarioId === "scaled-to-zero" ? 1 : scenarioId === "checkout-meltdown" ? 5 : undefined);

/** A perfect run of `scenarioId` paid at `tier`: honest only when that is the scenario's own tier. */
function perfectRun(progress: Progress, scenarioId: string, tier: Tier, startedAt = AT): Progress {
  return earn(progress, { kind: "incident", ref: payRef.incident(scenarioId, startedAt), points: 100, tier, title: scenarioId, isTeam: false }, startedAt);
}

/** Books `cents` to incident earnings while the ledger line that pays for them says salary. */
function bookedAsSalary(progress: Progress, cents: number): Progress {
  const { wallet } = progress;
  return {
    ...progress,
    wallet: {
      ...wallet,
      balanceCents: wallet.balanceCents + cents,
      earnedCents: { ...wallet.earnedCents, incident: wallet.earnedCents.incident + cents },
      nextSeq: wallet.nextSeq + 1,
      ledger: [...wallet.ledger, { seq: wallet.nextSeq, at: AT, reason: "salary", ref: payRef.salary(AT), amountCents: cents, units: 1, note: "Salary" }],
    },
  };
}

describe("incident payouts on sync", () => {
  it("accept a perfect tier-5 run paid at the tier-5 cap", () => {
    const paid = perfectRun(emptyProgress(), "checkout-meltdown", 5);
    expect(paid.wallet.balanceCents).toBe(100 * INCIDENT_CENTS_PER_POINT_BY_TIER[5]);
    expect(isPlausibleProgress(emptyProgress(), paid, 600, tierOf)).toBe(true);
  });

  it("refuse the tier-5 amount for a tier-1 scenario", () => {
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "scaled-to-zero", 1), 600, tierOf)).toBe(true);
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "scaled-to-zero", 5), 600, tierOf)).toBe(false);
  });

  it("refuse a payout for a scenario the catalogue doesn't know, or with no catalogue", () => {
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "retired-incident", 1), 600, tierOf)).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "scaled-to-zero", 1), 600)).toBe(false);
  });

  it("still refuse more incidents than could be closed in the time", () => {
    const runs = Array.from({ length: 10 }, (_, index) => AT + index).reduce((progress, startedAt) => perfectRun(progress, "scaled-to-zero", 1, startedAt), emptyProgress());
    expect(isPlausibleProgress(emptyProgress(), runs, 60, tierOf)).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), runs, 900, tierOf)).toBe(true);
  });

  it("refuse incident earnings that a line of another reason pays for", () => {
    expect(isPlausibleProgress(emptyProgress(), bookedAsSalary(emptyProgress(), 10_000_000), 600, tierOf)).toBe(false);
    const topUp = 100 * (INCIDENT_CENTS_PER_POINT_BY_TIER[5] - INCIDENT_CENTS_PER_POINT_BY_TIER[1]);
    expect(isPlausibleProgress(emptyProgress(), bookedAsSalary(perfectRun(emptyProgress(), "scaled-to-zero", 1), topUp), 600, tierOf)).toBe(false);
  });
});
