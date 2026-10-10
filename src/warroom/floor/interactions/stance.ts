import type { Intent, Player } from "../player.ts";
import { DESK, seatOf, type Desk } from "../office.ts";

export const STANDING_EYE = 1.62;
export const SEATED_EYE = 1.18;
/** How far you can turn your head from the screen while sitting (radians either way). */
const LOOK_CONE = 1.25;
const PITCH_RANGE = { min: -0.95, max: 0.45 } as const;
/** Seated eyes sit a little toward the desk from the chair's centre: people lean in to read. */
const EYES_FORWARD_OF_SEAT = 0.12;
/** Standing up pushes the chair back and puts you in the aisle behind it. */
const STAND_BACK = 0.55;
/** Stick or key input above this means "I want to walk", which stands you up. */
const WALK_INTENT = 0.2;

/** Where your eyes are while sitting at `desk`, and the way the screen faces you. */
export type Seat = { readonly deskId: string; readonly x: number; readonly z: number; readonly yaw: number; readonly facing: 1 | -1 };

export type Stance = { readonly kind: "standing" } | { readonly kind: "seated"; readonly seat: Seat };

export const STANDING: Stance = { kind: "standing" };

/** Camera yaw 0 looks toward -z; a desk whose occupant faces +z wants yaw π. */
export function seatAt(desk: Desk): Seat {
  const chair = seatOf(desk);
  return { deskId: desk.id, x: chair.x, z: chair.z + desk.facing * EYES_FORWARD_OF_SEAT, yaw: desk.facing === 1 ? Math.PI : 0, facing: desk.facing };
}

/** Where the chair is (the body sits here; the eyes are a touch forward of it). */
export function chairOf(seat: Seat): { x: number; z: number } {
  return { x: seat.x, z: seat.z - seat.facing * EYES_FORWARD_OF_SEAT };
}

export function eyeHeightOf(stance: Stance): number {
  return stance.kind === "seated" ? SEATED_EYE : STANDING_EYE;
}

/** Sitting still and looking around: the head turns, within a comfortable cone around the screen. */
export function lookWhileSeated(player: Player, intent: Intent, seat: Seat): Player {
  const offset = clamp(wrapAngle(player.yaw + intent.yawDelta - seat.yaw), -LOOK_CONE, LOOK_CONE);
  const pitch = clamp(player.pitch + intent.pitchDelta, PITCH_RANGE.min, PITCH_RANGE.max);
  return { x: seat.x, z: seat.z, yaw: seat.yaw + offset, pitch };
}

/** Sitting down: eyes go to the seat, facing the monitor, gaze level. */
export function sitDown(seat: Seat): Player {
  return { x: seat.x, z: seat.z, yaw: seat.yaw, pitch: -0.12 };
}

/** Getting up: one step back from the chair, still facing the desk. */
export function standUp(seat: Seat, player: Player): Player {
  const chair = chairOf(seat);
  return { x: chair.x, z: chair.z - seat.facing * STAND_BACK, yaw: player.yaw, pitch: 0 };
}

export function wantsToWalk(intent: Intent): boolean {
  return Math.hypot(intent.forward, intent.strafe) > WALK_INTENT;
}

/** The desk's own footprint, for facing it to sit down. */
export function deskFootprint(desk: Desk) {
  return { x: desk.x, z: desk.z, width: DESK.width, depth: DESK.depth };
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
