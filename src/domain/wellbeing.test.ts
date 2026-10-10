import { describe, expect, it } from "vitest";
import { conditionOf, drain, lookScaleOf, MINUTES_PER_COFFEE, MINUTES_PER_SNACK, refuel, RESTED, tirednessOf, walkScaleOf } from "./wellbeing.ts";

describe("wellbeing", () => {
  it("runs down with active minutes: a cup's worth of energy every MINUTES_PER_COFFEE, a snack's every MINUTES_PER_SNACK", () => {
    const afterCoffeeInterval = drain(RESTED, MINUTES_PER_COFFEE);
    expect(afterCoffeeInterval.energy).toBeCloseTo(0.4);
    expect(drain(RESTED, MINUTES_PER_SNACK).fullness).toBeCloseTo(0.5);
    expect(drain(RESTED, 0)).toBe(RESTED);
  });

  it("never drops below empty or refills past full", () => {
    expect(drain(RESTED, 10_000)).toEqual({ energy: 0, fullness: 0 });
    expect(refuel(RESTED, "coffee", 1)).toEqual(RESTED);
  });

  it("refills by portions: four sips make one cup", () => {
    let wellbeing = { energy: 0, fullness: 0 };
    for (let sip = 0; sip < 4; sip += 1) wellbeing = refuel(wellbeing, "coffee", 1 / 4);
    expect(wellbeing.energy).toBeCloseTo(0.6);
    expect(refuel(wellbeing, "snack", 1).fullness).toBeCloseTo(0.5);
  });

  it("slows you down when tired and makes looking around heavy only when tired and hungry", () => {
    const tired = { energy: 0.05, fullness: 0.8 };
    const drained = { energy: 0.05, fullness: 0.02 };
    expect(conditionOf(tired)).toEqual({ isTired: true, isHungry: false });
    expect(walkScaleOf(tired)).toBeLessThan(1);
    expect(walkScaleOf(RESTED)).toBe(1);
    expect(lookScaleOf(tired)).toBe(1);
    expect(lookScaleOf(drained)).toBeLessThan(1);
    expect(tirednessOf(RESTED)).toBe(0);
    expect(tirednessOf({ energy: 0, fullness: 1 })).toBe(1);
  });
});
