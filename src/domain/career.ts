import type { Progress } from "./progress.ts";

/** Job titles from first day to most senior. A level is an index into this list. */
export const TITLES = ["Intern", "Junior Engineer", "Engineer", "Senior Engineer", "Staff Engineer"] as const;

export type Level = 0 | 1 | 2 | 3 | 4;
export type Title = (typeof TITLES)[Level];

/** Experience needed for each level; a strong day of shifts is ~120. */
const LEVEL_THRESHOLDS: Readonly<Record<Level, number>> = { 0: 0, 1: 100, 2: 300, 3: 700, 4: 1400 };

const EXPERIENCE_PER_CORRECT_CARD = 10;
/** A War Room counts once its best run scored at least this (grade C): a botched fix teaches, but doesn't promote. */
const PASSING_WAR_ROOM_POINTS = 35;

/** War Rooms passed at least once: the count behind experience, badges and the profile. */
export function passedWarRooms(progress: Progress): readonly string[] {
  return Object.entries(progress.warRoom)
    .filter(([, record]) => record.bestPoints >= PASSING_WAR_ROOM_POINTS)
    .map(([scenarioId]) => scenarioId);
}

export type Career = {
  readonly level: Level;
  readonly title: Title;
  readonly experience: number;
  /** Experience at which this level began, so progress to the next can be shown. */
  readonly levelStartsAt: number;
  /** Experience at which the next promotion lands; null at the top. */
  readonly nextAt: number | null;
};

/**
 * Where a player stands, from what they've done: every correct card, and each War Room passed,
 * once, at its best score. Experience only grows, so nobody is demoted. Reads nothing but
 * `progress`, so the server can check a claimed promotion without loading any content.
 */
export function careerLevel(progress: Progress): Career {
  const passedPoints = passedWarRooms(progress).reduce((sum, scenarioId) => sum + (progress.warRoom[scenarioId]?.bestPoints ?? 0), 0);
  return careerAt(progress.correctCards * EXPERIENCE_PER_CORRECT_CARD + passedPoints);
}

export function careerAt(experience: number): Career {
  const levels = Object.keys(LEVEL_THRESHOLDS).map(Number) as Level[];
  const level = levels.reduce<Level>((reached, candidate) => (experience >= LEVEL_THRESHOLDS[candidate] ? candidate : reached), 0);
  const next = levels.find((candidate) => candidate > level);
  return { level, title: TITLES[level], experience, levelStartsAt: LEVEL_THRESHOLDS[level], nextAt: next === undefined ? null : LEVEL_THRESHOLDS[next] };
}
