/**
 * Investors: other players put money into a company for a share of it, and share its profit each
 * week. Shares are basis points (10,000 = the whole company); new money dilutes everyone in
 * proportion, and the founder always keeps control. Pure: the server books the money.
 */

export const WHOLE_BPS = 10_000;
/** The founder keeps at least 51% after every offer, even if all the open ones are accepted. */
export const FOUNDER_MIN_BPS = 5_100;
/** No single offer buys more than 49%. */
export const MAX_OFFER_BPS = 4_900;
/** The smallest stake worth booking: $500. */
export const MIN_INVESTMENT_CENTS = 50_000;
/** Dividends are paid when every 7th work day closes. */
export const DIVIDEND_EVERY_WORK_DAYS = 7;

export type Holder = { readonly username: string; readonly bps: number; readonly investedCents: number };
export type CapTable = { readonly founder: string; readonly founderBps: number; readonly holders: readonly Holder[] };

export const foundingCapTable = (founder: string): CapTable => ({ founder, founderBps: WHOLE_BPS, holders: [] });

export type OfferTerms = { readonly investor: string; readonly amountCents: number; readonly equityBps: number };
export type OfferProblem = "self_offer" | "below_minimum_investment" | "too_much_equity" | "founder_control";

/** The founder's share after a run of offers is accepted, each diluting everyone before it. */
export function founderAfter(founderBps: number, offers: readonly { readonly equityBps: number }[]): number {
  return offers.reduce((bps, offer) => (bps * (WHOLE_BPS - offer.equityBps)) / WHOLE_BPS, founderBps);
}

/** Why the founder can't make this offer, or null. `open` is the offers already out, counted as if all are taken. */
export function checkInvestmentOffer(table: CapTable, terms: OfferTerms, open: readonly { readonly equityBps: number }[]): OfferProblem | null {
  if (terms.investor === table.founder) return "self_offer";
  if (!Number.isInteger(terms.amountCents) || terms.amountCents < MIN_INVESTMENT_CENTS) return "below_minimum_investment";
  if (!Number.isInteger(terms.equityBps) || terms.equityBps < 1 || terms.equityBps > MAX_OFFER_BPS) return "too_much_equity";
  if (founderAfter(table.founderBps, [...open, terms]) < FOUNDER_MIN_BPS) return "founder_control";
  return null;
}

/** What the whole company is worth at this price, after the money goes in. */
export function impliedValuationCents(amountCents: number, equityBps: number): number {
  return equityBps <= 0 ? 0 : Math.round((amountCents * WHOLE_BPS) / equityBps);
}

/**
 * The cap table once an offer is accepted: everyone is diluted in proportion and the investor
 * holds `equityBps` (added to any stake they had). Rounding goes to the founder so it sums to 10,000.
 */
export function applyInvestment(table: CapTable, terms: OfferTerms): CapTable {
  const keep = (bps: number) => Math.floor((bps * (WHOLE_BPS - terms.equityBps)) / WHOLE_BPS);
  const diluted = table.holders.map((holder) => ({ ...holder, bps: keep(holder.bps) }));
  const existing = diluted.find((holder) => holder.username === terms.investor);
  const holders = existing
    ? diluted.map((holder) => (holder === existing ? { ...holder, bps: holder.bps + terms.equityBps, investedCents: holder.investedCents + terms.amountCents } : holder))
    : [...diluted, { username: terms.investor, bps: terms.equityBps, investedCents: terms.amountCents }];
  const founderBps = WHOLE_BPS - holders.reduce((sum, holder) => sum + holder.bps, 0);
  return { founder: table.founder, founderBps, holders };
}

export const isDividendDay = (workDay: number): boolean => workDay > 0 && workDay % DIVIDEND_EVERY_WORK_DAYS === 0;

/** A booked line, as the dividend and tracker sums read it. */
export type BookLine = { readonly workDay: number; readonly reason: string; readonly amountCents: number };

/** What running the company earns and costs; buying rooms and servers is investment in it, not running cost. */
const OPERATING_REASONS: ReadonlySet<string> = new Set(["revenue", "room-upkeep", "server-upkeep", "contractor", "pantry", "payroll"]);

export type Dividends = {
  /** Revenue less running costs over the week; nothing is paid unless it's positive. */
  readonly profitCents: number;
  readonly payouts: readonly { readonly username: string; readonly amountCents: number }[];
};

/**
 * The week's dividends, when work day `workDay` closes a week: each investor gets their share of
 * the profit. The founder's share stays in the company (the founder is paid a salary).
 */
export function weeklyDividends(lines: readonly BookLine[], table: CapTable, workDay: number): Dividends {
  const from = workDay - DIVIDEND_EVERY_WORK_DAYS;
  const profitCents = lines.filter((line) => line.workDay > from && line.workDay <= workDay && OPERATING_REASONS.has(line.reason)).reduce((sum, line) => sum + line.amountCents, 0);
  if (profitCents <= 0) return { profitCents, payouts: [] };
  const payouts = table.holders.map((holder) => ({ username: holder.username, amountCents: Math.floor((profitCents * holder.bps) / WHOLE_BPS) })).filter((payout) => payout.amountCents > 0);
  return { profitCents, payouts };
}

export type Window = { readonly earningsCents: number; readonly expensesCents: number; readonly expensesByReason: Readonly<Record<string, number>> };

export type Trackers = {
  /** Money investors have put in, in total. */
  readonly investedCents: number;
  /** Rooms and servers owned, at what they cost. */
  readonly inventory: readonly { readonly item: string; readonly count: number; readonly costCents: number }[];
  readonly inventoryCents: number;
  readonly last7: Window;
  readonly last30: Window;
};

function windowOf(lines: readonly BookLine[], currentWorkDay: number, days: number): Window {
  const recent = lines.filter((line) => line.workDay > currentWorkDay - days && line.workDay <= currentWorkDay);
  const expensesByReason: Record<string, number> = {};
  let earningsCents = 0;
  let expensesCents = 0;
  for (const line of recent) {
    if (line.reason === "revenue") earningsCents += line.amountCents;
    else if (OPERATING_REASONS.has(line.reason) && line.amountCents < 0) {
      expensesCents += -line.amountCents;
      expensesByReason[line.reason] = (expensesByReason[line.reason] ?? 0) - line.amountCents;
    }
  }
  return { earningsCents, expensesCents, expensesByReason };
}

/** Investment, inventory, earnings and running costs over the last 7 and 30 work days, from the books. */
export function trackers(
  lines: readonly BookLine[],
  table: CapTable,
  owned: readonly { readonly item: string; readonly costCents: number }[],
  currentWorkDay: number,
): Trackers {
  const counts = new Map<string, { count: number; costCents: number }>();
  for (const thing of owned) {
    const entry = counts.get(thing.item) ?? { count: 0, costCents: 0 };
    counts.set(thing.item, { count: entry.count + 1, costCents: entry.costCents + thing.costCents });
  }
  const inventory = [...counts].map(([item, entry]) => ({ item, ...entry }));
  return {
    investedCents: table.holders.reduce((sum, holder) => sum + holder.investedCents, 0),
    inventory,
    inventoryCents: inventory.reduce((sum, entry) => sum + entry.costCents, 0),
    last7: windowOf(lines, currentWorkDay, 7),
    last30: windowOf(lines, currentWorkDay, 30),
  };
}
