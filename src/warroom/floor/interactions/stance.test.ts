import { describe, expect, it } from "vitest";
import { DESKS, PLAYER_DESK, seatOf } from "../office.ts";
import { chairOf, lookWhileSeated, seatAt, sitDown, standUp, wantsToWalk } from "./stance.ts";

const still = { forward: 0, strafe: 0, yawDelta: 0, pitchDelta: 0 };

describe("sitting at a desk", () => {
  it("faces the monitor: your desk looks north (-z), so yaw 0", () => {
    expect(PLAYER_DESK.facing).toBe(-1);
    expect(seatAt(PLAYER_DESK).yaw).toBe(0);
    const south = DESKS.find((desk) => desk.facing === 1);
    expect(south && seatAt(south).yaw).toBeCloseTo(Math.PI);
  });

  it("puts the body on the chair and the eyes a little toward the desk", () => {
    const seat = seatAt(PLAYER_DESK);
    const chair = seatOf(PLAYER_DESK);
    expect(chairOf(seat)).toEqual(chair);
    expect(Math.abs(seat.z - PLAYER_DESK.z)).toBeLessThan(Math.abs(chair.z - PLAYER_DESK.z));
  });

  it("lets you look around, but only within a cone around the screen, and never walks", () => {
    const seat = seatAt(PLAYER_DESK);
    const turned = lookWhileSeated(sitDown(seat), { ...still, yawDelta: 4, pitchDelta: -3 }, seat);
    expect(turned.x).toBe(seat.x);
    expect(turned.z).toBe(seat.z);
    expect(turned.yaw - seat.yaw).toBeLessThanOrEqual(1.25 + 1e-9);
    expect(turned.pitch).toBeGreaterThanOrEqual(-0.95);
  });

  it("stands you up behind the chair, out of the desk", () => {
    const seat = seatAt(PLAYER_DESK);
    const up = standUp(seat, sitDown(seat));
    expect(Math.abs(up.z - PLAYER_DESK.z)).toBeGreaterThan(Math.abs(chairOf(seat).z - PLAYER_DESK.z));
  });

  it("treats a real push of the stick as wanting to walk, not a twitch", () => {
    expect(wantsToWalk({ ...still, forward: 1 })).toBe(true);
    expect(wantsToWalk({ ...still, strafe: 0.1 })).toBe(false);
  });
});
