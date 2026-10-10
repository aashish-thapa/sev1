import { describe, expect, it } from "vitest";
import { BADGES, badgeById, badgeStandings, featuredBadge, hasEarned } from "./achievements.ts";
import { emptyProgress, featureBadge, recordWarRoomRun, type Progress } from "./progress.ts";

const veteran = (): Progress => {
  let progress: Progress = { ...emptyProgress(), correctCards: 120, bestStreak: 8 };
  progress = recordWarRoomRun(progress, "scaled-to-zero", 92, "S");
  progress = recordWarRoomRun(progress, "crash-on-checkout", 60, "B");
  return progress;
};

describe("badges", () => {
  it("has unique ids and a positive target for every badge", () => {
    expect(new Set(BADGES.map((badge) => badge.id)).size).toBe(BADGES.length);
    for (const badge of BADGES) expect(badge.target).toBeGreaterThan(0);
  });

  it("starts a new player with nothing earned and progress toward every badge", () => {
    const standings = badgeStandings(emptyProgress());
    expect(standings.every((standing) => !standing.isEarned && standing.current === 0)).toBe(true);
  });

  it("awards badges from correct calls, best streak, passed and top-graded War Rooms", () => {
    const earned = badgeStandings(veteran())
      .filter((standing) => standing.isEarned)
      .map((standing) => standing.badge.id);
    expect(earned).toEqual(expect.arrayContaining(["calls-1", "calls-100", "streak-3", "streak-7", "resolve-1", "grade-s"]));
    expect(earned).not.toContain("calls-500");
    expect(earned).not.toContain("resolve-3");
  });

  it("caps progress at the target, so a bar never overflows", () => {
    const standing = badgeStandings(veteran()).find((entry) => entry.badge.id === "calls-1");
    expect(standing?.current).toBe(1);
  });

  it("doesn't count a botched War Room as passed", () => {
    const botched = recordWarRoomRun(emptyProgress(), "checkout-meltdown", 20, "D");
    expect(hasEarned(botched, "resolve-1")).toBe(false);
    expect(hasEarned(botched, "resolve-meltdown")).toBe(false);
  });

  it("shows a featured badge only while it's earned and in the catalog", () => {
    expect(featuredBadge(featureBadge(veteran(), "streak-7"))?.title).toBe("A week on call");
    expect(featuredBadge(featureBadge(veteran(), "calls-500"))).toBeNull();
    expect(featuredBadge(featureBadge(veteran(), "not-a-badge"))).toBeNull();
    expect(badgeById("not-a-badge")).toBeUndefined();
  });
});
