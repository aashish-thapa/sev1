import { describe, expect, it } from "vitest";
import { BREW_SECONDS, brewProgress, CAFFEINE_SECONDS, caffeineLeft, canBrew, NO_COFFEE, settle, sip, SIPS_PER_CUP, startBrewing, walkSpeedScale } from "./coffee.ts";

describe("coffee", () => {
  it("brews for a few seconds, then puts a full cup in your hand", () => {
    const brewing = startBrewing(NO_COFFEE, 100);
    expect(settle(brewing, 100 + BREW_SECONDS / 2).cup.kind).toBe("brewing");
    expect(brewProgress(brewing, 100 + BREW_SECONDS / 2)).toBeCloseTo(0.5);
    expect(settle(brewing, 100 + BREW_SECONDS).cup).toEqual({ kind: "holding", sipsLeft: SIPS_PER_CUP });
  });

  it("won't start a second cup while you're holding one", () => {
    const holding = settle(startBrewing(NO_COFFEE, 0), BREW_SECONDS);
    expect(canBrew(holding)).toBe(false);
    expect(startBrewing(holding, 10)).toBe(holding);
  });

  it("caffeinates on every sip and empties the cup after the last one", () => {
    let coffee = settle(startBrewing(NO_COFFEE, 0), BREW_SECONDS);
    expect(walkSpeedScale(coffee, 5)).toBe(1);
    for (let index = 0; index < SIPS_PER_CUP; index += 1) coffee = sip(coffee, 10 + index);
    expect(coffee.cup.kind).toBe("none");
    expect(caffeineLeft(coffee, 13)).toBe(CAFFEINE_SECONDS);
    expect(walkSpeedScale(coffee, 13)).toBeGreaterThan(1);
    expect(walkSpeedScale(coffee, 13 + CAFFEINE_SECONDS)).toBe(1);
  });

  it("ignores sips with nothing in hand", () => {
    expect(sip(NO_COFFEE, 5)).toBe(NO_COFFEE);
  });
});
