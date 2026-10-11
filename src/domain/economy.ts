/**
 * Job-mode pay: what each kind of work is worth, the wallet it lands in, and the rules a server
 * can use to tell an earned wallet from a forged one. All money is integer cents.
 */
import { z } from "zod";
import type { Level } from "./career.ts";
import type { Tier } from "./tier.ts";

/**
 * Paid per minute of active play, by career level, at real time: an intern's $24/h up to staff's
 * $114/h. Engineer ($60/h) is the middle of the ladder.
 */
export const SALARY_CENTS_PER_MINUTE: Readonly<Record<Level, number>> = { 0: 40, 1: 70, 2: 100, 3: 140, 4: 190 };

/** A correct call at a wall screen, by card difficulty. Today's rated problems pay full. */
export const CARD_BONUS_CENTS: Readonly<Record<1 | 2 | 3, number>> = { 1: 1_500, 2: 2_500, 3: 4_000 };
/** Practice pays a fraction of the rated bonus: it's learning, not the job. */
export const PRACTICE_SHARE = 0.4;

/** Each debrief point is worth this much, by tier: a perfect tier-1 run pays $600, a perfect tier-5 run $3,600. */
export const INCIDENT_CENTS_PER_POINT_BY_TIER: Readonly<Record<Tier, number>> = { 1: 600, 2: 900, 3: 1_500, 4: 2_400, 5: 3_600 };
/** Below this the fix did more harm than good (grade D): no bonus. */
export const INCIDENT_MIN_POINTS = 35;

/** The tier an incident pays at: never above what the player's level unlocks, so an Intern can't draw Staff pay from a meltdown room. */
export function paidTier(tier: Tier, level: Level): Tier {
  return Math.min(tier, level + 1) as Tier;
}

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
  | { readonly kind: "incident"; readonly ref: string; readonly points: number; readonly tier: Tier; readonly title: string; readonly isTeam: boolean }
  /** A company paying you for a work day: the server booked it, the save claims it once (ref `payroll:<payoutId>`). */
  | { readonly kind: "payroll"; readonly ref: string; readonly amountCents: number; readonly workDay: number }
  /** Money an admin granted (test money): the server issued it, the save claims it once (ref `grant:<grantId>`). */
  | { readonly kind: "grant"; readonly ref: string; readonly amountCents: number; readonly note: string }
  /** Your share of a company's weekly profit as an investor: booked by the server, claimed once (ref `dividend:<payoutId>`). */
  | { readonly kind: "dividend"; readonly ref: string; readonly amountCents: number; readonly workDay: number };

/** Stable identities for earnings (all times epoch milliseconds). */
export const payRef = {
  /** One salary payout per wall-clock minute. */
  salary: (at: number) => `salary:${new Date(at).toISOString().slice(0, 10)}:${Math.floor(at / 60_000)}`,
  /** One answer to one card, at the moment it was given. */
  card: (cardId: string, answeredAt: number) => `card:${cardId}:${answeredAt}`,
  /** One incident run, by when it started. */
  incident: (scenarioId: string, runStartedAt: number) => `incident:${scenarioId}:${runStartedAt}`,
  /** One payout the company booked for you. */
  payroll: (payoutId: string) => `payroll:${payoutId}`,
  /** One grant an admin issued to you. */
  grant: (grantId: string) => `grant:${grantId}`,
  /** One dividend a company booked for you as an investor. */
  dividend: (payoutId: string) => `dividend:${payoutId}`,
} as const;

/** The scenario an incident payout was for, read back from its `payRef.incident` ref; null for any other ref. */
export function scenarioOfIncident(ref: string): string | null {
  const match = /^incident:(.+):\d+$/.exec(ref);
  return match ? match[1] : null;
}

const REASONS = ["salary", "card", "incident", "payroll", "grant", "dividend"] as const satisfies readonly Payment["kind"][];
export type PayReason = (typeof REASONS)[number];
/** What money can be spent on; purchases are negative ledger lines (see purchases.ts). */
export const SPEND_REASONS = ["solution", "company", "invest"] as const;
export type SpendReason = (typeof SPEND_REASONS)[number];

const Cents = z.int().nonnegative();

const LedgerEntrySchema = z.object({
  seq: z.int().nonnegative(),
  /** Epoch milliseconds. */
  at: z.int().nonnegative(),
  reason: z.enum([...REASONS, ...SPEND_REASONS]),
  /** Unique per earning or purchase; the server deduplicates on it. */
  ref: z.string().min(1).max(160),
  /** Positive for pay, negative for a purchase. */
  amountCents: z.int().refine((cents) => cents !== 0, "a ledger line moves money"),
  /** What was paid for: active minutes for salary, one card or incident otherwise. Older entries predate it. */
  units: z.int().positive().default(1),
  note: z.string().max(120),
});

// Payroll and company spending came with startup mode; older saves start them at zero.
const PerReason = z.object({ salary: Cents, card: Cents, incident: Cents, payroll: Cents.default(0), grant: Cents.default(0), dividend: Cents.default(0) });
const PerSpend = z.object({ solution: Cents, company: Cents.default(0), invest: Cents.default(0) });

export const WalletSchema = z.object({
  balanceCents: Cents,
  /** Lifetime cents earned per reason; the balance is earned minus spent. */
  earnedCents: PerReason,
  /** Lifetime count of paid units per reason: active minutes, correct cards, incidents. */
  paidUnits: PerReason,
  /** Lifetime cents spent per purchase kind; saves from before spending start at zero. */
  spentCents: PerSpend.default({ solution: 0, company: 0, invest: 0 }),
  boughtUnits: PerSpend.default({ solution: 0, company: 0, invest: 0 }),
  /** The seq the next ledger entry gets; entries at or past a previous wallet's value are new to it. */
  nextSeq: z.int().nonnegative(),
  /** Newest last, capped at LEDGER_LIMIT. */
  ledger: z.array(LedgerEntrySchema).max(LEDGER_LIMIT),
});

export type LedgerEntry = z.output<typeof LedgerEntrySchema>;
export type Wallet = z.output<typeof WalletSchema>;

export function emptyWallet(): Wallet {
  return {
    balanceCents: 0,
    earnedCents: { salary: 0, card: 0, incident: 0, payroll: 0, grant: 0, dividend: 0 },
    paidUnits: { salary: 0, card: 0, incident: 0, payroll: 0, grant: 0, dividend: 0 },
    spentCents: { solution: 0, company: 0, invest: 0 },
    boughtUnits: { solution: 0, company: 0, invest: 0 },
    nextSeq: 0,
    ledger: [],
  };
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
      return payment.points >= INCIDENT_MIN_POINTS ? Math.round(payment.points) * INCIDENT_CENTS_PER_POINT_BY_TIER[payment.tier] : 0;
    case "payroll":
    case "grant":
    case "dividend":
      return Math.max(0, Math.floor(payment.amountCents));
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
    case "payroll":
      return `Company pay · work day ${payment.workDay}`;
    case "grant":
      return (payment.note ? `Grant · ${payment.note}` : "Grant from the team").slice(0, 120);
    case "dividend":
      return `Dividend · work day ${payment.workDay}`;
  }
}

/** Credits a payment once; one worth nothing, or already paid under its ref, leaves the wallet untouched. */
export function pay(wallet: Wallet, payment: Payment, at: number): Wallet {
  const amountCents = amountOf(payment);
  if (amountCents === 0 || wallet.ledger.some((entry) => entry.ref === payment.ref)) return wallet;
  const reason = payment.kind;
  const entry: LedgerEntry = { seq: wallet.nextSeq, at, reason, ref: payment.ref, amountCents, units: unitsOf(payment), note: noteOf(payment) };
  return {
    ...wallet,
    balanceCents: wallet.balanceCents + amountCents,
    earnedCents: { ...wallet.earnedCents, [reason]: wallet.earnedCents[reason] + amountCents },
    paidUnits: { ...wallet.paidUnits, [reason]: wallet.paidUnits[reason] + unitsOf(payment) },
    nextSeq: wallet.nextSeq + 1,
    ledger: [...wallet.ledger, entry].slice(-LEDGER_LIMIT),
  };
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: number): string {
  return dollars.format(cents / 100);
}
