import { useCallback, useMemo, useRef, useState } from "react";
import { chairCreak, getAudio } from "../../../audio/index.ts";
import { PEOPLE, type Desk } from "../office.ts";
import type { Player } from "../player.ts";
import { deskFootprint, seatAt, sitDown, STANDING, standUp, type Stance } from "./stance.ts";
import type { Usable } from "./usable.ts";

const OCCUPIED = new Set(PEOPLE.flatMap((person) => (person.kind === "seated" ? [person.desk.id] : [])));

/** Desks nobody else is sitting at; yours is always free. Without colleagues every desk is. */
export function freeDesks(desks: readonly Desk[], hasColleagues: boolean): Desk[] {
  return hasColleagues ? desks.filter((desk) => !OCCUPIED.has(desk.id)) : [...desks];
}

/**
 * Sitting down and getting up. The rig reads `stance` and takes any `teleport` each frame;
 * everything else (the prompt, your body) follows the React state.
 */
export function useSeating(getPlayer: () => Player, free: readonly Desk[], myDesk: Desk) {
  const [stance, setStance] = useState<Stance>(STANDING);
  const stanceRef = useRef<Stance>(STANDING);
  const teleport = useRef<Player | null>(null);

  const change = useCallback((next: Stance, to: Player) => {
    stanceRef.current = next;
    teleport.current = to;
    setStance(next);
    chairCreak(getAudio().engine);
  }, []);

  const sit = useCallback(
    (desk: Desk) => {
      if (stanceRef.current.kind === "seated") return;
      const seat = seatAt(desk);
      change({ kind: "seated", seat }, sitDown(seat));
    },
    [change],
  );
  const stand = useCallback(() => {
    const current = stanceRef.current;
    if (current.kind !== "seated") return;
    change(STANDING, standUp(current.seat, getPlayer()));
  }, [change, getPlayer]);

  const usables = useMemo<Usable[]>(
    () =>
      free.map((desk) => ({
        key: `desk:${desk.id}`,
        footprint: deskFootprint(desk),
        verb: "Sit at",
        label: desk.id === myDesk.id ? "your desk" : "a free desk",
        use: () => sit(desk),
      })),
    [free, myDesk.id, sit],
  );
  const standUsable = useMemo<Usable | null>(
    () => (stance.kind === "seated" ? { key: "stand", footprint: { x: stance.seat.x, z: stance.seat.z, width: 0, depth: 0 }, verb: "Stand up", label: "", use: stand } : null),
    [stance, stand],
  );

  return {
    stance,
    usables: stance.kind === "seated" ? [] : usables,
    standUsable,
    stand,
    readStance: useCallback(() => stanceRef.current, []),
    takeTeleport: useCallback(() => {
      const next = teleport.current;
      teleport.current = null;
      return next;
    }, []),
  };
}
