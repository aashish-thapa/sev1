import { z } from "zod";
import { parseLocalDate, previousDay, type LocalDate } from "./calendar.ts";
import { TOPICS, ROLE_IDS, type Role } from "./incident.ts";
import { emptyWallet, pay, WalletSchema, type Payment } from "./economy.ts";
import { rateAttempt } from "./rating.ts";

const HISTORY_LIMIT = 60;

const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform(parseLocalDate);

const AttemptSchema = z.object({
  incidentId: z.string(),
  topic: z.enum(TOPICS),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  isCorrect: z.boolean(),
  elapsedMs: z.int().nonnegative(),
});

const ActiveShiftSchema = z.object({
  day: LocalDateSchema,
  incidentIds: z.array(z.string()).min(1),
  attempts: z.array(AttemptSchema),
});

const GRADES = ["S", "A", "B", "C", "D"] as const;

const WarRoomRecordSchema = z.object({
  bestPoints: z.int().min(0).max(100),
  bestGrade: z.enum(GRADES),
  plays: z.int().positive(),
});

export const ProgressSchema = z.object({
  version: z.literal(1),
  ratings: z.partialRecord(z.enum(TOPICS), z.number()),
  seenIds: z.array(z.string()),
  streak: z.object({ count: z.int().nonnegative(), lastShiftDay: LocalDateSchema.nullable() }),
  history: z.array(z.object({ day: LocalDateSchema, correct: z.int(), total: z.int() })).max(HISTORY_LIMIT),
  activeShift: ActiveShiftSchema.nullable(),
  // Added after launch; older saved progress parses with an empty record.
  warRoom: z.record(z.string(), WarRoomRecordSchema).default({}),
  // Unset until the player picks a role on their first visit.
  role: z.enum(ROLE_IDS as [Role, ...Role[]]).nullable().default(null),
  // Saves from before job-mode pay start with an empty wallet.
  wallet: WalletSchema.default(emptyWallet),
});

export type Attempt = z.infer<typeof AttemptSchema>;
export type ActiveShift = z.output<typeof ActiveShiftSchema>;
export type Progress = z.output<typeof ProgressSchema>;
export type WarRoomRecord = z.output<typeof WarRoomRecordSchema>;

export function emptyProgress(): Progress {
  return {
    version: 1,
    ratings: {},
    seenIds: [],
    streak: { count: 0, lastShiftDay: null },
    history: [],
    activeShift: null,
    warRoom: {},
    role: null,
    wallet: emptyWallet(),
  };
}

/** Credits job-mode pay; `at` is epoch milliseconds. */
export function earn(progress: Progress, payment: Payment, at: number): Progress {
  const wallet = pay(progress.wallet, payment, at);
  return wallet === progress.wallet ? progress : { ...progress, wallet };
}

export function chooseRole(progress: Progress, role: Role): Progress {
  return { ...progress, role };
}

export function recordWarRoomRun(progress: Progress, scenarioId: string, points: number, grade: WarRoomRecord["bestGrade"]): Progress {
  const previous = progress.warRoom[scenarioId];
  const isBest = !previous || points > previous.bestPoints;
  return {
    ...progress,
    warRoom: {
      ...progress.warRoom,
      [scenarioId]: {
        bestPoints: isBest ? points : previous.bestPoints,
        bestGrade: isBest ? grade : previous.bestGrade,
        plays: (previous?.plays ?? 0) + 1,
      },
    },
  };
}

export function hasFinishedShift(progress: Progress, day: LocalDate): boolean {
  return progress.history.some((entry) => entry.day === day);
}

export function startShift(progress: Progress, day: LocalDate, incidentIds: readonly string[]): Progress {
  return { ...progress, activeShift: { day, incidentIds: [...incidentIds], attempts: [] } };
}

/** Records one answer of the rated daily shift; closes the shift on its last card. */
export function recordAttempt(progress: Progress, attempt: Attempt): Progress {
  const active = progress.activeShift;
  if (!active) throw new Error("recordAttempt called without an active shift");

  const attempts = [...active.attempts, attempt];
  const rated: Progress = {
    ...progress,
    ratings: rateAttempt(progress.ratings, attempt, attempt.isCorrect),
    seenIds: progress.seenIds.includes(attempt.incidentId) ? progress.seenIds : [...progress.seenIds, attempt.incidentId],
    activeShift: { ...active, attempts },
  };
  return attempts.length === active.incidentIds.length ? closeShift(rated, active.day, attempts) : rated;
}

function closeShift(progress: Progress, day: LocalDate, attempts: readonly Attempt[]): Progress {
  const correct = attempts.filter((attempt) => attempt.isCorrect).length;
  const continuesStreak = progress.streak.lastShiftDay === previousDay(day);
  return {
    ...progress,
    streak: { count: continuesStreak ? progress.streak.count + 1 : 1, lastShiftDay: day },
    history: [{ day, correct, total: attempts.length }, ...progress.history].slice(0, HISTORY_LIMIT),
    activeShift: null,
  };
}

/** A streak survives until the end of the day after the last finished shift. */
export function liveStreak(progress: Progress, today: LocalDate): number {
  const { count, lastShiftDay } = progress.streak;
  return lastShiftDay === today || lastShiftDay === previousDay(today) ? count : 0;
}
