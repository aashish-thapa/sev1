import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWellbeing } from "../../../app/wellbeing-context.ts";
import { coffeeBrew, getAudio } from "../../../audio/index.ts";
import { FURNITURE } from "../office.ts";
import { nowSeconds } from "./clock.ts";
import { canBrew, NO_COFFEE, settle, sip as sipFrom, SIPS_PER_CUP, startBrewing, walkSpeedScale, type Coffee } from "./coffee.ts";
import type { Usable } from "./usable.ts";

const MACHINE = FURNITURE.find((item) => item.kind === "coffee");

type Options = {
  /** Only with an empty hand: no brewing while you're holding a snack. */
  isHandFree: () => boolean;
  /** The last sip: the empty cup goes on your desk. */
  onFinished: () => void;
};

/** The kitchen coffee machine and the cup in your hand; each sip gives back some energy. */
export function useCoffee({ isHandFree, onFinished }: Options) {
  const { takeFromPantry, consume } = useWellbeing();
  const [coffee, setCoffee] = useState<Coffee>(NO_COFFEE);
  const coffeeRef = useRef(coffee);

  const update = useCallback((change: (current: Coffee) => Coffee) => {
    const next = change(coffeeRef.current);
    coffeeRef.current = next;
    setCoffee(next);
  }, []);

  const brew = useCallback(() => {
    if (!canBrew(coffeeRef.current) || !isHandFree()) return;
    update((current) => startBrewing(current, nowSeconds()));
    takeFromPantry("coffee");
    coffeeBrew(getAudio().engine);
  }, [isHandFree, takeFromPantry, update]);
  const sip = useCallback(() => {
    if (coffeeRef.current.cup.kind !== "holding") return;
    const next = sipFrom(coffeeRef.current, nowSeconds());
    update(() => next);
    consume("coffee", 1 / SIPS_PER_CUP);
    if (next.cup.kind === "none") onFinished();
  }, [consume, onFinished, update]);

  const readyAt = coffee.cup.kind === "brewing" ? coffee.cup.readyAt : null;
  useEffect(() => {
    if (readyAt === null) return;
    const timer = window.setTimeout(() => update((current) => settle(current, nowSeconds())), Math.max(0, readyAt - nowSeconds()) * 1000 + 30);
    return () => window.clearTimeout(timer);
  }, [readyAt, update]);


  const usables = useMemo<Usable[]>(
    () => (MACHINE && canBrew(coffee) ? [{ key: "coffee", footprint: MACHINE.footprint, verb: "Make", label: "a coffee", use: brew }] : []),
    [brew, coffee],
  );

  return {
    coffee,
    usables,
    sip,
    machine: MACHINE?.footprint ?? null,
    pace: useCallback(() => walkSpeedScale(coffeeRef.current, nowSeconds()), []),
  };
}
