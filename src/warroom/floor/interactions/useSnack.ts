import { useCallback, useMemo, useRef, useState } from "react";
import { useWellbeing } from "../../../app/wellbeing-context.ts";
import { getAudio, snackBite } from "../../../audio/index.ts";
import { FURNITURE } from "../office.ts";
import { bite as biteFrom, BITES_PER_SNACK, grab, NO_SNACK, snackAt, type Snack } from "./snack.ts";
import type { Usable } from "./usable.ts";

const SHELF = FURNITURE.find((item) => item.kind === "snacks");

type Options = {
  /** Only with an empty hand: no snack while you're carrying coffee. */
  isHandFree: () => boolean;
  /** The last bite: the wrapper or core goes on your desk. */
  onFinished: (snack: Extract<Snack, { kind: "holding" }>["item"]) => void;
};

/** The kitchen snack shelf and the snack in your hand; each bite gives back some fullness. */
export function useSnack({ isHandFree, onFinished }: Options) {
  const { takeFromPantry, consume } = useWellbeing();
  const [snack, setSnack] = useState<Snack>(NO_SNACK);
  const snackRef = useRef(snack);
  const turn = useRef(0);

  const update = useCallback((next: Snack) => {
    snackRef.current = next;
    setSnack(next);
  }, []);

  const take = useCallback(() => {
    if (snackRef.current.kind !== "none" || !isHandFree()) return;
    const item = snackAt(turn.current);
    turn.current += 1;
    update(grab(item));
    takeFromPantry(item);
  }, [isHandFree, takeFromPantry, update]);

  const bite = useCallback(() => {
    const current = snackRef.current;
    if (current.kind !== "holding") return;
    update(biteFrom(current));
    consume("snack", 1 / BITES_PER_SNACK);
    snackBite(getAudio().engine);
    if (current.bitesLeft === 1) onFinished(current.item);
  }, [consume, onFinished, update]);

  const usables = useMemo<Usable[]>(
    () => (SHELF && snack.kind === "none" ? [{ key: "snacks", footprint: SHELF.footprint, verb: "Grab", label: "a snack", use: take }] : []),
    [snack.kind, take],
  );

  return { snack, usables, bite };
}
