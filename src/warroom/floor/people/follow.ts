/** Smooths a body toward positions that arrive in bursts (network presence, the player rig) and measures its real ground speed. */

export type Follower = { readonly x: number; readonly z: number; readonly speed: number };

/** How quickly the body closes the gap to its latest reported position, per second. */
const CATCH_UP_RATE = 10;
/** How quickly the measured speed responds, per second; slower than catch-up so bursts read as one steady walk. */
const SPEED_RESPONSE = 6;

export function follow(body: Follower, target: { readonly x: number; readonly z: number }, seconds: number): Follower {
  if (seconds <= 0) return body;
  const ease = 1 - Math.exp(-seconds * CATCH_UP_RATE);
  const stepX = (target.x - body.x) * ease;
  const stepZ = (target.z - body.z) * ease;
  const instant = Math.hypot(stepX, stepZ) / seconds;
  return { x: body.x + stepX, z: body.z + stepZ, speed: body.speed + (instant - body.speed) * Math.min(1, seconds * SPEED_RESPONSE) };
}

/** Below this ground speed (m/s) a body reads as standing, not shuffling. */
export const STILL_SPEED = 0.15;
