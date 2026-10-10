import { describe, expect, it } from "vitest";
import { accrue, IDLE_AFTER_MS, type ActivityState } from "./activity.ts";

const SAMPLE_MS = 5_000;

function play(seconds: number, sample: (at: number) => { isVisible: boolean; lastInputAt: number }): number {
  let state: ActivityState = { lastSampleAt: 0, activeMs: 0 };
  let minutes = 0;
  for (let at = SAMPLE_MS; at <= seconds * 1000; at += SAMPLE_MS) {
    const result = accrue(state, { at, ...sample(at) });
    state = result.state;
    minutes += result.minutes;
  }
  return minutes;
}

describe("accrue", () => {
  it("pays a minute per minute of active, visible play", () => {
    expect(play(5 * 60, (at) => ({ isVisible: true, lastInputAt: at }))).toBe(5);
  });

  it("stops paying once input goes quiet past the idle window", () => {
    expect(play(10 * 60, () => ({ isVisible: true, lastInputAt: 0 }))).toBe(Math.floor(IDLE_AFTER_MS / 60_000));
  });

  it("pays nothing while the tab is hidden", () => {
    expect(play(5 * 60, (at) => ({ isVisible: false, lastInputAt: at }))).toBe(0);
  });

  it("never counts a long gap such as a sleeping laptop as play", () => {
    const result = accrue({ lastSampleAt: 0, activeMs: 0 }, { at: 3_600_000, isVisible: true, lastInputAt: 3_600_000 });
    expect(result.minutes).toBe(0);
  });
});
