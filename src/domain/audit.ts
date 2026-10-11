/**
 * The server's gate for a synced save: could this progress honestly follow that one in the time
 * between them? Generous by design: it stops forged wallets and bought promotions, not honest
 * players on a laggy connection. Pure, so the Worker runs it with no content loaded except a tier lookup.
 */
import { careerLevel, type Level } from "./career.ts";
import {
  CARD_BONUS_CENTS,
  INCIDENT_CENTS_PER_POINT_BY_TIER,
  INCIDENT_MIN_POINTS,
  LEDGER_LIMIT,
  MIN_SECONDS_PER_CARD,
  MIN_SECONDS_PER_INCIDENT,
  paidTier,
  SALARY_CENTS_PER_MINUTE,
  SPEND_REASONS,
  scenarioOfIncident,
  type LedgerEntry,
  type PayReason,
  type Wallet,
} from "./economy.ts";
import type { Progress } from "./progress.ts";
import { scenarioOfPurchase, solutionPriceCents } from "./purchases.ts";
import type { Tier } from "./tier.ts";

/** Network and timer jitter between syncs: allow this much extra time and a couple of extra events. */
const TIME_SLACK = 1.25;
const EVENT_ALLOWANCE = 2;
const MAX_CARD_CENTS = Math.max(...Object.values(CARD_BONUS_CENTS));
const EARN_REASONS = ["salary", "card", "incident", "payroll", "grant", "dividend"] as const satisfies readonly PayReason[];
/** Earnings the server issues and the save only claims: each new line must be one the server promised. */
const SERVER_ISSUED = ["payroll", "grant", "dividend"] as const satisfies readonly PayReason[];
type ServerIssued = (typeof SERVER_ISSUED)[number];

/** Looks up the tier of a scenario by id; the Worker answers from the scenario registry. */
export type TierOf = (scenarioId: string) => Tier | undefined;

/** With no registry, no incident payout or purchase can be priced — every such line is rejected. */
const NO_TIERS: TierOf = () => undefined;

/**
 * Money the server has promised to move for this player, by wallet ref and exact amount: company
 * fundings it is waiting for, payroll it booked, and admin grants it issued — none yet claimed.
 * Loaded before the audit, so the audit itself stays pure.
 */
export type PromisedMoney = {
  readonly fundings: ReadonlyMap<string, number>;
  readonly payouts: ReadonlyMap<string, number>;
  readonly grants: ReadonlyMap<string, number>;
  /** Investments the server is waiting for (ref → the exact amount the investor agreed to put in). */
  readonly investments: ReadonlyMap<string, number>;
  /** Dividends companies booked for this investor and not yet claimed. */
  readonly dividends: ReadonlyMap<string, number>;
};

export const NO_PROMISED_MONEY: PromisedMoney = { fundings: new Map(), payouts: new Map(), grants: new Map(), investments: new Map(), dividends: new Map() };

/** Does the server stand behind this new ledger line (incident pay within its tier's cap, a purchase it can price, or pay it booked)? */
type Vouch = (entry: LedgerEntry) => boolean;

/** Why a wallet can't honestly follow the previous one, or null when it can. */
export function walletProblem(
  previous: Wallet,
  next: Wallet,
  elapsedSeconds: number,
  topLevel: Level = 4,
  isFairIncidentPay: Vouch = () => false,
  isAllowedSpend: Vouch = () => false,
  isBookedPay: Vouch = () => false,
): AuditProblem | null {
  if (!(elapsedSeconds >= 0)) return "elapsed";
  const seconds = elapsedSeconds * TIME_SLACK;
  const delta = (reason: PayReason, of: "earnedCents" | "paidUnits") => next[of][reason] - previous[of][reason];

  for (const reason of EARN_REASONS) {
    if (delta(reason, "earnedCents") < 0 || delta(reason, "paidUnits") < 0) return "earned_went_down";
  }
  for (const reason of SPEND_REASONS) {
    if (next.spentCents[reason] < previous.spentCents[reason] || next.boughtUnits[reason] < previous.boughtUnits[reason]) return "spent_went_down";
  }
  const earned = EARN_REASONS.reduce((sum, reason) => sum + next.earnedCents[reason], 0);
  const spent = SPEND_REASONS.reduce((sum, reason) => sum + next.spentCents[reason], 0);
  if (next.balanceCents !== earned - spent) return "balance_mismatch";
  if (next.nextSeq < previous.nextSeq) return "ledger_rewound";

  const minutes = delta("salary", "paidUnits");
  if (minutes > seconds / 60 + 1) return "salary_minutes";
  // A promotion can land mid-sync, so any rate from intern up to the level reached is honest.
  const salary = delta("salary", "earnedCents");
  if (salary < minutes * SALARY_CENTS_PER_MINUTE[0] || salary > minutes * SALARY_CENTS_PER_MINUTE[topLevel]) return "salary_rate";

  const cards = delta("card", "paidUnits");
  if (cards > seconds / MIN_SECONDS_PER_CARD + EVENT_ALLOWANCE) return "card_count";
  if (delta("card", "earnedCents") > cards * MAX_CARD_CENTS) return "card_amount";

  const incidents = delta("incident", "paidUnits");
  if (incidents > seconds / MIN_SECONDS_PER_INCIDENT + EVENT_ALLOWANCE) return "incident_count";
  // Backstop for lines the per-line check can't see (evicted, or booked under another reason): the most any run pays at the level reached.
  if (delta("incident", "earnedCents") > incidents * 100 * INCIDENT_CENTS_PER_POINT_BY_TIER[paidTier(5, topLevel)]) return "incident_amount";

  const fresh = freshLines(previous, next);
  if (fresh.some((entry) => entry.reason === "incident" && !isFairIncidentPay(entry))) return "incident_over_tier";
  const purchases = fresh.filter((entry) => (SPEND_REASONS as readonly string[]).includes(entry.reason));
  if (purchases.some((entry) => entry.amountCents >= 0 || !isAllowedSpend(entry))) return "unvouched_spend";
  // Payroll and grants come only from money the server issued, and each new cent of them must be one of those lines.
  for (const reason of SERVER_ISSUED) {
    const issued = fresh.filter((entry) => entry.reason === reason);
    if (issued.some((entry) => entry.amountCents <= 0 || !isBookedPay(entry))) return "unvouched_pay";
    if (delta(reason, "earnedCents") !== issued.reduce((sum, entry) => sum + entry.amountCents, 0)) return "pay_total";
  }
  // Money moved to a company (founding or investing) must be exactly the lines that moved it.
  for (const reason of ["company", "invest"] as const) {
    const moved = purchases.filter((entry) => entry.reason === reason).reduce((sum, entry) => sum - entry.amountCents, 0);
    if (next.spentCents[reason] - previous.spentCents[reason] !== moved) return "company_spend_total";
  }

  return isLedgerConsistent(previous, next) ? null : "ledger_inconsistent";
}

/** The rule a synced save broke, so the server can log why it refused (never the save itself). */
export type AuditProblem =
  | "elapsed"
  | "earned_went_down"
  | "spent_went_down"
  | "balance_mismatch"
  | "ledger_rewound"
  | "salary_minutes"
  | "salary_rate"
  | "card_count"
  | "card_amount"
  | "incident_count"
  | "incident_amount"
  | "incident_over_tier"
  | "unvouched_spend"
  | "unvouched_pay"
  | "pay_total"
  | "company_spend_total"
  | "ledger_inconsistent"
  | "correct_cards_went_down"
  | "correct_cards_unpaid"
  | "war_rooms_unpaid";

export function isPlausibleWallet(...args: Parameters<typeof walletProblem>): boolean {
  return walletProblem(...args) === null;
}

/**
 * Is `next` an honest successor of `previous` after `elapsedSeconds`? `tierOf` caps each incident
 * payout and prices each solution bought in between; without it, a save with either is refused.
 */
export function isPlausibleProgress(
  previous: Progress,
  next: Progress,
  elapsedSeconds: number,
  tierOf: TierOf = NO_TIERS,
  promised: PromisedMoney = NO_PROMISED_MONEY,
): boolean {
  return progressProblem(previous, next, elapsedSeconds, tierOf, promised) === null;
}

/** Why `next` can't honestly follow `previous`, or null when it can. */
export function progressProblem(
  previous: Progress,
  next: Progress,
  elapsedSeconds: number,
  tierOf: TierOf = NO_TIERS,
  promised: PromisedMoney = NO_PROMISED_MONEY,
): AuditProblem | null {
  // Career level reads correctCards and passed War Rooms, so each may only grow by work that was also paid for.
  const newCorrect = next.correctCards - previous.correctCards;
  const newPaidCards = next.wallet.paidUnits.card - previous.wallet.paidUnits.card;
  const newPaidIncidents = next.wallet.paidUnits.incident - previous.wallet.paidUnits.incident;
  // A first save may bring correct answers from before cards paid: they show in its own shift history.
  const isFirstSave = previous.wallet.nextSeq === 0 && previous.correctCards === 0;
  const unpaidAllowance = isFirstSave ? next.history.reduce((sum, day) => sum + day.correct, 0) : 0;
  const lowestLevel = careerLevel(previous).level;
  const topLevel = careerLevel(next).level;
  const tierFrom = (scenarioId: string | null) => (scenarioId === null ? undefined : tierOf(scenarioId));
  const isFairIncidentPay: Vouch = (entry) => {
    const tier = tierFrom(scenarioOfIncident(entry.ref));
    // A promotion can land mid-sync, so the level the save reaches sets the cap.
    return tier !== undefined && entry.amountCents <= 100 * INCIDENT_CENTS_PER_POINT_BY_TIER[paidTier(tier, topLevel)];
  };
  const isAllowedSpend: Vouch = (entry) => {
    // A company seed must be exactly what the server is waiting for, under the ref it issued.
    if (entry.reason === "company") return promised.fundings.get(entry.ref) === -entry.amountCents;
    if (entry.reason === "invest") return promised.investments.get(entry.ref) === -entry.amountCents;
    const tier = tierFrom(scenarioOfPurchase(entry.ref));
    // Price rises with level, so charging at the level the buyer started this sync from is the floor.
    return tier !== undefined && -entry.amountCents >= solutionPriceCents(tier, lowestLevel);
  };
  const issuedBy: Readonly<Record<ServerIssued, ReadonlyMap<string, number>>> = { payroll: promised.payouts, grant: promised.grants, dividend: promised.dividends };
  const isBookedPay: Vouch = (entry) => (SERVER_ISSUED as readonly string[]).includes(entry.reason) && issuedBy[entry.reason as ServerIssued].get(entry.ref) === entry.amountCents;
  if (newCorrect < 0) return "correct_cards_went_down";
  if (newCorrect > newPaidCards + unpaidAllowance) return "correct_cards_unpaid";
  if (improvedPassingWarRooms(previous, next) > newPaidIncidents) return "war_rooms_unpaid";
  return walletProblem(previous.wallet, next.wallet, elapsedSeconds, topLevel, isFairIncidentPay, isAllowedSpend, isBookedPay);
}

/** War Rooms whose best run newly reached a paying score; each needs its own incident payout. */
function improvedPassingWarRooms(previous: Progress, next: Progress): number {
  return Object.entries(next.warRoom).filter(([id, record]) => {
    const before = previous.warRoom[id]?.bestPoints ?? 0;
    return record.bestPoints >= INCIDENT_MIN_POINTS && record.bestPoints > before;
  }).length;
}

function freshLines(previous: Wallet, next: Wallet): LedgerEntry[] {
  return next.ledger.filter((entry) => entry.seq >= previous.nextSeq);
}

/** New ledger lines must account for the balance change exactly — unless the cap pushed some out. */
function isLedgerConsistent(previous: Wallet, next: Wallet): boolean {
  const fresh = freshLines(previous, next);
  if (fresh.some((entry) => entry.seq >= next.nextSeq)) return false;
  // The same earning or purchase can't be booked twice, within this sync or against what was already stored.
  const refs = new Set(previous.ledger.map((entry) => entry.ref));
  for (const entry of fresh) {
    if (refs.has(entry.ref)) return false;
    refs.add(entry.ref);
  }
  const total = fresh.reduce((sum, entry) => sum + entry.amountCents, 0);
  const balanceDelta = next.balanceCents - previous.balanceCents;
  if (fresh.length === next.nextSeq - previous.nextSeq) return total === balanceDelta && isBookedByReason(previous, next, fresh);
  // Lines go missing only when the cap evicts them oldest-first — so the whole ledger must then be new.
  const isEvictedByCap = next.ledger.length === LEDGER_LIMIT && fresh.length === LEDGER_LIMIT;
  return isEvictedByCap && total <= balanceDelta;
}

/**
 * Each reason's totals move by exactly its own lines, so money paid under one reason can't be booked to
 * another, and each incident line is one paid incident, so one run can't carry several payouts.
 */
function isBookedByReason(previous: Wallet, next: Wallet, fresh: readonly LedgerEntry[]): boolean {
  const linesFor = (reason: LedgerEntry["reason"]) => fresh.filter((entry) => entry.reason === reason);
  const centsFor = (reason: LedgerEntry["reason"]) => linesFor(reason).reduce((sum, entry) => sum + entry.amountCents, 0);
  return (
    EARN_REASONS.every((reason) => centsFor(reason) === next.earnedCents[reason] - previous.earnedCents[reason]) &&
    SPEND_REASONS.every((reason) => -centsFor(reason) === next.spentCents[reason] - previous.spentCents[reason]) &&
    linesFor("incident").length === next.paidUnits.incident - previous.paidUnits.incident
  );
}
