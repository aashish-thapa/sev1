/** Where a looping colleague is, and what they're carrying, at any moment. Pure: time in, pose out. */
import { positionOnLoop, type Loop, type LoopPose } from "../navigation.ts";
import type { Carried, Person } from "../office.ts";

type Walker = Extract<Person, { kind: "walker" }>;

/** Walkers start their loops this many seconds apart per offset step, so they don't move in lockstep. */
const STAGGER_SECONDS = 7;

export function walkerPose(walker: Walker, loop: Loop, seconds: number): LoopPose {
  return positionOnLoop(loop, seconds + walker.offset * STAGGER_SECONDS);
}

/** Picked up when they leave the pantry stop, put down when they leave the stop after it. */
export function carriedAt(walker: Walker, pose: LoopPose): Carried | null {
  const carries = walker.carries;
  if (!carries) return null;
  const from = walker.stops.findIndex((stop) => stop.node === carries.from);
  if (from < 0) return null;
  const next = (from + 1) % walker.stops.length;
  const isCarrying = (pose.lastStop === from && pose.isWalking) || (pose.lastStop === next && !pose.isWalking);
  return isCarrying ? carries.item : null;
}

/** Standing at the pantry stop itself: at the machine or the shelf, getting the thing. */
export function isAtPantry(walker: Walker, pose: LoopPose): boolean {
  const carries = walker.carries;
  return !!carries && !pose.isWalking && walker.stops[pose.lastStop]?.node === carries.from;
}
