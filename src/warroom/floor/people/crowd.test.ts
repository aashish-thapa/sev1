import { describe, expect, it } from "vitest";
import { easeSidestep, PERSONAL_SPACE, rightOf, sidestepFor, type Crowd } from "./crowd.ts";

const NORTH = Math.PI;

describe("sidestepFor", () => {
  it("leaves a walker on their lane when nobody is close", () => {
    const crowd: Crowd = new Map([["far", { x: 0, z: -PERSONAL_SPACE * 2 }]]);
    expect(sidestepFor("me", { x: 0, z: 0 }, NORTH, crowd)).toBe(0);
  });

  it("passes someone dead ahead on the right", () => {
    const crowd: Crowd = new Map([["ahead", { x: 0, z: -0.3 }]]);
    expect(sidestepFor("me", { x: 0, z: 0 }, NORTH, crowd)).toBeGreaterThan(0);
  });

  it("steps away from whichever side someone is on", () => {
    const right = rightOf(NORTH);
    const crowd: Crowd = new Map([["on-my-right", { x: right.x * 0.4, z: right.z * 0.4 }]]);
    expect(sidestepFor("me", { x: 0, z: 0 }, NORTH, crowd)).toBeLessThan(0);
  });

  it("ignores their own entry in the crowd", () => {
    const crowd: Crowd = new Map([["me", { x: 0, z: 0 }]]);
    expect(sidestepFor("me", { x: 0, z: 0 }, NORTH, crowd)).toBe(0);
  });

  it("eases toward the target without overshooting", () => {
    const eased = easeSidestep(0, 0.4, 1 / 60);
    expect(eased).toBeGreaterThan(0);
    expect(eased).toBeLessThan(0.4);
  });
});
