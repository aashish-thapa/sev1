/**
 * What a paying player gets. Pro adds practice, comfort and looks; it never buys rank: no XP,
 * pay, promotions or leaderboard position come from anything here, and worked solutions cost
 * earned money for everyone. Pure: every rule takes the time it's asked about.
 */

/** What the server says the account holds; null for guests and anyone signed out. */
export type Entitlements = {
  /** Epoch ms the Pro subscription runs to; null if never subscribed. */
  readonly proUntil: number | null;
  readonly cosmetics: readonly string[];
};

/** Hints a Pro player may open free each day at any tier, on top of tier 1's free hints for everyone. */
export const PRO_DAILY_FREE_HINTS = 3;
/** Practice rounds at the wall screens per day once the rated shift is done; Pro has no limit. */
export const FREE_PRACTICE_ROUNDS_PER_DAY = 3;
/** How long a new War Room is Pro-only before it opens to everyone. */
export const EARLY_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

export type Perk = { readonly id: string; readonly title: string; readonly description: string };

/** The Pro perks, as the profile lists them. */
export const PRO_PERKS: readonly Perk[] = [
  { id: "practice-any", title: "Practice every War Room", description: "Play incidents above your level for practice. They don't pay or count toward promotions." },
  { id: "practice-unlimited", title: "Unlimited practice", description: `As many practice rounds as you like; free players get ${FREE_PRACTICE_ROUNDS_PER_DAY} a day.` },
  { id: "hints", title: `${PRO_DAILY_FREE_HINTS} free hints a day`, description: "At any level. Worked solutions still cost earned money, for everyone." },
  { id: "early-access", title: "Early access", description: "New incidents open to Pro a week before everyone, as practice." },
  { id: "supporter", title: "Supporter look", description: "A Pro mark by your name, and Pro-only name colours." },
];

export function isPro(entitlements: Entitlements | null, now: number): boolean {
  return entitlements?.proUntil != null && entitlements.proUntil > now;
}

/** Practice rounds still open today: unlimited (Infinity) for Pro. */
export function practiceRoundsLeft(entitlements: Entitlements | null, now: number, roundsPlayedToday: number): number {
  return isPro(entitlements, now) ? Number.POSITIVE_INFINITY : Math.max(0, FREE_PRACTICE_ROUNDS_PER_DAY - roundsPlayedToday);
}

/** Free hints left today at tiers above 1; tier 1's hints are free for everyone and never counted. */
export function freeHintsLeft(entitlements: Entitlements | null, now: number, hintsUsedToday: number): number {
  return isPro(entitlements, now) ? Math.max(0, PRO_DAILY_FREE_HINTS - hintsUsedToday) : 0;
}

/** Whether a War Room released at `releasedAt` is open to this player yet; undated ones always are. */
export function isReleasedFor(releasedAt: number | undefined, entitlements: Entitlements | null, now: number): boolean {
  if (releasedAt === undefined || now >= releasedAt + EARLY_ACCESS_MS) return true;
  return isPro(entitlements, now) && now >= releasedAt;
}
