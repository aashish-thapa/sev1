import { passedWarRooms } from "./career.ts";
import type { Progress } from "./progress.ts";

/** How rare a badge is, from the first week's to a long career's. */
export type BadgeTier = "bronze" | "silver" | "gold";

export type Badge = {
  /** Stable: saved as a player's featured badge and sent to rooms. */
  readonly id: string;
  readonly title: string;
  /** How to earn it, in the player's words. */
  readonly description: string;
  /** One or two characters drawn next to a name: one per family, so the shelf reads at a glance. */
  readonly glyph: string;
  readonly tier: BadgeTier;
  readonly target: number;
  /** Where the player stands toward `target`. Only reads counts that never go down, so a badge, once earned, stays. */
  readonly measure: (progress: Progress) => number;
};

export type BadgeStanding = { readonly badge: Badge; readonly current: number; readonly isEarned: boolean };

const passedCount = (progress: Progress) => passedWarRooms(progress).length;
const topGrades = (progress: Progress) => Object.values(progress.warRoom).filter((record) => record.bestGrade === "S").length;
/** Money earned by playing; admin grants (test money) never count toward a badge. */
const lifetimeDollars = (progress: Progress) =>
  Math.floor(
    Object.entries(progress.wallet.earnedCents)
      .filter(([reason]) => reason !== "grant")
      .reduce((sum, [, cents]) => sum + cents, 0) / 100,
  );
const hasPassed = (scenarioId: string) => (progress: Progress) => (passedWarRooms(progress).includes(scenarioId) ? 1 : 0);

/** Ordered as the shelf shows them: by family, then easiest first. */
export const BADGES: readonly Badge[] = [
  { id: "calls-1", title: "First call", description: "Make your first correct call at a wall screen.", glyph: "✓", tier: "bronze", target: 1, measure: (p) => p.correctCards },
  { id: "calls-100", title: "Seasoned", description: "Make 100 correct calls.", glyph: "✓", tier: "silver", target: 100, measure: (p) => p.correctCards },
  { id: "calls-500", title: "Oracle", description: "Make 500 correct calls.", glyph: "✓", tier: "gold", target: 500, measure: (p) => p.correctCards },

  { id: "streak-3", title: "Three nights", description: "Finish your daily shift three days in a row.", glyph: "↻", tier: "bronze", target: 3, measure: (p) => p.bestStreak },
  { id: "streak-7", title: "A week on call", description: "Finish your daily shift seven days in a row.", glyph: "↻", tier: "silver", target: 7, measure: (p) => p.bestStreak },
  { id: "streak-30", title: "A month on call", description: "Finish your daily shift thirty days in a row.", glyph: "↻", tier: "gold", target: 30, measure: (p) => p.bestStreak },

  { id: "resolve-1", title: "First resolve", description: "Close a War Room with grade C or better.", glyph: "⚑", tier: "bronze", target: 1, measure: passedCount },
  { id: "resolve-3", title: "Firefighter", description: "Pass three different War Rooms.", glyph: "⚑", tier: "silver", target: 3, measure: passedCount },
  { id: "resolve-meltdown", title: "Meltdown survivor", description: "Pass Checkout meltdown, the five-role incident.", glyph: "⚑", tier: "gold", target: 1, measure: hasPassed("checkout-meltdown") },

  { id: "grade-s", title: "Clean resolve", description: "Close a War Room with grade S.", glyph: "★", tier: "silver", target: 1, measure: topGrades },
  { id: "grade-s-3", title: "Textbook", description: "Earn grade S in three different War Rooms.", glyph: "★", tier: "gold", target: 3, measure: topGrades },

  { id: "earned-100", title: "First paycheck", description: "Earn $100 in total.", glyph: "$", tier: "bronze", target: 100, measure: lifetimeDollars },
  { id: "earned-1000", title: "Overtime", description: "Earn $1,000 in total.", glyph: "$", tier: "silver", target: 1_000, measure: lifetimeDollars },
  { id: "earned-10000", title: "Golden handcuffs", description: "Earn $10,000 in total.", glyph: "$", tier: "gold", target: 10_000, measure: lifetimeDollars },
];

/** Every badge, in catalog order, with how close the player is to it. */
export function badgeStandings(progress: Progress): BadgeStanding[] {
  return BADGES.map((badge) => {
    const current = Math.min(badge.target, Math.max(0, badge.measure(progress)));
    return { badge, current, isEarned: current >= badge.target };
  });
}

/** Whether the player holds badge `id`; the server checks a saved featured badge with this. */
export function hasEarned(progress: Progress, id: string): boolean {
  const badge = badgeById(id);
  return badge !== undefined && badge.measure(progress) >= badge.target;
}

export function badgeById(id: string): Badge | undefined {
  return BADGES.find((badge) => badge.id === id);
}

/** The badge a player shows by their name, if they chose one and still hold it. */
export function featuredBadge(progress: Progress): Badge | null {
  const id = progress.featuredBadge;
  return id && hasEarned(progress, id) ? (badgeById(id) ?? null) : null;
}
