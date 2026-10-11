import { describe, expect, it } from "vitest";
import { ROLE_IDS } from "../domain/incident.ts";
import { seededRandom } from "../domain/random.ts";
import { isUnlocked, randomMatchScenario, TEAM_SCENARIO, unlockedWarRooms } from "./scenarios/index.ts";

const LEVELS = [0, 1, 2, 3, 4] as const;

describe("random match scenario", () => {
  it.each(ROLE_IDS)("picks %s's hardest unlocked rung, never the cross-team incident", (role) => {
    for (const level of LEVELS) {
      const ladder = unlockedWarRooms(role, level).filter((scenario) => scenario !== TEAM_SCENARIO);
      const hardest = Math.max(...ladder.map((scenario) => scenario.tier));
      for (const seed of ["a", "b", "c", "d"]) {
        const picked = randomMatchScenario(role, level, seededRandom(seed));
        if (ladder.length === 0) {
          expect(picked).toBeNull();
          continue;
        }
        expect(picked).not.toBe(TEAM_SCENARIO);
        expect(picked && isUnlocked(picked, level)).toBe(true);
        expect(picked?.tier).toBe(hardest);
      }
    }
  });

  it.each(ROLE_IDS)("has a match for %s from the first day", (role) => {
    expect(randomMatchScenario(role, 0, seededRandom("day-one"))).not.toBeNull();
  });

  it("spreads its picks across the rung", () => {
    const picks = new Set(Array.from({ length: 40 }, (_, index) => randomMatchScenario("infrastructure", 0, seededRandom(`s${index}`))?.id));
    expect(picks.size).toBeGreaterThan(1);
  });
});
