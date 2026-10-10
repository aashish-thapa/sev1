import { useCallback, useMemo, useState } from "react";
import type { IncidentLibrary } from "../content/library.ts";
import type { LocalDate } from "../domain/calendar.ts";
import { careerLevel } from "../domain/career.ts";
import { ROLE_IDS, ROLES, roleOf, type IncidentCard, type Role } from "../domain/incident.ts";
import { payRef } from "../domain/economy.ts";
import { earnPayroll, fundCompany as fundCompanyFrom, hasBoughtSolution, spend, type SolutionTier, type SpendOutcome } from "../domain/purchases.ts";
import type { PendingPayout } from "../storage/company-protocol.ts";
import { hasEarned } from "../domain/achievements.ts";
import {
  chooseRole,
  consume,
  earn,
  featureBadge,
  hasFinishedShift,
  hintsUsedOn,
  recordAssistedRun,
  recordAttempt,
  recordWarRoomRun,
  spendHint as spendHintOn,
  startShift,
  takeFromPantry,
  wearDown,
  type Attempt,
  type Progress,
} from "../domain/progress.ts";
import type { ConsumableId } from "../domain/pantry.ts";
import type { Refuel } from "../domain/wellbeing.ts";
import { overallRating, rateAttempt, STARTING_RATING } from "../domain/rating.ts";
import { planShift, presentIncident, type Pace, type PresentedIncident } from "../domain/shift.ts";
import type { ProgressStore } from "../storage/progress-store.ts";
import type { Debrief } from "../warroom/incident.ts";

export type RunMode = "rated" | "practice";

export type Run = {
  readonly mode: RunMode;
  readonly day: LocalDate;
  readonly incidents: readonly PresentedIncident[];
  readonly attempts: readonly Attempt[];
  readonly ratingBefore: number;
};

export type Screen = { readonly name: "lobby" } | { readonly name: "office" };

/** A conversation at one of the office's wall screens: working through cards, then the wrap-up. */
export type Discussion =
  | { readonly stage: "cards"; readonly run: Run; readonly room: Role | null; readonly paidFromSeq: number }
  | { readonly stage: "report"; readonly run: Run; readonly room: Role | null; readonly paidFromSeq: number };

export type GameServices = {
  readonly library: IncidentLibrary;
  readonly store: ProgressStore;
  readonly today: () => LocalDate;
  /** Wall-clock epoch milliseconds, for ledger timestamps. */
  readonly now?: () => number;
};

export type ShiftGame = {
  readonly screen: Screen;
  readonly progress: Progress;
  readonly today: LocalDate;
  readonly discussion: Discussion | null;
  /** Alerts still waiting in today's rated set for your role, in order. */
  readonly queuedAlerts: readonly IncidentCard["alert"][];
  readonly roleCounts: Readonly<Record<Role, number>>;
  enterOffice(): void;
  leaveOffice(): void;
  chooseRole(role: Role): void;
  /** Shows an earned badge next to your name in rooms and on the leaderboard; null shows none. */
  featureBadge(badgeId: string | null): void;
  /**
   * Your role's screen holds your rated daily problems (practice once they're done);
   * another role's screen is unrated practice in their field; the library (`null`) mixes everyone's.
   */
  openDiscussion(room: Role | null): void;
  /** Returns the rating change this answer caused (0 in practice). */
  answer(attempt: Attempt): number;
  wrapUpDiscussion(): void;
  closeDiscussion(): void;
  /** Records the run and pays the resolution bonus (every player in a team room is paid their own). */
  /** Buys the step-by-step solution for this run; the run then pays nothing and earns no experience. */
  buySolution(scenario: { readonly id: string; readonly title: string; readonly tier: SolutionTier }, runStartedAt: number): SpendOutcome;
  /** Spends a company seed from the wallet under the server's funding ref; false when the balance is short. Repeats are no-ops. */
  fundCompany(fundingRef: string, cents: number): boolean;
  /** Earns a payout the company booked, once; an already-claimed payout changes nothing. */
  claimPayout(payout: PendingPayout): void;
  /** Allowance hints opened today (Pro's daily free hints). */
  readonly hintsUsedToday: number;
  /** Records one allowance hint opened today. */
  spendHint(): void;
  recordWarRoom(scenario: { readonly id: string; readonly title: string }, result: Debrief, run: { readonly isTeam: boolean; readonly startedAt: number }): void;
  /** Pays salary for whole minutes of active play in the office. */
  paySalary(minutes: number): void;
  /** Takes a serving from the office pantry (logged for startup mode's costs). */
  takeFromPantry(id: ConsumableId): void;
  /** A sip or a bite: `portion` of a serving's energy or fullness. */
  consume(kind: Refuel, portion: number): void;
};

export function useShiftGame({ library, store, today: clock, now = Date.now }: GameServices): ShiftGame {
  const today = clock();
  const [progress, setProgress] = useState<Progress>(() => discardUnplayableShift(store.load(), today, library, store));
  const [practiceRound, setPracticeRound] = useState(0);
  const [screen, setScreen] = useState<Screen>({ name: "lobby" });
  const [discussion, setDiscussion] = useState<Discussion | null>(null);

  const commit = useCallback(
    (next: Progress) => {
      store.save(next);
      setProgress(next);
    },
    [store],
  );

  const openDiscussion = useCallback(
    (room: Role | null) => {
      const ownRole = progress.role ?? "infrastructure";
      const isOwnRoom = room === ownRole;
      if (isOwnRoom && !hasFinishedShift(progress, today)) {
        const active = progress.activeShift?.day === today ? progress.activeShift : null;
        const ids = active?.incidentIds ?? planShift(cardsOf(library, ownRole), today, new Set(progress.seenIds), undefined, paceOf(progress, ownRole));
        const next = active ? progress : startShift(progress, today, ids);
        commit(next);
        setDiscussion({ stage: "cards", room, paidFromSeq: next.wallet.nextSeq, run: buildRun("rated", today, ids, next.activeShift?.attempts ?? [], next, library) });
        return;
      }
      const pool = room === null ? library.cards : cardsOf(library, room);
      const ids = planShift(pool, today, new Set(progress.seenIds), practiceRound, paceOf(progress, room ?? ownRole));
      setPracticeRound((round) => round + 1);
      setDiscussion({ stage: "cards", room, paidFromSeq: progress.wallet.nextSeq, run: buildRun("practice", today, ids, [], progress, library) });
    },
    [commit, library, practiceRound, progress, today],
  );

  const answer = useCallback(
    (attempt: Attempt): number => {
      if (discussion?.stage !== "cards") return 0;
      const { run } = discussion;
      setDiscussion({ ...discussion, run: { ...run, attempts: [...run.attempts, attempt] } });
      const title = library.byId(attempt.incidentId)?.alert.title ?? attempt.topic;
      const answeredAt = now();
      const card = { kind: "card", ref: payRef.card(attempt.incidentId, answeredAt), difficulty: attempt.difficulty, mode: run.mode, title } as const;
      const paid = attempt.isCorrect ? earn(progress, card, answeredAt) : progress;
      if (run.mode === "practice") {
        if (paid !== progress) commit(paid);
        return 0;
      }
      const before = progress.ratings[attempt.topic] ?? STARTING_RATING;
      const after = rateAttempt(progress.ratings, attempt, attempt.isCorrect)[attempt.topic] ?? before;
      commit(recordAttempt(paid, attempt));
      return after - before;
    },
    [commit, discussion, library, now, progress],
  );

  const wrapUpDiscussion = useCallback(() => {
    if (discussion?.stage === "cards") setDiscussion({ ...discussion, stage: "report" });
  }, [discussion]);
  const closeDiscussion = useCallback(() => setDiscussion(null), []);
  const enterOffice = useCallback(() => setScreen({ name: "office" }), []);
  const leaveOffice = useCallback(() => {
    setDiscussion(null);
    setScreen({ name: "lobby" });
  }, []);
  const onChooseRole = useCallback((role: Role) => commit(chooseRole(progress, role)), [commit, progress]);
  // The server refuses a save that features an unearned badge, so the lobby never asks for one.
  const onFeatureBadge = useCallback(
    (badgeId: string | null) => {
      if (badgeId === null || hasEarned(progress, badgeId)) commit(featureBadge(progress, badgeId));
    },
    [commit, progress],
  );
  const recordWarRoom = useCallback(
    (scenario: { readonly id: string; readonly title: string }, result: Debrief, run: { readonly isTeam: boolean; readonly startedAt: number }) => {
      // A run closed with a bought solution counts as played, but pays nothing and teaches the ladder nothing.
      if (hasBoughtSolution(progress.wallet, { scenarioId: scenario.id, runStartedAt: run.startedAt })) {
        commit(recordAssistedRun(progress, scenario.id));
        return;
      }
      const recorded = recordWarRoomRun(progress, scenario.id, result.points, result.grade);
      const bonus = { kind: "incident", ref: payRef.incident(scenario.id, run.startedAt), points: result.points, title: scenario.title, isTeam: run.isTeam } as const;
      commit(earn(recorded, bonus, now()));
    },
    [commit, now, progress],
  );
  const spendHint = useCallback(() => commit(spendHintOn(progress, today)), [commit, progress, today]);
  const buySolution = useCallback(
    (scenario: { readonly id: string; readonly title: string; readonly tier: SolutionTier }, runStartedAt: number): SpendOutcome => {
      const purchase = { kind: "solution", scenarioId: scenario.id, runStartedAt, tier: scenario.tier, level: careerLevel(progress).level, title: scenario.title } as const;
      const outcome = spend(progress.wallet, purchase, now());
      if (outcome.ok && outcome.wallet !== progress.wallet) commit({ ...progress, wallet: outcome.wallet });
      return outcome;
    },
    [commit, now, progress],
  );
  const fundCompany = useCallback(
    (fundingRef: string, cents: number): boolean => {
      const outcome = fundCompanyFrom(progress.wallet, fundingRef, cents, now());
      if (outcome.ok && outcome.wallet !== progress.wallet) commit({ ...progress, wallet: outcome.wallet });
      return outcome.ok;
    },
    [commit, now, progress],
  );
  const claimPayout = useCallback(
    (payout: PendingPayout) => {
      const wallet = earnPayroll(progress.wallet, payout, now());
      if (wallet !== progress.wallet) commit({ ...progress, wallet });
    },
    [commit, now, progress],
  );
  const takeFromPantryNow = useCallback((id: ConsumableId) => commit(takeFromPantry(progress, id, today)), [commit, progress, today]);
  const consumeNow = useCallback((kind: Refuel, portion: number) => commit(consume(progress, kind, portion)), [commit, progress]);
  const paySalary = useCallback(
    (minutes: number) => {
      const at = now();
      // The same active minutes pay salary and wear you down, saved together.
      const paid = wearDown(earn(progress, { kind: "salary", ref: payRef.salary(at), minutes, level: careerLevel(progress).level }, at), minutes);
      if (paid !== progress) commit(paid);
    },
    [commit, now, progress],
  );

  const queuedAlerts = useMemo(() => {
    if (hasFinishedShift(progress, today)) return [];
    const role = progress.role ?? "infrastructure";
    const active = progress.activeShift?.day === today ? progress.activeShift : null;
    const ids = active?.incidentIds.slice(active.attempts.length) ?? planShift(cardsOf(library, role), today, new Set(progress.seenIds), undefined, paceOf(progress, role));
    return ids.flatMap((id) => library.byId(id)?.alert ?? []);
  }, [library, progress, today]);

  const roleCounts = useMemo(() => countByRole(library), [library]);

  return {
    screen,
    progress,
    today,
    discussion,
    queuedAlerts,
    roleCounts,
    enterOffice,
    leaveOffice,
    chooseRole: onChooseRole,
    featureBadge: onFeatureBadge,
    openDiscussion,
    answer,
    wrapUpDiscussion,
    closeDiscussion,
    recordWarRoom,
    hintsUsedToday: hintsUsedOn(progress, today),
    spendHint,
    buySolution,
    fundCompany,
    claimPayout,
    paySalary,
    takeFromPantry: takeFromPantryNow,
    consume: consumeNow,
  };
}

function countByRole(library: IncidentLibrary): Record<Role, number> {
  const counts = Object.fromEntries(ROLE_IDS.map((role) => [role, 0])) as Record<Role, number>;
  for (const card of library.cards) counts[roleOf(card.topic)] += 1;
  return counts;
}

/** Card difficulty follows your level, then your skill in that role's topics within it. */
function paceOf(progress: Progress, role: Role): Pace {
  const roleRatings = Object.fromEntries(ROLES[role].map((topic) => [topic, progress.ratings[topic] ?? STARTING_RATING]));
  return { level: careerLevel(progress).level, rating: overallRating(roleRatings) };
}

function cardsOf(library: IncidentLibrary, role: Role): readonly IncidentCard[] {
  return library.cards.filter((card) => roleOf(card.topic) === role);
}

/** A shift from another day, or one referencing cards no longer shipped, can't be resumed. */
function discardUnplayableShift(progress: Progress, today: LocalDate, library: IncidentLibrary, store: ProgressStore): Progress {
  const active = progress.activeShift;
  if (!active) return progress;
  const isPlayable = active.day === today && active.incidentIds.every((id) => library.byId(id) !== undefined);
  if (isPlayable) return progress;
  const cleaned = { ...progress, activeShift: null };
  store.save(cleaned);
  return cleaned;
}

function buildRun(
  mode: RunMode,
  day: LocalDate,
  incidentIds: readonly string[],
  attempts: readonly Attempt[],
  progress: Progress,
  library: IncidentLibrary,
): Run {
  const incidents = incidentIds.flatMap((id) => {
    const card = library.byId(id);
    return card ? [presentIncident(card, day)] : [];
  });
  return { mode, day, incidents, attempts, ratingBefore: overallRating(progress.ratings) };
}
