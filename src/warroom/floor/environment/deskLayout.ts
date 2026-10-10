import { Object3D, type Matrix4 } from "three";
import { DESK, type Desk } from "../office.ts";

/** Monitor, screen and seat dimensions every workstation shares, metres. */
export const TOP_THICKNESS = 0.025;
export const MONITOR = { width: 0.62, height: 0.37, depth: 0.022, lift: 0.13, inset: 0.12 } as const;
export const SCREEN = { width: 0.6, height: 0.345 } as const;
export const SEAT_HEIGHT = 0.47;

/** Occupant-relative distance from the desk's centre to the monitor face (+ away from the occupant). */
export const MONITOR_Z = DESK.depth / 2 - MONITOR.inset;
/** Height of the middle of the monitor's screen. */
export const SCREEN_Y = DESK.height + MONITOR.lift + MONITOR.height / 2;

/** A transform in `desk`'s own frame (+x the occupant's right, +z where they look), turned into the building's. */
export function onDesk(desk: Desk, dx: number, y: number, dz: number): Matrix4 {
  const dummy = new Object3D();
  dummy.position.set(desk.x - dx * desk.facing, y, desk.z + dz * desk.facing);
  dummy.rotation.set(0, desk.facing === 1 ? 0 : Math.PI, 0);
  dummy.updateMatrix();
  return dummy.matrix.clone();
}
