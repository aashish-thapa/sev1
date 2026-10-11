import { describe, expect, it } from "vitest";
import {
  applyInvestment,
  checkInvestmentOffer,
  foundingCapTable,
  impliedValuationCents,
  isDividendDay,
  trackers,
  weeklyDividends,
  WHOLE_BPS,
  type BookLine,
} from "./investors.ts";

const sum = (table: ReturnType<typeof foundingCapTable>) => table.founderBps + table.holders.reduce((total, holder) => total + holder.bps, 0);

describe("investment offers", () => {
  const table = foundingCapTable("aashish");

  it("refuses offers that break the rules", () => {
    expect(checkInvestmentOffer(table, { investor: "aashish", amountCents: 100_000, equityBps: 1000 }, [])).toBe("self_offer");
    expect(checkInvestmentOffer(table, { investor: "maya", amountCents: 10_000, equityBps: 1000 }, [])).toBe("below_minimum_investment");
    expect(checkInvestmentOffer(table, { investor: "maya", amountCents: 100_000, equityBps: 5000 }, [])).toBe("too_much_equity");
    expect(checkInvestmentOffer(table, { investor: "maya", amountCents: 100_000, equityBps: 1000 }, [])).toBeNull();
  });

  it("keeps the founder in control even if every open offer is taken", () => {
    expect(checkInvestmentOffer(table, { investor: "maya", amountCents: 100_000, equityBps: 4000 }, [])).toBeNull();
    // 100% → 60% after the first, → 36% after a second 40%.
    expect(checkInvestmentOffer(table, { investor: "tom", amountCents: 100_000, equityBps: 4000 }, [{ equityBps: 4000 }])).toBe("founder_control");
  });

  it("dilutes everyone in proportion and always sums to the whole company", () => {
    const first = applyInvestment(table, { investor: "maya", amountCents: 200_000, equityBps: 2000 });
    expect(first).toMatchObject({ founderBps: 8000, holders: [{ username: "maya", bps: 2000, investedCents: 200_000 }] });
    const second = applyInvestment(first, { investor: "tom", amountCents: 100_000, equityBps: 1000 });
    expect(second.holders.find((holder) => holder.username === "maya")?.bps).toBe(1800);
    expect(second.founderBps).toBe(7200);
    expect(sum(second)).toBe(WHOLE_BPS);
    const again = applyInvestment(second, { investor: "maya", amountCents: 50_000, equityBps: 333 });
    expect(again.holders.filter((holder) => holder.username === "maya")).toHaveLength(1);
    expect(sum(again)).toBe(WHOLE_BPS);
  });

  it("prices the whole company from an offer", () => {
    expect(impliedValuationCents(200_000, 2000)).toBe(1_000_000);
  });
});

describe("dividends", () => {
  const table = applyInvestment(foundingCapTable("aashish"), { investor: "maya", amountCents: 200_000, equityBps: 2500 });
  const week: BookLine[] = [
    { workDay: 1, reason: "seed", amountCents: 200_000 },
    { workDay: 1, reason: "room-purchase", amountCents: -80_000 },
    ...Array.from({ length: 7 }, (_, index) => [
      { workDay: index + 1, reason: "revenue", amountCents: 50_000 },
      { workDay: index + 1, reason: "payroll", amountCents: -20_000 },
      { workDay: index + 1, reason: "room-upkeep", amountCents: -2_000 },
    ]).flat(),
  ];

  it("pays only on every 7th work day", () => {
    expect([0, 1, 6, 7, 8, 14].map(isDividendDay)).toEqual([false, false, false, true, false, true]);
  });

  it("shares the week's operating profit with investors, not counting seed or purchases", () => {
    const paid = weeklyDividends(week, table, 7);
    expect(paid.profitCents).toBe(7 * 28_000);
    expect(paid.payouts).toEqual([{ username: "maya", amountCents: Math.floor((7 * 28_000 * 2500) / WHOLE_BPS) }]);
  });

  it("pays nothing in a losing week", () => {
    const losing = week.map((line) => (line.reason === "revenue" ? { ...line, amountCents: 1_000 } : line));
    expect(weeklyDividends(losing, table, 7)).toMatchObject({ payouts: [] });
  });
});

describe("trackers", () => {
  it("adds up money in, inventory and running costs by window", () => {
    const table = applyInvestment(foundingCapTable("aashish"), { investor: "maya", amountCents: 200_000, equityBps: 2000 });
    const lines: BookLine[] = [
      { workDay: 1, reason: "revenue", amountCents: 40_000 },
      { workDay: 20, reason: "revenue", amountCents: 50_000 },
      { workDay: 20, reason: "payroll", amountCents: -12_000 },
      { workDay: 20, reason: "pantry", amountCents: -500 },
      { workDay: 20, reason: "server-purchase", amountCents: -30_000 },
    ];
    const tracked = trackers(lines, table, [{ item: "bay", costCents: 80_000 }, { item: "small", costCents: 30_000 }, { item: "small", costCents: 30_000 }], 20);
    expect(tracked.investedCents).toBe(200_000);
    expect(tracked.inventory).toContainEqual({ item: "small", count: 2, costCents: 60_000 });
    expect(tracked.inventoryCents).toBe(140_000);
    expect(tracked.last7).toEqual({ earningsCents: 50_000, expensesCents: 12_500, expensesByReason: { payroll: 12_000, pantry: 500 } });
    expect(tracked.last30.earningsCents).toBe(90_000);
  });
});
