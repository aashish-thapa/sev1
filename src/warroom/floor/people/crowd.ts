import type { Point } from "../navigation.ts";

/** Centre-to-centre distance (m) at which two people start making room for each other. */
export const PERSONAL_SPACE = 0.8;
/** Furthest a walker sidesteps off their lane, so nobody is shoved into a door frame. */
const MAX_SIDESTEP = 0.4;
/** How quickly (1/s) a sidestep is taken or given back. */
const SIDESTEP_RATE = 4;

/** Where everyone on the floor stood last frame, keyed by id. */
export type Crowd = Map<string, Point>;

/**
 * How far sideways (along the walker's right) to stand clear of everyone too close.
 * Only the lateral part is used, so people step aside instead of stalling or backing up;
 * someone dead ahead is passed on the right, matching the keep-right lanes.
 */
export function sidestepFor(id: string, at: Point, heading: number, crowd: Crowd): number {
  const right = rightOf(heading);
  let push = 0;
  for (const [otherId, other] of crowd) {
    if (otherId === id) continue;
    const awayX = at.x - other.x;
    const awayZ = at.z - other.z;
    const distance = Math.hypot(awayX, awayZ);
    if (distance >= PERSONAL_SPACE) continue;
    const overlap = PERSONAL_SPACE - distance;
    const lateral = distance === 0 ? 0 : (awayX * right.x + awayZ * right.z) / distance;
    push += overlap * (Math.abs(lateral) < 0.2 ? 1 : Math.sign(lateral));
  }
  return Math.max(-MAX_SIDESTEP, Math.min(MAX_SIDESTEP, push));
}

/** Eases the current sidestep toward `target`, frame-rate independently. */
export function easeSidestep(current: number, target: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-delta * SIDESTEP_RATE));
}

/** The right-hand unit vector for someone facing `heading` (radians, atan2(dx, dz)). */
export function rightOf(heading: number): Point {
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}
