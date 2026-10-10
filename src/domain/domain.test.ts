import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLibrary } from "../content/library.ts";
import { MemoryProgressStore, BrowserProgressStore } from "../storage/progress-store.ts";
import { localDateOf, parseLocalDate, previousDay } from "./calendar.ts";
import { emptyProgress, liveStreak, recordAttempt, startShift, type Attempt, type Progress } from "./progress.ts";
import { rateAttempt, STARTING_RATING } from "./rating.ts";
import { isCorrectChoice, planShift, presentIncident, SHIFT_LENGTH } from "./shift.ts";

const packsDir = join(import.meta.dirname, "..", "content", "packs");
const packs = Object.fromEntries(
  readdirSync(packsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [name, JSON.parse(readFileSync(join(packsDir, name), "utf8")) as unknown]),
);
const library = createLibrary(packs, ({ path, message }) => {
  throw new Error(`invalid pack ${path}: ${message}`);
});
const day = parseLocalDate("2026-10-10");

const attemptFor = (id: string, isCorrect: boolean): Attempt => {
  const card = library.byId(id);
  if (!card) throw new Error(`missing ${id}`);
  return { incidentId: id, topic: card.topic, difficulty: card.difficulty, isCorrect, elapsedMs: 12_000 };
};

describe("calendar", () => {
  it("steps back across month and year boundaries", () => {
    expect(previousDay(parseLocalDate("2026-03-01"))).toBe("2026-02-28");
    expect(previousDay(parseLocalDate("2027-01-01"))).toBe("2026-12-31");
  });

  it("uses the player's time zone, not UTC", () => {
    const instant = new Date("2026-10-10T02:00:00Z");
    expect(localDateOf(instant, "America/Los_Angeles")).toBe("2026-10-09");
    expect(localDateOf(instant, "Asia/Kathmandu")).toBe("2026-10-10");
  });
});

describe("shift planning", () => {
  it("gives every player the same shift on the same day", () => {
    expect(planShift(library.cards, day, new Set())).toEqual(planShift(library.cards, day, new Set()));
  });

  it("picks distinct cards and prefers ones the player has not seen", () => {
    const first = planShift(library.cards, day, new Set());
    expect(new Set(first).size).toBe(first.length);
    expect(first.length).toBe(Math.min(SHIFT_LENGTH, library.cards.length));

    const second = planShift(library.cards, day, new Set(first));
    const fresh = library.cards.length - first.length;
    const overlap = second.filter((id) => first.includes(id)).length;
    expect(overlap).toBe(Math.max(0, second.length - fresh));
  });

  it("keeps the correct answer correct after shuffling the options", () => {
    for (const card of library.cards) {
      const presented = presentIncident(card, day);
      if (presented.kind !== "diagnose" || card.kind !== "diagnose") continue;
      expect(presented.options[presented.answerIndex]).toBe(card.options[card.answer]);
      expect(isCorrectChoice(presented, { kind: "option", index: presented.answerIndex })).toBe(true);
      expect(isCorrectChoice(presented, { kind: "option", index: (presented.answerIndex + 1) % 4 })).toBe(false);
    }
  });
});

describe("rating", () => {
  it("rewards beating a hard card more than an easy one", () => {
    const easy = rateAttempt({}, { topic: "database", difficulty: 1 }, true).database ?? 0;
    const hard = rateAttempt({}, { topic: "database", difficulty: 3 }, true).database ?? 0;
    expect(hard - STARTING_RATING).toBeGreaterThan(easy - STARTING_RATING);
    expect(rateAttempt({}, { topic: "database", difficulty: 1 }, false).database).toBeLessThan(STARTING_RATING);
  });
});

describe("progress", () => {
  it("closes the shift on its last answer and extends a streak from yesterday", () => {
    const ids = planShift(library.cards, day, new Set());
    let progress: Progress = { ...emptyProgress(), streak: { count: 4, lastShiftDay: previousDay(day) } };
    progress = startShift(progress, day, ids);
    ids.forEach((id, index) => {
      progress = recordAttempt(progress, attemptFor(id, index % 3 !== 0));
    });
    expect(progress.activeShift).toBeNull();
    expect(progress.streak).toEqual({ count: 5, lastShiftDay: day });
    expect(progress.history[0]).toMatchObject({ day, total: ids.length });
    expect(liveStreak(progress, day)).toBe(5);
  });

  it("drops a streak after a missed day", () => {
    const progress: Progress = { ...emptyProgress(), streak: { count: 9, lastShiftDay: parseLocalDate("2026-10-07") } };
    expect(liveStreak(progress, day)).toBe(0);
  });
});

describe("progress stores", () => {
  it("round-trips through browser storage", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    } as unknown as Storage;
    const progress = startShift(emptyProgress(), day, ["a"]);
    new BrowserProgressStore(storage).save(progress);
    expect(new BrowserProgressStore(storage).load()).toEqual(progress);
  });

  it("survives storage that throws and corrupt JSON", () => {
    const throwing = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as Storage;
    const store = new BrowserProgressStore(throwing);
    const progress = startShift(emptyProgress(), day, ["a"]);
    store.save(progress);
    expect(store.load()).toEqual(progress);

    const corrupt = { getItem: () => "{not json", setItem: () => undefined } as unknown as Storage;
    expect(new BrowserProgressStore(corrupt).load()).toEqual(emptyProgress());
    expect(new MemoryProgressStore().load()).toEqual(emptyProgress());
  });
});
