import { useEffect, useRef } from "react";
import type { CommsMessage } from "../../scenario.ts";
import { navNode, nearestNode, positionOnPath, route, type Point } from "../navigation.ts";
import type { Person } from "../office.ts";

/** How long (simulated seconds) a colleague stays at your desk after their message. */
const VISIT_SECONDS = 60;

type Pose = { x: number; z: number; heading: number; isWalking: boolean };

/**
 * A messenger's trip: when their newest message lands, they walk from home to
 * the player, stay a while, then walk back. Paths are planned once per message.
 */
export function useVisit(person: Person, comms: readonly CommsMessage[], now: number, getPlayer: () => Point) {
  const name = person.kind === "messenger" ? person.name : null;
  const home = person.kind === "messenger" ? navNode(person.home) : { x: 0, z: 0, id: "" };
  const message = name ? ([...comms].reverse().find((item) => item.from.startsWith(name)) ?? null) : null;
  const isVisiting = message !== null && now - message.at < VISIT_SECONDS;
  const trip = useRef<{ key: string; path: Point[]; startedAt: number | null; direction: "going" | "returning" } | null>(null);
  const arrived = useRef(false);

  const key = message ? `${message.at}:${message.text}` : "";
  useEffect(() => {
    if (!name || person.kind !== "messenger") return;
    if (isVisiting) {
      const player = getPlayer();
      const towardPlayer = route(person.home, nearestNode(player).id);
      const last = towardPlayer.at(-1) ?? player;
      const reach = Math.hypot(player.x - last.x, player.z - last.z);
      // Stop at conversational distance, on the side they arrived from.
      const stand = reach > 1.7 ? { x: player.x + ((last.x - player.x) / reach) * 1.6, z: player.z + ((last.z - player.z) / reach) * 1.6 } : last;
      trip.current = { key, path: [...towardPlayer, stand], startedAt: null, direction: "going" };
      arrived.current = false;
    } else if (trip.current?.direction === "going") {
      trip.current = { ...trip.current, path: [...trip.current.path].reverse(), startedAt: null, direction: "returning" };
      arrived.current = false;
    }
  }, [getPlayer, isVisiting, key, name, person]);

  return {
    message: isVisiting ? message : null,
    /** Read per frame: true once they're standing at your desk. */
    isArrived: () => isVisiting && arrived.current,
    pose(time: number): Pose {
      const current = trip.current;
      if (!current) return { x: home.x, z: home.z, heading: Math.PI, isWalking: false };
      if (current.startedAt === null) current.startedAt = time;
      const step = positionOnPath(current.path, time - current.startedAt);
      if (!step.isWalking) {
        arrived.current = current.direction === "going";
        if (current.direction === "returning") trip.current = null;
        if (current.direction === "going") {
          const player = getPlayer();
          return { x: step.x, z: step.z, heading: Math.atan2(player.x - step.x, player.z - step.z), isWalking: false };
        }
      }
      return step;
    },
  };
}
