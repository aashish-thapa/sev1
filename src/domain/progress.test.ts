import { describe, expect, it } from "vitest";
import { parseLocalDate } from "./calendar.ts";
import { isPlausibleProgress, payRef } from "./economy.ts";
import { earn, emptyProgress, ProgressSchema, recordAttempt, recordWarRoomRun, startShift, warRoomPlays, type Attempt } from "./progress.ts";

const DAY = parseLocalDate("2026-10-10");
const attempt = (incidentId: string, isCorrect: boolean): Attempt => ({ incidentId, topic: "database", difficulty: 1, isCorrect, elapsedMs: 9000 });

describe("warRoomPlays", () => {
  it("counts every finished War Room across scenarios, so solo incidents rotate", () => {
    expect(warRoomPlays(emptyProgress())).toBe(0);
    const played = recordWarRoomRun(recordWarRoomRun(recordWarRoomRun(emptyProgress(), "a", 40, "C"), "a", 80, "A"), "b", 60, "B");
    expect(warRoomPlays(played)).toBe(3);
  });
});

describe("correctCards", () => {
  it("counts each correct rated answer for life, unaffected by the history cap", () => {
    let progress = startShift(emptyProgress(), DAY, ["a", "b", "c"]);
    progress = recordAttempt(progress, attempt("a", true));
    progress = recordAttempt(progress, attempt("b", false));
    expect(progress.correctCards).toBe(1);
    progress = recordAttempt(progress, attempt("c", true));
    expect(progress.correctCards).toBe(2);
  });

  it("backfills older saves from history plus today's unfinished shift", () => {
    const legacy = JSON.parse(JSON.stringify(startShift(emptyProgress(), DAY, ["a", "b"])));
    delete legacy.correctCards;
    legacy.history = [{ day: "2026-10-08", correct: 3, total: 5 }, { day: "2026-10-09", correct: 4, total: 5 }];
    legacy.activeShift.attempts = [attempt("a", true)];
    expect(ProgressSchema.parse(legacy).correctCards).toBe(8);
  });

  it("only grows on sync by answers that were also paid for", () => {
    const before = startShift(emptyProgress(), DAY, ["a", "b"]);
    const at = Date.UTC(2026, 9, 10, 12);
    const paid = earn(before, { kind: "card", ref: payRef.card("a", at), difficulty: 1, mode: "rated", title: "a" }, at);
    expect(isPlausibleProgress(before, recordAttempt(paid, attempt("a", true)), 30)).toBe(true);
    expect(isPlausibleProgress(before, { ...before, correctCards: 500 }, 30)).toBe(false);
  });
});

describe("salary by level", () => {
  const at = Date.UTC(2026, 9, 10, 12);
  const minute = (level: 0 | 4) => earn(emptyProgress(), { kind: "salary", ref: payRef.salary(at), minutes: 1, level }, at);

  it("pays an intern less than staff for the same minute", () => {
    expect(minute(0).wallet.balanceCents).toBeLessThan(minute(4).wallet.balanceCents);
  });

  it("rejects a staff-rate salary from a player who is still an intern", () => {
    expect(isPlausibleProgress(emptyProgress(), minute(0), 90)).toBe(true);
    expect(isPlausibleProgress(emptyProgress(), minute(4), 90)).toBe(false);
  });

  it("rejects a forged War Room record that would promote without an incident payout", () => {
    const forged = { ...emptyProgress(), warRoom: { "checkout-pool-leak": { bestPoints: 100, bestGrade: "S" as const, plays: 1 } } };
    expect(isPlausibleProgress(emptyProgress(), forged, 600)).toBe(false);
  });
});
