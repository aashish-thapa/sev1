import { describe, expect, it } from "vitest";
import type { BookLine } from "./investors.ts";
import { valuationHistory, valuationOn, weekChangeBps, WEEKS_OF_PROFIT } from "./valuation.ts";

const founding: BookLine[] = [
  { workDay: 0, reason: "seed", amountCents: 200_000 },
  { workDay: 0, reason: "room-purchase", amountCents: -80_000 },
];
const day = (workDay: number, revenue: number): BookLine[] => [
  { workDay, reason: "revenue", amountCents: revenue },
  { workDay, reason: "payroll", amountCents: -20_000 },
];

describe("valuation", () => {
  it("is what the company owns before it has earned anything", () => {
    // Cash left plus the bay at cost: the seed, whole.
    expect(valuationOn(founding, 0)).toBe(200_000);
  });

  it("adds ten weeks of the last week's profit", () => {
    const lines = [...founding, ...day(1, 50_000)];
    expect(valuationOn(lines, 1)).toBe(200_000 + 30_000 + WEEKS_OF_PROFIT * 30_000);
  });

  it("never pays for losses: a losing company is worth what it owns", () => {
    const lines = [...founding, ...day(1, 5_000)];
    expect(valuationOn(lines, 1)).toBe(200_000 - 15_000);
  });

  it("traces the worth back day by day and reports the week's change", () => {
    const lines = [...founding, ...Array.from({ length: 14 }, (_, index) => day(index + 1, 30_000 + index * 2_000)).flat()];
    const history = valuationHistory(lines, 14);
    expect(history).toHaveLength(15);
    expect(history.map((point) => point.workDay)).toEqual(Array.from({ length: 15 }, (_, index) => index));
    expect(history.at(-1)!.valuationCents).toBeGreaterThan(history[7].valuationCents);
    expect(weekChangeBps(history)).toBeGreaterThan(0);
    expect(weekChangeBps(history.slice(0, 3))).toBeNull();
  });
});
