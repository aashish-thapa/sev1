import { describe, expect, it } from "vitest";
import { isPlausibleProgress, type TierOf } from "./audit.ts";
import { careerLevel } from "./career.ts";
import { INCIDENT_CENTS_PER_POINT_BY_TIER, LEDGER_LIMIT, paidTier, payRef } from "./economy.ts";
import { earn, emptyProgress, recordWarRoomRun, type Progress } from "./progress.ts";
import type { Tier } from "./tier.ts";

const AT = Date.UTC(2026, 9, 10, 12);
const TIERS: Readonly<Record<string, Tier>> = { "scaled-to-zero": 1, "orders-index-invalid": 4, "checkout-meltdown": 5 };
const tierOf: TierOf = (scenarioId) => TIERS[scenarioId];
/** 140 correct cards is 1,400 experience: Staff Engineer. */
const STAFF: Progress = { ...emptyProgress(), correctCards: 140 };

/** A perfect run of `scenarioId` paid at `tier`: honest only when that is the scenario's own tier. */
function perfectRun(progress: Progress, scenarioId: string, tier: Tier, startedAt = AT): Progress {
  return earn(progress, { kind: "incident", ref: payRef.incident(scenarioId, startedAt), points: 100, tier, title: scenarioId, isTeam: false }, startedAt);
}

function perfectRuns(progress: Progress, count: number, scenarioId: string, tier: Tier): Progress {
  return Array.from({ length: count }, (_, index) => AT + index).reduce((current, startedAt) => perfectRun(current, scenarioId, tier, startedAt), progress);
}

/** An Intern's salary for `minutes` separate minutes after the incidents, one ledger line each. */
function salaryMinutes(progress: Progress, minutes: number): Progress {
  return Array.from({ length: minutes }, (_, index) => AT + (index + 1) * 60_000).reduce(
    (current, at) => earn(current, { kind: "salary", ref: payRef.salary(at), minutes: 1, level: 0 }, at),
    progress,
  );
}

/** Claims every incident line in the save as one paid incident. */
function asOnePaidIncident(progress: Progress): Progress {
  return { ...progress, wallet: { ...progress.wallet, paidUnits: { ...progress.wallet.paidUnits, incident: 1 } } };
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
  it("accept a Staff save's perfect tier-5 run paid at the tier-5 cap", () => {
    const paid = perfectRun(STAFF, "checkout-meltdown", 5);
    expect(paid.wallet.balanceCents).toBe(100 * INCIDENT_CENTS_PER_POINT_BY_TIER[5]);
    expect(isPlausibleProgress(STAFF, paid, 600, tierOf)).toBe(true);
  });

  it("refuse the tier-5 amount for a tier-1 scenario", () => {
    expect(isPlausibleProgress(STAFF, perfectRun(STAFF, "scaled-to-zero", 1), 600, tierOf)).toBe(true);
    expect(isPlausibleProgress(STAFF, perfectRun(STAFF, "scaled-to-zero", 5), 600, tierOf)).toBe(false);
  });

  it("refuse the tier-5 amount from an Intern save, who is paid at the tier their level unlocks", () => {
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "checkout-meltdown", 1), 600, tierOf)).toBe(true);
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "checkout-meltdown", 5), 600, tierOf)).toBe(false);
  });

  it("refuse a payout for a scenario the catalogue doesn't know, or with no catalogue", () => {
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "retired-incident", 1), 600, tierOf)).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), perfectRun(emptyProgress(), "scaled-to-zero", 1), 600)).toBe(false);
  });

  it("still refuse more incidents than could be closed in the time", () => {
    const runs = perfectRuns(emptyProgress(), 10, "scaled-to-zero", 1);
    expect(isPlausibleProgress(emptyProgress(), runs, 60, tierOf)).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), runs, 900, tierOf)).toBe(true);
  });

  it("refuse incident earnings that a line of another reason pays for", () => {
    expect(isPlausibleProgress(emptyProgress(), bookedAsSalary(emptyProgress(), 10_000_000), 600, tierOf)).toBe(false);
    const topUp = 100 * (INCIDENT_CENTS_PER_POINT_BY_TIER[5] - INCIDENT_CENTS_PER_POINT_BY_TIER[1]);
    expect(isPlausibleProgress(emptyProgress(), bookedAsSalary(perfectRun(emptyProgress(), "scaled-to-zero", 1), topUp), 600, tierOf)).toBe(false);
  });

  it("refuse several incident lines booked as one paid incident", () => {
    expect(isPlausibleProgress(emptyProgress(), asOnePaidIncident(perfectRuns(emptyProgress(), 6, "scaled-to-zero", 1)), 900, tierOf)).toBe(false);
    // Six tier-1 lines fit inside one tier-5 run's worth for Staff, but they are still six runs.
    expect(isPlausibleProgress(STAFF, asOnePaidIncident(perfectRuns(STAFF, 6, "scaled-to-zero", 1)), 900, tierOf)).toBe(false);
  });

  it("cap incident earnings at the player's level even when the ledger cap evicted their lines", () => {
    const padded = salaryMinutes(emptyProgress(), LEDGER_LIMIT + 1);
    const { wallet } = padded;
    const cents = 100 * INCIDENT_CENTS_PER_POINT_BY_TIER[5];
    const forged: Progress = {
      ...padded,
      wallet: {
        ...wallet,
        balanceCents: wallet.balanceCents + cents,
        earnedCents: { ...wallet.earnedCents, incident: wallet.earnedCents.incident + cents },
        paidUnits: { ...wallet.paidUnits, incident: wallet.paidUnits.incident + 1 },
        nextSeq: wallet.nextSeq + 1,
      },
    };
    expect(isPlausibleProgress(emptyProgress(), forged, (LEDGER_LIMIT + 2) * 60, tierOf)).toBe(false);
  });

  it("accept an honest sync whose incident lines the ledger cap evicted", () => {
    const honest = salaryMinutes(perfectRuns(emptyProgress(), 3, "scaled-to-zero", 1), LEDGER_LIMIT);
    expect(honest.wallet.ledger.some((entry) => entry.reason === "incident")).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), honest, (LEDGER_LIMIT + 2) * 60, tierOf)).toBe(true);
  });

  it("accept a run paid at the level it started from when it promotes the player", () => {
    // 61 correct cards is 610 experience, an Engineer; a perfect tier-4 War Room adds 100 and makes Senior.
    const engineer: Progress = { ...emptyProgress(), correctCards: 61 };
    const promoted = perfectRun(recordWarRoomRun(engineer, "orders-index-invalid", 100, "S"), "orders-index-invalid", paidTier(4, 2));
    expect(careerLevel(promoted).level).toBe(3);
    expect(isPlausibleProgress(engineer, promoted, 600, tierOf)).toBe(true);
  });

  it("refuse spending booked without its solution line", () => {
    const paid = perfectRun(emptyProgress(), "scaled-to-zero", 1);
    const { wallet } = paid;
    const cents = 5_000;
    const forged: Progress = {
      ...paid,
      wallet: {
        ...wallet,
        balanceCents: wallet.balanceCents - cents,
        spentCents: { solution: wallet.spentCents.solution + cents },
        boughtUnits: { solution: wallet.boughtUnits.solution + 1 },
        nextSeq: wallet.nextSeq + 1,
        ledger: [...wallet.ledger, { seq: wallet.nextSeq, at: AT, reason: "card", ref: payRef.card("x", AT), amountCents: -cents, units: 1, note: "Correct call" }],
      },
    };
    expect(isPlausibleProgress(paid, forged, 600, tierOf)).toBe(false);
  });
});
