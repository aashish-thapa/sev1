import { describe, expect, it } from "vitest";
import { EARLY_ACCESS_MS, FREE_PRACTICE_ROUNDS_PER_DAY, freeHintsLeft, isPro, isReleasedFor, practiceRoundsLeft, PRO_DAILY_FREE_HINTS } from "./entitlements.ts";

const NOW = 1_800_000_000_000;
const pro = { proUntil: NOW + 1_000, cosmetics: [] };
const lapsed = { proUntil: NOW - 1, cosmetics: [] };
const free = { proUntil: null, cosmetics: [] };

describe("entitlements", () => {
  it("is Pro only while the subscription runs", () => {
    expect(isPro(pro, NOW)).toBe(true);
    expect(isPro(lapsed, NOW)).toBe(false);
    expect(isPro(free, NOW)).toBe(false);
    expect(isPro(null, NOW)).toBe(false);
  });

  it("caps practice rounds for free players and not for Pro", () => {
    expect(practiceRoundsLeft(free, NOW, 0)).toBe(FREE_PRACTICE_ROUNDS_PER_DAY);
    expect(practiceRoundsLeft(free, NOW, FREE_PRACTICE_ROUNDS_PER_DAY + 2)).toBe(0);
    expect(practiceRoundsLeft(pro, NOW, 50)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives Pro a few free hints a day and everyone else none beyond tier 1", () => {
    expect(freeHintsLeft(pro, NOW, 0)).toBe(PRO_DAILY_FREE_HINTS);
    expect(freeHintsLeft(pro, NOW, PRO_DAILY_FREE_HINTS)).toBe(0);
    expect(freeHintsLeft(free, NOW, 0)).toBe(0);
    expect(freeHintsLeft(lapsed, NOW, 0)).toBe(0);
  });

  it("opens a new War Room to Pro at release and to everyone a week later", () => {
    const releasedAt = NOW - 1_000;
    expect(isReleasedFor(releasedAt, pro, NOW)).toBe(true);
    expect(isReleasedFor(releasedAt, free, NOW)).toBe(false);
    expect(isReleasedFor(releasedAt, free, releasedAt + EARLY_ACCESS_MS)).toBe(true);
    expect(isReleasedFor(NOW + 1_000, pro, NOW)).toBe(false);
    expect(isReleasedFor(undefined, null, NOW)).toBe(true);
  });
});
