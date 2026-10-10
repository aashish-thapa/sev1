import { describe, expect, it } from "vitest";
import { consumableById, EMPTY_PANTRY, PANTRY_DAYS, pantryCostCents, pantryCostOn, recordTaken, SNACKS } from "./pantry.ts";

describe("pantry log", () => {
  it("counts servings per day and for life", () => {
    let log = recordTaken(EMPTY_PANTRY, "coffee", "2026-10-10");
    log = recordTaken(log, "coffee", "2026-10-10");
    log = recordTaken(log, "apple", "2026-10-11");
    expect(log.lifetime).toEqual({ coffee: 2, apple: 1 });
    expect(log.days).toEqual([
      { day: "2026-10-11", taken: { apple: 1 } },
      { day: "2026-10-10", taken: { coffee: 2 } },
    ]);
  });

  it("keeps only the last PANTRY_DAYS days, newest first", () => {
    let log = EMPTY_PANTRY;
    for (let day = 1; day <= PANTRY_DAYS + 5; day += 1) log = recordTaken(log, "chips", `2026-01-${String(day).padStart(2, "0")}`);
    expect(log.days).toHaveLength(PANTRY_DAYS);
    expect(log.days[0].day).toBe(`2026-01-${PANTRY_DAYS + 5}`);
    expect(log.lifetime.chips).toBe(PANTRY_DAYS + 5);
  });

  it("prices servings for startup mode's operating cost", () => {
    expect(pantryCostCents({ coffee: 2, apple: 1 })).toBe(2 * 85 + 60);
    expect(SNACKS).toEqual(["granola-bar", "apple", "chips"]);
  });
});

describe("pantryCostOn", () => {
  it("prices one day's servings and nothing for a day without any", () => {
    const log = recordTaken(recordTaken(EMPTY_PANTRY, "coffee", "2026-10-10"), "apple", "2026-10-10");
    expect(pantryCostOn(log, "2026-10-10")).toBe(consumableById("coffee").unitCostCents + consumableById("apple").unitCostCents);
    expect(pantryCostOn(log, "2026-10-09")).toBe(0);
  });
});
