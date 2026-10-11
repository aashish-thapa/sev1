import { z } from "zod";
import { parseLocalDate, previousDay, type LocalDate } from "./calendar.ts";
import { TOPICS, ROLE_IDS, type Role } from "./incident.ts";
import { emptyWallet, pay, WalletSchema, type Payment } from "./economy.ts";
import { DEFAULT_LOOK, LookSchema, SavedLookSchema, type Look } from "./look.ts";
import { EMPTY_PANTRY, PantryLogSchema, recordTaken, type ConsumableId } from "./pantry.ts";
import { rateAttempt } from "./rating.ts";
import { drain, refuel, RESTED, WellbeingSchema, type Refuel } from "./wellbeing.ts";

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

const ProgressFieldsSchema = z.object({
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
  /** Lifetime correct rated answers; `history` is capped, so career experience can't come from it. */
  correctCards: z.int().nonnegative(),
  /** Longest run of consecutive daily shifts; `streak.count` resets, this never drops. */
  bestStreak: z.int().nonnegative(),
  /** The earned badge shown next to your name in rooms and on the leaderboard (an achievements catalog id). */
  featuredBadge: z.string().min(1).max(40).nullable().default(null),
  /** Paid-tier hints opened today (Pro's daily allowance); resets when the day changes. */
  hintsUsed: z.object({ day: LocalDateSchema, count: z.int().nonnegative() }).nullable().default(null),
  /** Energy and fullness; saves from before them start rested. */
  wellbeing: WellbeingSchema.default(RESTED),
  /** What you've taken from the office pantry, for startup mode's operating costs. */
  pantry: PantryLogSchema.default(EMPTY_PANTRY),
  /** The body and lobby pose you chose; cosmetic, so the server's audit never reads it. */
  look: SavedLookSchema.default(DEFAULT_LOOK),
});

/** Saves from before `correctCards` existed: count what history and today's shift still remember. */
function backfillCorrectCards(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || "correctCards" in raw) return raw;
  const save = raw as { history?: unknown; activeShift?: unknown };
  const fromHistory = Array.isArray(save.history) ? save.history.reduce((sum: number, day: { correct?: unknown }) => sum + (typeof day?.correct === "number" ? day.correct : 0), 0) : 0;
  const attempts = (save.activeShift as { attempts?: unknown } | null | undefined)?.attempts;
  const fromToday = Array.isArray(attempts) ? attempts.filter((attempt: { isCorrect?: unknown }) => attempt?.isCorrect === true).length : 0;
  return { ...raw, correctCards: fromHistory + fromToday };
}

/** Saves from before `bestStreak` existed: the current streak is the best one we can still prove. */
function backfillBestStreak(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || "bestStreak" in raw) return raw;
  const count = (raw as { streak?: { count?: unknown } }).streak?.count;
  return { ...raw, bestStreak: typeof count === "number" && count > 0 ? Math.floor(count) : 0 };
}

export const ProgressSchema = z.preprocess((raw) => backfillBestStreak(backfillCorrectCards(raw)), ProgressFieldsSchema);

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
    bestStreak: 0,
    featuredBadge: null,
    hintsUsed: null,
    wellbeing: RESTED,
    pantry: EMPTY_PANTRY,
    look: DEFAULT_LOOK,
    history: [],
    activeShift: null,
    warRoom: {},
    role: null,
    wallet: emptyWallet(),
    correctCards: 0,
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

/**
 * A run closed with a bought solution: it counts as played (so solo incidents still rotate) but
 * never improves the best score — so it earns no experience and can't buy a promotion.
 */
export function recordAssistedRun(progress: Progress, scenarioId: string): Progress {
  const previous = progress.warRoom[scenarioId];
  const record = previous ? { ...previous, plays: previous.plays + 1 } : { bestPoints: 0, bestGrade: "D" as const, plays: 1 };
  return { ...progress, warRoom: { ...progress.warRoom, [scenarioId]: record } };
}

/** War Rooms finished across every scenario; picks which solo incident pages you next. */
export function warRoomPlays(progress: Progress): number {
  return Object.values(progress.warRoom).reduce((sum, record) => sum + record.plays, 0);
}

/** Shows an earned badge next to your name, or none. Whether it's earned is checked where badges live (achievements.ts). */
/** Allowance hints opened on `day`; yesterday's count doesn't carry over. */
export function hintsUsedOn(progress: Progress, day: LocalDate): number {
  return progress.hintsUsed?.day === day ? progress.hintsUsed.count : 0;
}

/** Counts one allowance hint against `day`. Whether one was left to spend is the caller's rule (entitlements). */
export function spendHint(progress: Progress, day: LocalDate): Progress {
  return { ...progress, hintsUsed: { day, count: hintsUsedOn(progress, day) + 1 } };
}

/** Active minutes on the floor tire you and make you hungry. */
export function wearDown(progress: Progress, activeMinutes: number): Progress {
  const wellbeing = drain(progress.wellbeing, activeMinutes);
  return wellbeing === progress.wellbeing ? progress : { ...progress, wellbeing };
}

/** Taking something from the pantry (a brewed cup, a snack from the shelf) logs it once. */
export function takeFromPantry(progress: Progress, id: ConsumableId, day: LocalDate): Progress {
  return { ...progress, pantry: recordTaken(progress.pantry, id, day) };
}

/** A sip or a bite: `portion` of one serving's worth of energy or fullness. */
export function consume(progress: Progress, kind: Refuel, portion: number): Progress {
  return { ...progress, wellbeing: refuel(progress.wellbeing, kind, portion) };
}

export function chooseLook(progress: Progress, look: Look): Progress {
  return { ...progress, look: LookSchema.parse(look) };
}

export function featureBadge(progress: Progress, badgeId: string | null): Progress {
  return progress.featuredBadge === badgeId ? progress : { ...progress, featuredBadge: badgeId };
}

export function hasFinishedShift(progress: Progress, day: LocalDate): boolean {
  return progress.history.some((entry) => entry.day === day);
}

/** True once at least one of the day's rated discussion cards is answered. */
export function hasDiscussedOn(progress: Progress, day: string): boolean {
  if (progress.activeShift?.day === day && progress.activeShift.attempts.length > 0) return true;
  return progress.history.some((entry) => entry.day === day && entry.total > 0);
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
    correctCards: progress.correctCards + (attempt.isCorrect ? 1 : 0),
  };
  return attempts.length === active.incidentIds.length ? closeShift(rated, active.day, attempts) : rated;
}

function closeShift(progress: Progress, day: LocalDate, attempts: readonly Attempt[]): Progress {
  const correct = attempts.filter((attempt) => attempt.isCorrect).length;
  const continuesStreak = progress.streak.lastShiftDay === previousDay(day);
  const count = continuesStreak ? progress.streak.count + 1 : 1;
  return {
    ...progress,
    streak: { count, lastShiftDay: day },
    bestStreak: Math.max(progress.bestStreak, count),
    history: [{ day, correct, total: attempts.length }, ...progress.history].slice(0, HISTORY_LIMIT),
    activeShift: null,
  };
}

/** A streak survives until the end of the day after the last finished shift. */
export function liveStreak(progress: Progress, today: LocalDate): number {
  const { count, lastShiftDay } = progress.streak;
  return lastShiftDay === today || lastShiftDay === previousDay(today) ? count : 0;
}
