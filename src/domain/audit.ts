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
  SALARY_CENTS_PER_MINUTE,
  SPEND_REASONS,
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
const MAX_INCIDENT_CENTS = 100 * Math.max(...Object.values(INCIDENT_CENTS_PER_POINT_BY_TIER));
const MAX_CARD_CENTS = Math.max(...Object.values(CARD_BONUS_CENTS));
const EARN_REASONS = ["salary", "card", "incident"] as const satisfies readonly PayReason[];

/** Looks up the tier of a scenario by id; the Worker answers from the scenario registry. */
export type TierOf = (scenarioId: string) => Tier | undefined;

/** With no registry, nothing can be bought — every purchase line is rejected. */
const NO_TIERS: TierOf = () => undefined;

/** Is a purchase line charged at least the price for its scenario at the buyer's level? */
type FairPrice = (entry: LedgerEntry) => boolean;

export function isPlausibleWallet(
  previous: Wallet,
  next: Wallet,
  elapsedSeconds: number,
  topLevel: Level = 4,
  isFairPrice: FairPrice = () => false,
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

  const purchases = freshLines(previous, next).filter((entry) => (SPEND_REASONS as readonly string[]).includes(entry.reason));
  if (purchases.some((entry) => entry.amountCents >= 0 || !isFairPrice(entry))) return false;

  return isLedgerConsistent(previous, next);
}

/**
 * Is `next` an honest successor of `previous` after `elapsedSeconds`? `tierOf` prices any
 * solutions bought in between; without it, a save containing a new purchase is refused.
 */
export function isPlausibleProgress(previous: Progress, next: Progress, elapsedSeconds: number, tierOf: TierOf = NO_TIERS): boolean {
  // Career level reads correctCards and passed War Rooms, so each may only grow by work that was also paid for.
  const newCorrect = next.correctCards - previous.correctCards;
  const newPaidCards = next.wallet.paidUnits.card - previous.wallet.paidUnits.card;
  const newPaidIncidents = next.wallet.paidUnits.incident - previous.wallet.paidUnits.incident;
  const lowestLevel = careerLevel(previous).level;
  const isFairPrice: FairPrice = (entry) => {
    const scenarioId = scenarioOfPurchase(entry.ref);
    const tier = scenarioId === null ? undefined : tierOf(scenarioId);
    // Price rises with level, so charging at the level the buyer started this sync from is the floor.
    return tier !== undefined && -entry.amountCents >= solutionPriceCents(tier, lowestLevel);
  };
  return (
    newCorrect >= 0 &&
    newCorrect <= newPaidCards &&
    improvedPassingWarRooms(previous, next) <= newPaidIncidents &&
    isPlausibleWallet(previous.wallet, next.wallet, elapsedSeconds, careerLevel(next).level, isFairPrice)
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
