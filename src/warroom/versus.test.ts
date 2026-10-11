import { describe, expect, it } from "vitest";
import { decide, pickTeam, type LaneStanding } from "./versus.ts";

const lane = (team: LaneStanding["team"], finish: LaneStanding["finish"]): LaneStanding => ({
  team,
  players: 1,
  phase: finish ? "closed" : "live",
  alertRate: finish ? 0 : 0.3,
  reopenCount: 0,
  finish,
});

describe("versus", () => {
  it("seats a newcomer on the smaller side, red when level, nowhere when both are full", () => {
    expect(pickTeam({ red: 0, blue: 0 })).toBe("red");
    expect(pickTeam({ red: 2, blue: 1 })).toBe("blue");
    expect(pickTeam({ red: 3, blue: 3 })).toBeNull();
  });

  it("waits while a side is still fighting and overtime hasn't run out", () => {
    expect(decide([lane("red", { points: 80, closedAt: 900 }), lane("blue", null)], false)).toBeNull();
  });

  it("gives it to the side that closed when overtime runs out on the other", () => {
    expect(decide([lane("red", null), lane("blue", { points: 40, closedAt: 1200 })], true)).toBe("blue");
  });

  it("ranks by points, then by the earlier close, and calls a dead heat a draw", () => {
    expect(decide([lane("red", { points: 70, closedAt: 800 }), lane("blue", { points: 90, closedAt: 1500 })], false)).toBe("blue");
    expect(decide([lane("red", { points: 90, closedAt: 800 }), lane("blue", { points: 90, closedAt: 1500 })], false)).toBe("red");
    expect(decide([lane("red", { points: 90, closedAt: 800 }), lane("blue", { points: 90, closedAt: 800 })], false)).toBe("draw");
  });
});
