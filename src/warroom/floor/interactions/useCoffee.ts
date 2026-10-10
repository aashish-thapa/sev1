import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coffeeBrew, getAudio } from "../../../audio/index.ts";
import { FURNITURE } from "../office.ts";
import { nowSeconds } from "./clock.ts";
import { caffeineLeft, canBrew, NO_COFFEE, settle, sip as sipFrom, startBrewing, walkSpeedScale, type Coffee } from "./coffee.ts";
import type { Usable } from "./usable.ts";

const MACHINE = FURNITURE.find((item) => item.kind === "coffee");

/** The kitchen coffee machine and the cup in your hand. */
export function useCoffee() {
  const [coffee, setCoffee] = useState<Coffee>(NO_COFFEE);
  const coffeeRef = useRef(coffee);
  // Re-rendered once a second while caffeinated, so the countdown chip ticks.
  const [, setTick] = useState(0);

  const update = useCallback((change: (current: Coffee) => Coffee) => {
    const next = change(coffeeRef.current);
    coffeeRef.current = next;
    setCoffee(next);
  }, []);

  const brew = useCallback(() => {
    if (!canBrew(coffeeRef.current)) return;
    update((current) => startBrewing(current, nowSeconds()));
    coffeeBrew(getAudio().engine);
  }, [update]);
  const sip = useCallback(() => update((current) => sipFrom(current, nowSeconds())), [update]);

  const readyAt = coffee.cup.kind === "brewing" ? coffee.cup.readyAt : null;
  useEffect(() => {
    if (readyAt === null) return;
    const timer = window.setTimeout(() => update((current) => settle(current, nowSeconds())), Math.max(0, readyAt - nowSeconds()) * 1000 + 30);
    return () => window.clearTimeout(timer);
  }, [readyAt, update]);

  const isCaffeinated = caffeineLeft(coffee, nowSeconds()) > 0;
  useEffect(() => {
    if (!isCaffeinated) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isCaffeinated]);

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
