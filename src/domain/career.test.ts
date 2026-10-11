import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLibrary } from "../content/library.ts";
import { parseLocalDate } from "./calendar.ts";
import { careerAt, careerLevel } from "./career.ts";
import { emptyProgress, recordWarRoomRun } from "./progress.ts";
import { DEFAULT_PACE, planShift, rampFor } from "./shift.ts";

describe("career ladder", () => {
  it("starts everyone as an intern with the next promotion in sight", () => {
    expect(careerLevel(emptyProgress())).toEqual({ level: 0, title: "Intern", experience: 0, levelStartsAt: 0, nextAt: 100 });
  });

  it("promotes on correct cards and passed War Rooms, and tops out at staff", () => {
    const progress = recordWarRoomRun({ ...emptyProgress(), correctCards: 25 }, "scaled-to-zero", 80, "A");
    expect(careerLevel(progress)).toMatchObject({ level: 2, title: "Engineer", experience: 330 });
    expect(careerAt(5_000)).toMatchObject({ level: 4, title: "Staff Engineer", nextAt: null });
  });

  it("gives nothing for a botched War Room, and counts each War Room once at its best", () => {
    const botched = recordWarRoomRun(emptyProgress(), "crash-on-checkout", 20, "D");
    expect(careerLevel(botched).experience).toBe(0);
    const replayed = recordWarRoomRun(recordWarRoomRun(emptyProgress(), "crash-on-checkout", 60, "B"), "crash-on-checkout", 90, "S");
    expect(careerLevel(replayed).experience).toBe(90);
  });
});

describe("shift ramp by level", () => {
  it("keeps an intern's shift easy and a staff engineer's hard", () => {
    const hard = (ramp: readonly number[]) => ramp.filter((difficulty) => difficulty === 3).length;
    expect(hard(rampFor({ level: 0, rating: 950 }))).toBe(0);
    expect(hard(rampFor({ level: 4, rating: 1200 }))).toBeGreaterThan(hard(rampFor(DEFAULT_PACE)));
  });

  it("lets the rating move a player one level up or down", () => {
    expect(rampFor({ level: 0, rating: 1100 })).toEqual(rampFor({ level: 1, rating: 1000 }));
    expect(rampFor({ level: 3, rating: 1000 })).toEqual(rampFor(DEFAULT_PACE));
  });

  it("plans an intern's real shift from easy cards, and the classic shift when no pace is given", () => {
    const packsDir = join(import.meta.dirname, "..", "content", "packs");
    const packs = Object.fromEntries(
      readdirSync(packsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [name, JSON.parse(readFileSync(join(packsDir, name), "utf8")) as unknown]),
    );
    const { cards } = createLibrary(packs, ({ message }) => {
      throw new Error(message);
    });
    const day = parseLocalDate("2026-10-10");
    const difficulty = new Map(cards.map((card) => [card.id, card.difficulty]));
    const intern = planShift(cards, day, new Set(), undefined, { level: 0, rating: 950 });
    expect(intern.filter((id) => difficulty.get(id) === 3)).toEqual([]);
    expect(planShift(cards, day, new Set())).toEqual(planShift(cards, day, new Set(), undefined, DEFAULT_PACE));
  });
});
