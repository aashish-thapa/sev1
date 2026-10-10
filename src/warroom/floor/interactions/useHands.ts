import { useCallback, useEffect, useMemo, useRef } from "react";
import { useWellbeing } from "../../../app/wellbeing-context.ts";
import { lookScaleOf, walkScaleOf } from "../../../domain/wellbeing.ts";
import { NO_COFFEE, type Coffee } from "./coffee.ts";
import { NO_SNACK, type Snack } from "./snack.ts";
import { useCoffee } from "./useCoffee.ts";
import { useLeftovers } from "./useLeftovers.ts";
import { useSnack } from "./useSnack.ts";
import type { Usable } from "./usable.ts";

/**
 * What's in your hand: one coffee or one snack at a time, from the kitchen to your mouth, with
 * what's left over going on your desk. Also how your energy and fullness steer your step and gaze.
 */
export function useHands() {
  const { wellbeing } = useWellbeing();
  const { leftovers, leave } = useLeftovers();
  const coffeeNow = useRef<Coffee>(NO_COFFEE);
  const snackNow = useRef<Snack>(NO_SNACK);
  const wellbeingNow = useRef(wellbeing);

  const coffee = useCoffee({
    isHandFree: useCallback(() => snackNow.current.kind === "none", []),
    onFinished: useCallback(() => leave({ kind: "cup" }), [leave]),
  });
  const snack = useSnack({
    isHandFree: useCallback(() => coffeeNow.current.cup.kind === "none", []),
    onFinished: useCallback((item) => leave({ kind: "wrapper", item }), [leave]),
  });

  useEffect(() => {
    coffeeNow.current = coffee.coffee;
    snackNow.current = snack.snack;
    wellbeingNow.current = wellbeing;
  }, [coffee.coffee, snack.snack, wellbeing]);

  const isHoldingCoffee = coffee.coffee.cup.kind !== "none";
  const isHoldingSnack = snack.snack.kind !== "none";
  const usables = useMemo<Usable[]>(
    () => [...(isHoldingSnack ? [] : coffee.usables), ...(isHoldingCoffee ? [] : snack.usables)],
    [coffee.usables, isHoldingCoffee, isHoldingSnack, snack.usables],
  );

  /** C: a sip of the coffee or a bite of the snack, whichever you're holding. */
  const consume = useCallback(() => {
    if (coffeeNow.current.cup.kind === "holding") coffee.sip();
    else if (snackNow.current.kind === "holding") snack.bite();
  }, [coffee, snack]);

  const pace = useCallback(() => coffee.pace() * walkScaleOf(wellbeingNow.current), [coffee]);
  const lookScale = useCallback(() => lookScaleOf(wellbeingNow.current), []);

  return { coffee: coffee.coffee, snack: snack.snack, machine: coffee.machine, usables, consume, pace, lookScale, leftovers, wellbeing };
}
