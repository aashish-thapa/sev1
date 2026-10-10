/**
 * What a company is worth, and how that has moved: what it owns (cash, plus rooms and servers at
 * cost) plus ten weeks of its recent operating profit. A company losing money is worth what it
 * owns. Read from the books alone, so it can be traced back day by day. Pure.
 */
import type { BookLine } from "./investors.ts";

/** How many weeks of recent profit a buyer would pay for. */
export const WEEKS_OF_PROFIT = 10;
/** Points kept for the trend line. */
export const HISTORY_DAYS = 30;

const OPERATING: ReadonlySet<string> = new Set(["revenue", "room-upkeep", "server-upkeep", "contractor", "pantry", "payroll"]);
const PURCHASES: ReadonlySet<string> = new Set(["room-purchase", "server-purchase"]);

export type ValuationPoint = { readonly workDay: number; readonly valuationCents: number };

/** The company's worth at the close of `workDay`, from every line booked up to it. */
export function valuationOn(lines: readonly BookLine[], workDay: number): number {
  let fundsCents = 0;
  let ownedCents = 0;
  let profitCents = 0;
  for (const line of lines) {
    if (line.workDay > workDay) continue;
    fundsCents += line.amountCents;
    if (PURCHASES.has(line.reason)) ownedCents -= line.amountCents;
    if (OPERATING.has(line.reason) && line.workDay > workDay - 7) profitCents += line.amountCents;
  }
  return Math.max(0, fundsCents + ownedCents + WEEKS_OF_PROFIT * Math.max(0, profitCents));
}

/** The worth at each of the last `HISTORY_DAYS` work days up to `currentWorkDay`, oldest first. */
export function valuationHistory(lines: readonly BookLine[], currentWorkDay: number): ValuationPoint[] {
  const first = Math.max(0, currentWorkDay - HISTORY_DAYS + 1);
  return Array.from({ length: currentWorkDay - first + 1 }, (_, index) => {
    const workDay = first + index;
    return { workDay, valuationCents: valuationOn(lines, workDay) };
  });
}

/** Change over the last 7 work days in basis points (1250 = +12.5%), or null with no week behind it yet. */
export function weekChangeBps(history: readonly ValuationPoint[]): number | null {
  const last = history.at(-1);
  const weekAgo = last ? history.find((point) => point.workDay === last.workDay - 7) : undefined;
  if (!last || !weekAgo || weekAgo.valuationCents === 0) return null;
  return Math.round(((last.valuationCents - weekAgo.valuationCents) / weekAgo.valuationCents) * 10_000);
}
