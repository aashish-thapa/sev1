/**
 * Job-mode pay: what each kind of work is worth, the wallet it lands in, and the rules a server
 * can use to tell an earned wallet from a forged one. All money is integer cents.
 */
import { z } from "zod";
import { careerLevel, type Level } from "./career.ts";
import type { Progress } from "./progress.ts";

/**
 * Paid per minute of active play, by career level, at real time: an intern's $24/h up to staff's
 * $114/h. Engineer ($60/h) is the middle of the ladder.
 */
export const SALARY_CENTS_PER_MINUTE: Readonly<Record<Level, number>> = { 0: 40, 1: 70, 2: 100, 3: 140, 4: 190 };
const TOP_LEVEL: Level = 4;

/** A correct call at a wall screen, by card difficulty. Today's rated problems pay full. */
export const CARD_BONUS_CENTS: Readonly<Record<1 | 2 | 3, number>> = { 1: 1_500, 2: 2_500, 3: 4_000 };
/** Practice pays a fraction of the rated bonus: it's learning, not the job. */
export const PRACTICE_SHARE = 0.4;

/** Each debrief point is worth this much, so a perfect 100 pays $600. */
export const INCIDENT_CENTS_PER_POINT = 600;
/** Below this the fix did more harm than good (grade D): no bonus. */
export const INCIDENT_MIN_POINTS = 35;

/** Fastest anyone can honestly read and answer a card, and close an incident; plausibility uses these. */
export const MIN_SECONDS_PER_CARD = 4;
export const MIN_SECONDS_PER_INCIDENT = 90;

export const LEDGER_LIMIT = 200;

/**
 * `ref` names the earning itself, so the server can store each one once: a retried sync or a reload
 * re-sends the same ref, never a new one. Build it with `payRef`.
 */
export type Payment =
  | { readonly kind: "salary"; readonly ref: string; readonly minutes: number; readonly level: Level }
  | { readonly kind: "card"; readonly ref: string; readonly difficulty: 1 | 2 | 3; readonly mode: "rated" | "practice"; readonly title: string }
  | { readonly kind: "incident"; readonly ref: string; readonly points: number; readonly title: string; readonly isTeam: boolean };

/** Stable identities for earnings (all times epoch milliseconds). */
export const payRef = {
  /** One salary payout per wall-clock minute. */
  salary: (at: number) => `salary:${new Date(at).toISOString().slice(0, 10)}:${Math.floor(at / 60_000)}`,
  /** One answer to one card, at the moment it was given. */
  card: (cardId: string, answeredAt: number) => `card:${cardId}:${answeredAt}`,
  /** One incident run, by when it started. */
  incident: (scenarioId: string, runStartedAt: number) => `incident:${scenarioId}:${runStartedAt}`,
} as const;

const REASONS = ["salary", "card", "incident"] as const satisfies readonly Payment["kind"][];
export type PayReason = (typeof REASONS)[number];

const Cents = z.int().nonnegative();

const LedgerEntrySchema = z.object({
  seq: z.int().nonnegative(),
  /** Epoch milliseconds. */
  at: z.int().nonnegative(),
  reason: z.enum(REASONS),
  /** Unique per earning; the server deduplicates on it. */
  ref: z.string().min(1).max(160),
  amountCents: z.int().positive(),
  /** What was paid for: active minutes for salary, one card or incident otherwise. Older entries predate it. */
  units: z.int().positive().default(1),
  note: z.string().max(120),
});

const PerReason = z.object({ salary: Cents, card: Cents, incident: Cents });

export const WalletSchema = z.object({
  balanceCents: Cents,
  /** Lifetime cents earned per reason; the balance is their sum until spending exists. */
  earnedCents: PerReason,
  /** Lifetime count of paid units per reason: active minutes, correct cards, incidents. */
  paidUnits: PerReason,
  /** The seq the next ledger entry gets; entries at or past a previous wallet's value are new to it. */
  nextSeq: z.int().nonnegative(),
  /** Newest last, capped at LEDGER_LIMIT. */
  ledger: z.array(LedgerEntrySchema).max(LEDGER_LIMIT),
});

export type LedgerEntry = z.output<typeof LedgerEntrySchema>;
export type Wallet = z.output<typeof WalletSchema>;

export function emptyWallet(): Wallet {
  return { balanceCents: 0, earnedCents: { salary: 0, card: 0, incident: 0 }, paidUnits: { salary: 0, card: 0, incident: 0 }, nextSeq: 0, ledger: [] };
}

/** What a payment is worth; zero means it earns nothing (a wrong-but-recorded incident, a zero-minute tick). */
export function amountOf(payment: Payment): number {
  switch (payment.kind) {
    case "salary":
      return Math.max(0, Math.floor(payment.minutes)) * SALARY_CENTS_PER_MINUTE[payment.level];
    case "card": {
      const full = CARD_BONUS_CENTS[payment.difficulty];
      return payment.mode === "rated" ? full : Math.round(full * PRACTICE_SHARE);
    }
    case "incident":
      return payment.points >= INCIDENT_MIN_POINTS ? Math.round(payment.points) * INCIDENT_CENTS_PER_POINT : 0;
  }
}

function unitsOf(payment: Payment): number {
  return payment.kind === "salary" ? Math.max(0, Math.floor(payment.minutes)) : 1;
}

function noteOf(payment: Payment): string {
  switch (payment.kind) {
    case "salary":
      return payment.minutes === 1 ? "Salary · 1 active minute" : `Salary · ${payment.minutes} active minutes`;
    case "card":
      return `${payment.mode === "rated" ? "Correct call" : "Practice call"} · ${payment.title}`.slice(0, 120);
    case "incident":
      return `${payment.isTeam ? "Team incident" : "Incident"} resolved · ${payment.title}`.slice(0, 120);
  }
}

/** Credits a payment once; one worth nothing, or already paid under its ref, leaves the wallet untouched. */
export function pay(wallet: Wallet, payment: Payment, at: number): Wallet {
  const amountCents = amountOf(payment);
  if (amountCents === 0 || wallet.ledger.some((entry) => entry.ref === payment.ref)) return wallet;
  const reason = payment.kind;
  const entry: LedgerEntry = { seq: wallet.nextSeq, at, reason, ref: payment.ref, amountCents, units: unitsOf(payment), note: noteOf(payment) };
  return {
    balanceCents: wallet.balanceCents + amountCents,
    earnedCents: { ...wallet.earnedCents, [reason]: wallet.earnedCents[reason] + amountCents },
    paidUnits: { ...wallet.paidUnits, [reason]: wallet.paidUnits[reason] + unitsOf(payment) },
    nextSeq: wallet.nextSeq + 1,
    ledger: [...wallet.ledger, entry].slice(-LEDGER_LIMIT),
  };
}

/** Network and timer jitter between syncs: allow this much extra time and a couple of extra events. */
const TIME_SLACK = 1.25;
const EVENT_ALLOWANCE = 2;
const MAX_INCIDENT_CENTS = 100 * INCIDENT_CENTS_PER_POINT;
const MAX_CARD_CENTS = Math.max(...Object.values(CARD_BONUS_CENTS));

/**
 * Could `next` have been earned from `previous` in `elapsedSeconds` of play? Generous by design —
 * it stops forged wallets, not honest players on a laggy connection.
 */
export function isPlausibleWallet(previous: Wallet, next: Wallet, elapsedSeconds: number, topLevel: Level = TOP_LEVEL): boolean {
  if (!(elapsedSeconds >= 0)) return false;
  const seconds = elapsedSeconds * TIME_SLACK;
  const delta = (reason: PayReason, of: "earnedCents" | "paidUnits") => next[of][reason] - previous[of][reason];

  for (const reason of REASONS) {
    if (delta(reason, "earnedCents") < 0 || delta(reason, "paidUnits") < 0) return false;
  }
  const earned = REASONS.reduce((sum, reason) => sum + next.earnedCents[reason], 0);
  if (next.balanceCents !== earned) return false;
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

  return isLedgerConsistent(previous, next);
}

/** The server-side gate for a synced save: is the wallet growth honest? */
export function isPlausibleProgress(previous: Progress, next: Progress, elapsedSeconds: number): boolean {
  // Career level reads correctCards and passed War Rooms, so each may only grow by work that was also paid for.
  const newCorrect = next.correctCards - previous.correctCards;
  const newPaidCards = next.wallet.paidUnits.card - previous.wallet.paidUnits.card;
  const newPaidIncidents = next.wallet.paidUnits.incident - previous.wallet.paidUnits.incident;
  return (
    newCorrect >= 0 &&
    newCorrect <= newPaidCards &&
    improvedPassingWarRooms(previous, next) <= newPaidIncidents &&
    isPlausibleWallet(previous.wallet, next.wallet, elapsedSeconds, careerLevel(next).level)
  );
}

/** War Rooms whose best run newly reached a paying score; each needs its own incident payout. */
function improvedPassingWarRooms(previous: Progress, next: Progress): number {
  return Object.entries(next.warRoom).filter(([id, record]) => {
    const before = previous.warRoom[id]?.bestPoints ?? 0;
    return record.bestPoints >= INCIDENT_MIN_POINTS && record.bestPoints > before;
  }).length;
}

/** New ledger lines must account for the balance change exactly — unless the cap pushed some out. */
function isLedgerConsistent(previous: Wallet, next: Wallet): boolean {
  const fresh = next.ledger.filter((entry) => entry.seq >= previous.nextSeq);
  if (fresh.some((entry) => entry.seq >= next.nextSeq)) return false;
  // The same earning can't be paid twice, within this sync or against what was already stored.
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

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: number): string {
  return dollars.format(cents / 100);
}
