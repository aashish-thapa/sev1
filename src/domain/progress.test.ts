import { describe, expect, it } from "vitest";
import { parseLocalDate } from "./calendar.ts";
import { isPlausibleProgress } from "./audit.ts";
import { payRef } from "./economy.ts";
import { earn, emptyProgress, hasDiscussedOn, hintsUsedOn, ProgressSchema, recordAssistedRun, spendHint, recordAttempt, recordWarRoomRun, startShift, warRoomPlays, type Attempt } from "./progress.ts";

const DAY = parseLocalDate("2026-10-10");
const attempt = (incidentId: string, isCorrect: boolean): Attempt => ({ incidentId, topic: "database", difficulty: 1, isCorrect, elapsedMs: 9000 });

describe("warRoomPlays", () => {
  it("counts every finished War Room across scenarios, so solo incidents rotate", () => {
    expect(warRoomPlays(emptyProgress())).toBe(0);
    const played = recordWarRoomRun(recordWarRoomRun(recordWarRoomRun(emptyProgress(), "a", 40, "C"), "a", 80, "A"), "b", 60, "B");
    expect(warRoomPlays(played)).toBe(3);
  });
});

describe("hasDiscussedOn", () => {
  it("needs one answered card that day, in an open or a finished shift", () => {
    const started = startShift(emptyProgress(), DAY, ["a", "b"]);
    expect(hasDiscussedOn(started, DAY)).toBe(false);
    const answered = recordAttempt(started, attempt("a", false));
    expect(hasDiscussedOn(answered, DAY)).toBe(true);
    const finished = recordAttempt(answered, attempt("b", true));
    expect(hasDiscussedOn(finished, DAY)).toBe(true);
    expect(hasDiscussedOn(finished, "2026-10-11")).toBe(false);
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

describe("recordAssistedRun", () => {
  it("counts the play but never raises the best score, so it earns no experience", () => {
    const passed = recordWarRoomRun(emptyProgress(), "scaled-to-zero", 70, "B");
    const assisted = recordAssistedRun(passed, "scaled-to-zero");
    expect(assisted.warRoom["scaled-to-zero"]).toEqual({ bestPoints: 70, bestGrade: "B", plays: 2 });
    expect(recordAssistedRun(emptyProgress(), "x").warRoom.x?.bestPoints).toBe(0);
  });
});

describe("bestStreak", () => {
  it("keeps the longest streak after the current one resets", () => {
    let progress = emptyProgress();
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-07"]) {
      progress = recordAttempt(startShift(progress, parseLocalDate(day), ["a"]), attempt("a", true));
    }
    expect(progress.streak.count).toBe(1);
    expect(progress.bestStreak).toBe(3);
  });

  it("backfills older saves from the current streak", () => {
    const legacy = JSON.parse(JSON.stringify({ ...emptyProgress(), streak: { count: 4, lastShiftDay: "2026-10-09" } }));
    delete legacy.bestStreak;
    delete legacy.featuredBadge;
    const parsed = ProgressSchema.parse(legacy);
    expect(parsed.bestStreak).toBe(4);
    expect(parsed.featuredBadge).toBeNull();
  });
});

describe("hintsUsed", () => {
  it("counts allowance hints per day and starts fresh the next day", () => {
    const today = parseLocalDate("2026-10-10");
    const tomorrow = parseLocalDate("2026-10-11");
    const used = spendHint(spendHint(emptyProgress(), today), today);
    expect(hintsUsedOn(used, today)).toBe(2);
    expect(hintsUsedOn(used, tomorrow)).toBe(0);
    expect(hintsUsedOn(spendHint(used, tomorrow), tomorrow)).toBe(1);
  });
});

describe("first saves carrying older correct answers", () => {
  it("accepts correct cards from before cards paid, up to what the save's own history shows, and names what it refuses", async () => {
    const { progressProblem } = await import("./audit.ts");
    const legacy = { ...emptyProgress(), correctCards: 12, history: [{ day: parseLocalDate("2026-10-08"), correct: 7, total: 10 }, { day: parseLocalDate("2026-10-09"), correct: 5, total: 10 }] };
    expect(progressProblem(emptyProgress(), legacy, 3600)).toBeNull();
    expect(progressProblem(emptyProgress(), { ...legacy, correctCards: 40 }, 3600)).toBe("correct_cards_unpaid");
    // Once the account holds a copy, new correct answers must be paid for again.
    expect(progressProblem(legacy, { ...legacy, correctCards: 13, wallet: { ...legacy.wallet, nextSeq: 1 } }, 3600)).not.toBeNull();
  });
});

describe("the player's look", () => {
  it("defaults older saves, keeps a choice, and lets a retired body fall back rather than spoil the save", async () => {
    const { chooseLook, ProgressSchema } = await import("./progress.ts");
    const { isPlausibleProgress } = await import("./audit.ts");
    const { look: _look, ...older } = emptyProgress();
    expect(ProgressSchema.parse(older).look).toEqual({ avatar: null, pose: "idle" });

    const chosen = chooseLook(emptyProgress(), { avatar: "Female_Adult_05", pose: "phone" });
    expect(ProgressSchema.parse(JSON.parse(JSON.stringify(chosen))).look).toEqual({ avatar: "Female_Adult_05", pose: "phone" });
    expect(ProgressSchema.parse({ ...chosen, look: { avatar: "Robot_01", pose: "dance" } }).look).toEqual({ avatar: null, pose: "idle" });
    // Cosmetic: changing it is always an honest save.
    expect(isPlausibleProgress(emptyProgress(), chosen, 0)).toBe(true);
  });
});
