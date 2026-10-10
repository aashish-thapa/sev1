/**
 * A company grows up: from a garage doing easy fixes to a scale-up whose work is hard. Its level
 * comes from lifetime revenue and work days survived, never from what's in the bank, so it can't
 * be bought by a big seed or an investor.
 */

export type CompanyLevel = 1 | 2 | 3 | 4 | 5;
export type TaskDifficulty = 1 | 2 | 3;

type LevelSpec = {
  readonly level: CompanyLevel;
  readonly title: string;
  /** Lifetime revenue, in cents, and work days needed to reach this level; both must be met. */
  readonly minRevenueCents: number;
  readonly minWorkDays: number;
  /** The difficulties of daily work and interviews at this level, easiest first. */
  readonly difficulties: readonly TaskDifficulty[];
};

export const COMPANY_LEVELS: readonly LevelSpec[] = [
  { level: 1, title: "Garage", minRevenueCents: 0, minWorkDays: 0, difficulties: [1] },
  { level: 2, title: "Seed", minRevenueCents: 500_000, minWorkDays: 5, difficulties: [1, 2] },
  { level: 3, title: "Series A", minRevenueCents: 2_500_000, minWorkDays: 15, difficulties: [2] },
  { level: 4, title: "Growth", minRevenueCents: 10_000_000, minWorkDays: 40, difficulties: [2, 3] },
  { level: 5, title: "Scale", minRevenueCents: 40_000_000, minWorkDays: 90, difficulties: [3] },
];

export type CompanyStanding = {
  readonly level: CompanyLevel;
  readonly title: string;
  /** Where the next level starts, or null at the top. */
  readonly next: { readonly title: string; readonly minRevenueCents: number; readonly minWorkDays: number } | null;
};

/** The highest level whose revenue and work-day bars the company has both cleared. */
export function companyLevel(stats: { readonly lifetimeRevenueCents: number; readonly workDays: number }): CompanyStanding {
  const reached = [...COMPANY_LEVELS].reverse().find((spec) => stats.lifetimeRevenueCents >= spec.minRevenueCents && stats.workDays >= spec.minWorkDays) ?? COMPANY_LEVELS[0];
  const next = COMPANY_LEVELS.find((spec) => spec.level === reached.level + 1);
  return { level: reached.level, title: reached.title, next: next ? { title: next.title, minRevenueCents: next.minRevenueCents, minWorkDays: next.minWorkDays } : null };
}

export function difficultiesFor(level: CompanyLevel): readonly TaskDifficulty[] {
  return COMPANY_LEVELS.find((spec) => spec.level === level)?.difficulties ?? [1];
}

/**
 * Keeps the items at a level's difficulties; if the library has none there yet, falls back to the
 * hardest it has below, so a growing company always has work.
 */
export function atDifficulty<T extends { readonly difficulty: TaskDifficulty }>(items: readonly T[], allowed: readonly TaskDifficulty[]): T[] {
  const exact = items.filter((item) => allowed.includes(item.difficulty));
  if (exact.length > 0) return exact;
  const ceiling = Math.max(...allowed);
  const below = items.filter((item) => item.difficulty <= ceiling);
  const hardest = Math.max(0, ...below.map((item) => item.difficulty));
  return below.filter((item) => item.difficulty === hardest);
}
