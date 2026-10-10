import { describe, expect, it } from "vitest";
import { DESKS } from "../office.ts";
import { hasPresenceChanged, presenceOf } from "./presence.ts";
import { chairOf, seatAt, STANDING } from "./stance.ts";

const player = { x: 1, z: 2, yaw: 0.4, pitch: 0 };

describe("presenceOf", () => {
  it("reports a standing player where they are, laptop flag included", () => {
    expect(presenceOf(player, STANDING, true)).toEqual({ x: 1, z: 2, yaw: 0.4, stance: "standing", isOnLaptop: true });
  });

  it("reports a seated player at the chair, facing the desk whatever they glance at", () => {
    const seat = seatAt(DESKS[0]);
    const presence = presenceOf({ ...player, yaw: seat.yaw + 0.5 }, { kind: "seated", seat }, false);
    expect(presence).toMatchObject({ ...chairOf(seat), yaw: seat.yaw, stance: "seated" });
  });
});

describe("hasPresenceChanged", () => {
  const still = presenceOf(player, STANDING, false);
  it("ignores jitter but notices the laptop opening or a step", () => {
    expect(hasPresenceChanged(still, { ...still, x: still.x + 0.001 })).toBe(false);
    expect(hasPresenceChanged(still, { ...still, isOnLaptop: true })).toBe(true);
    expect(hasPresenceChanged(still, { ...still, x: still.x + 0.5 })).toBe(true);
    expect(hasPresenceChanged(null, still)).toBe(true);
  });
});
