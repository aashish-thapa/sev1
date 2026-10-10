/**
 * The server's gate for a synced save: could this progress honestly follow that one in the time
 * between them? Generous by design: it stops forged wallets and bought promotions, not honest
 * players on a laggy connection. Pure, so the Worker runs it with no content loaded except a tier lookup.
 */
import { careerLevel, type Level } from "./career.ts";
import {
  CARD_BONUS_CENTS,
  INCIDENT_CENTS_PER_POINT,
  INCIDENT_MIN_POINTS,
  LEDGER_LIMIT,
  MIN_SECONDS_PER_CARD,
  MIN_SECONDS_PER_INCIDENT,
  SALARY_CENTS_PER_MINUTE,
  SPEND_REASONS,
  type LedgerEntry,
  type PayReason,
  type Wallet,
} from "./economy.ts";
import type { Progress } from "./progress.ts";
import { scenarioOfPurchase, solutionPriceCents, type SolutionTier } from "./purchases.ts";

/** Network and timer jitter between syncs: allow this much extra time and a couple of extra events. */
const TIME_SLACK = 1.25;
const EVENT_ALLOWANCE = 2;
const MAX_INCIDENT_CENTS = 100 * INCIDENT_CENTS_PER_POINT;
const MAX_CARD_CENTS = Math.max(...Object.values(CARD_BONUS_CENTS));
const EARN_REASONS = ["salary", "card", "incident", "payroll", "grant", "dividend"] as const satisfies readonly PayReason[];
/** Earnings the server issues and the save only claims: each new line must be one the server promised. */
const SERVER_ISSUED = ["payroll", "grant", "dividend"] as const satisfies readonly PayReason[];
type ServerIssued = (typeof SERVER_ISSUED)[number];

/** Looks up the tier of a scenario by id; the Worker answers from the scenario registry. */
export type TierOf = (scenarioId: string) => SolutionTier | undefined;

/** With no registry, nothing can be bought — every purchase line is rejected. */
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

/** Does the server stand behind this new ledger line (a purchase it can price, or pay it booked)? */
type Vouch = (entry: LedgerEntry) => boolean;

export function isPlausibleWallet(
  previous: Wallet,
  next: Wallet,
  elapsedSeconds: number,
  topLevel: Level = 4,
  isAllowedSpend: Vouch = () => false,
  isBookedPay: Vouch = () => false,
): boolean {
  if (!(elapsedSeconds >= 0)) return false;
  const seconds = elapsedSeconds * TIME_SLACK;
  const delta = (reason: PayReason, of: "earnedCents" | "paidUnits") => next[of][reason] - previous[of][reason];

  for (const reason of EARN_REASONS) {
    if (delta(reason, "earnedCents") < 0 || delta(reason, "paidUnits") < 0) return false;
  }
  for (const reason of SPEND_REASONS) {
    if (next.spentCents[reason] < previous.spentCents[reason] || next.boughtUnits[reason] < previous.boughtUnits[reason]) return false;
  }
  const earned = EARN_REASONS.reduce((sum, reason) => sum + next.earnedCents[reason], 0);
  const spent = SPEND_REASONS.reduce((sum, reason) => sum + next.spentCents[reason], 0);
  if (next.balanceCents !== earned - spent) return false;
  if (next.nextSeq < previous.nextSeq) return false;

  const minutes = delta("salary", "paidUnits");
  if (minutes > seconds / 60 + 1) return false;
  // A promotion can land mid-sync, so any rate from intern up to the level reached is honest.
  const salary = delta("salary", "earnedCents");
  if (salary < minutes * SALARY_CENTS_PER_MINUTE[0] || salary > minutes * SALARY_CENTS_PER_MINUTE[topLevel]) return false;

  const cards = delta("card", "paidUnits");
  if (cards > seconds / MIN_SECONDS_PER_CARD + EVENT_ALLOWANCE) return false;
  if (delta("card", "earnedCents") > cards * MAX_CARD_CENTS) return false;

  const incidents = delta("incident", "paidUnits");
  if (incidents > seconds / MIN_SECONDS_PER_INCIDENT + EVENT_ALLOWANCE) return false;
  if (delta("incident", "earnedCents") > incidents * MAX_INCIDENT_CENTS) return false;

  const fresh = freshLines(previous, next);
  const purchases = fresh.filter((entry) => (SPEND_REASONS as readonly string[]).includes(entry.reason));
  if (purchases.some((entry) => entry.amountCents >= 0 || !isAllowedSpend(entry))) return false;
  // Payroll and grants come only from money the server issued, and each new cent of them must be one of those lines.
  for (const reason of SERVER_ISSUED) {
    const issued = fresh.filter((entry) => entry.reason === reason);
    if (issued.some((entry) => entry.amountCents <= 0 || !isBookedPay(entry))) return false;
    if (delta(reason, "earnedCents") !== issued.reduce((sum, entry) => sum + entry.amountCents, 0)) return false;
  }
  // Money moved to a company (founding or investing) must be exactly the lines that moved it.
  for (const reason of ["company", "invest"] as const) {
    const moved = purchases.filter((entry) => entry.reason === reason).reduce((sum, entry) => sum - entry.amountCents, 0);
    if (next.spentCents[reason] - previous.spentCents[reason] !== moved) return false;
  }

  return isLedgerConsistent(previous, next);
}

/**
 * Is `next` an honest successor of `previous` after `elapsedSeconds`? `tierOf` prices any
 * solutions bought in between; without it, a save containing a new purchase is refused.
 */
export function isPlausibleProgress(
  previous: Progress,
  next: Progress,
  elapsedSeconds: number,
  tierOf: TierOf = NO_TIERS,
  promised: PromisedMoney = NO_PROMISED_MONEY,
): boolean {
  // Career level reads correctCards and passed War Rooms, so each may only grow by work that was also paid for.
  const newCorrect = next.correctCards - previous.correctCards;
  const newPaidCards = next.wallet.paidUnits.card - previous.wallet.paidUnits.card;
  const newPaidIncidents = next.wallet.paidUnits.incident - previous.wallet.paidUnits.incident;
  const lowestLevel = careerLevel(previous).level;
  const isAllowedSpend: Vouch = (entry) => {
    // A company seed must be exactly what the server is waiting for, under the ref it issued.
    if (entry.reason === "company") return promised.fundings.get(entry.ref) === -entry.amountCents;
    if (entry.reason === "invest") return promised.investments.get(entry.ref) === -entry.amountCents;
    const scenarioId = scenarioOfPurchase(entry.ref);
    const tier = scenarioId === null ? undefined : tierOf(scenarioId);
    // Price rises with level, so charging at the level the buyer started this sync from is the floor.
    return tier !== undefined && -entry.amountCents >= solutionPriceCents(tier, lowestLevel);
  };
  const issuedBy: Readonly<Record<ServerIssued, ReadonlyMap<string, number>>> = { payroll: promised.payouts, grant: promised.grants, dividend: promised.dividends };
  const isBookedPay: Vouch = (entry) => (SERVER_ISSUED as readonly string[]).includes(entry.reason) && issuedBy[entry.reason as ServerIssued].get(entry.ref) === entry.amountCents;
  return (
    newCorrect >= 0 &&
    newCorrect <= newPaidCards &&
    improvedPassingWarRooms(previous, next) <= newPaidIncidents &&
    isPlausibleWallet(previous.wallet, next.wallet, elapsedSeconds, careerLevel(next).level, isAllowedSpend, isBookedPay)
  );
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
  if (fresh.length === next.nextSeq - previous.nextSeq) return total === balanceDelta;
  // Lines go missing only when the cap evicts them oldest-first — so the whole ledger must then be new.
  const isEvictedByCap = next.ledger.length === LEDGER_LIMIT && fresh.length === LEDGER_LIMIT;
  return isEvictedByCap && total <= balanceDelta;
}
