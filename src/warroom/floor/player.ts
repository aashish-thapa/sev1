import type { Footprint } from "./layout.ts";

export type Bounds = { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };

export type Player = { readonly x: number; readonly z: number; readonly yaw: number; readonly pitch: number };

/** Movement intent: forward/strafe in -1..1, look deltas in radians. */
export type Intent = { readonly forward: number; readonly strafe: number; readonly yawDelta: number; readonly pitchDelta: number };

const WALK_SPEED = 2.6;
const BODY_RADIUS = 0.3;
const MAX_PITCH = 1.2;
const WALL_MARGIN = 0.5;

/** One frame of walking: turn, move, then slide out of any rack or wall it hit. `pace` scales the walking speed. */
export function walk(player: Player, intent: Intent, seconds: number, obstacles: readonly Footprint[], bounds?: Bounds, pace = 1): Player {
  const yaw = player.yaw + intent.yawDelta;
  const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, player.pitch + intent.pitchDelta));
  const length = Math.hypot(intent.forward, intent.strafe);
  const scale = length > 1 ? 1 / length : 1;
  const forward = intent.forward * scale * WALK_SPEED * pace * seconds;
  const strafe = intent.strafe * scale * WALK_SPEED * pace * seconds;

  // Camera looks down -z at yaw 0; strafe is perpendicular to the view direction.
  let x = player.x - Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
  let z = player.z - Math.cos(yaw) * forward - Math.sin(yaw) * strafe;

  for (const box of obstacles) [x, z] = pushOut(x, z, box);
  if (bounds) {
    x = clamp(x, bounds.minX + WALL_MARGIN, bounds.maxX - WALL_MARGIN);
    z = clamp(z, bounds.minZ + WALL_MARGIN, bounds.maxZ - WALL_MARGIN);
  }
  return { x, z, yaw, pitch };
}

/** The rack the player is facing within reach, if any. */
export function facing<T extends { footprint: Footprint }>(player: Player, racks: readonly T[], reach = 2.4): T | null {
  const lookX = -Math.sin(player.yaw);
  const lookZ = -Math.cos(player.yaw);
  let best: { rack: T; score: number } | null = null;
  for (const rack of racks) {
    const dx = rack.footprint.x - player.x;
    const dz = rack.footprint.z - player.z;
    const distance = Math.hypot(dx, dz) - Math.max(rack.footprint.width, rack.footprint.depth) / 2;
    if (distance > reach) continue;
    const alignment = (dx * lookX + dz * lookZ) / Math.max(Math.hypot(dx, dz), 0.001);
    if (alignment < 0.75) continue;
    const score = alignment * 2 - distance;
    if (!best || score > best.score) best = { rack, score };
  }
  return best?.rack ?? null;
}

function pushOut(x: number, z: number, box: Footprint): [number, number] {
  const halfWidth = box.width / 2 + BODY_RADIUS;
  const halfDepth = box.depth / 2 + BODY_RADIUS;
  const dx = x - box.x;
  const dz = z - box.z;
  if (Math.abs(dx) >= halfWidth || Math.abs(dz) >= halfDepth) return [x, z];
  const overlapX = halfWidth - Math.abs(dx);
  const overlapZ = halfDepth - Math.abs(dz);
  return overlapX < overlapZ ? [x + Math.sign(dx || 1) * overlapX, z] : [x, z + Math.sign(dz || 1) * overlapZ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
