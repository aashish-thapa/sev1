import { describe, expect, it } from "vitest";
import { LANE_OFFSET, loopThrough, positionOnLoop, positionOnPath, walkingPath } from "./navigation.ts";

describe("keep-right lanes", () => {
  it("puts people walking opposite ways along a corridor on opposite sides of it", () => {
    const loop = loopThrough([
      { node: "corridor:-15.5", pause: 0 },
      { node: "corridor:4.5", pause: 0 },
    ]);
    const eastbound = positionOnLoop(loop, 4);
    const westbound = positionOnLoop(loop, loop.duration / 2 + 4);
    expect(Math.abs(eastbound.z - westbound.z)).toBeCloseTo(LANE_OFFSET * 2, 5);
  });

  it("still pauses at each stop", () => {
    const loop = loopThrough([
      { node: "mid:-10.5", pause: 4 },
      { node: "kitchen:coffee", pause: 7 },
    ]);
    expect(loop.pauses.reduce((sum, pause) => sum + pause, 0)).toBe(11);
    expect(positionOnLoop(loop, 2).isWalking).toBe(false);
  });

  it("starts and ends a one-way walk exactly where asked, and takes the other lane back", () => {
    const centreline = [
      { x: 0, z: 0 },
      { x: 5, z: 0 },
      { x: 5, z: 5 },
    ];
    const there = walkingPath(centreline);
    const back = walkingPath([...centreline].reverse());
    expect(there[0]).toEqual(centreline[0]);
    expect(there.at(-1)).toEqual(centreline[2]);
    const goingAt = positionOnPath(there, 2);
    const returningAt = positionOnPath(back, (5 + 5) / 1.25 - 2);
    expect(Math.abs(goingAt.z - returningAt.z)).toBeGreaterThan(LANE_OFFSET);
  });
});
