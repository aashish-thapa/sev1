import type { Carried } from "../office.ts";
import type { Player } from "../player.ts";
import { chairOf, type Stance } from "./stance.ts";

/** What teammates see of you: where your body is, which way it faces, and what you're doing. */
export type PlayerPresence = {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly stance: "standing" | "seated";
  readonly isOnLaptop: boolean;
  readonly holding: Carried | null;
};

/** Seated, your body is in the chair facing the desk — not where your eyes are, nor where you're glancing. */
export function presenceOf(player: Player, stance: Stance, isOnLaptop: boolean, holding: Carried | null = null): PlayerPresence {
  if (stance.kind === "seated") {
    const chair = chairOf(stance.seat);
    return { x: chair.x, z: chair.z, yaw: stance.seat.yaw, stance: "seated", isOnLaptop, holding };
  }
  return { x: player.x, z: player.z, yaw: player.yaw, stance: "standing", isOnLaptop, holding };
}

/** Worth sending again: moved a centimetre, turned a little, sat or stood, opened or closed the laptop. */
export function hasPresenceChanged(previous: PlayerPresence | null, next: PlayerPresence): boolean {
  if (!previous) return true;
  return (
    previous.stance !== next.stance ||
    previous.isOnLaptop !== next.isOnLaptop ||
    previous.holding !== next.holding ||
    Math.hypot(next.x - previous.x, next.z - previous.z) > 0.01 ||
    Math.abs(next.yaw - previous.yaw) > 0.01
  );
}
