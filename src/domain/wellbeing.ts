/**
 * How you're holding up: energy (coffee) and fullness (snacks), each 0…1. Both run down only
 * with active minutes on the floor — the same minutes that pay salary — so an idle tab costs
 * nothing. Running low never blocks play or touches money; it nags until you take a break.
 */
import { z } from "zod";

export const MeterSchema = z.number().min(0).max(1);
export const WellbeingSchema = z.object({ energy: MeterSchema, fullness: MeterSchema });
export type Wellbeing = z.output<typeof WellbeingSchema>;

export const RESTED: Wellbeing = { energy: 1, fullness: 1 };

/** A cup of coffee gives back this much energy; a snack this much fullness. */
export const COFFEE_ENERGY = 0.6;
export const SNACK_FULLNESS = 0.5;

/** One cup's worth of energy is gone after this many active minutes, so a coffee run comes round about this often. */
export const MINUTES_PER_COFFEE = 22;
/** One snack's worth of fullness lasts this many active minutes. */
export const MINUTES_PER_SNACK = 40;

const ENERGY_PER_MINUTE = COFFEE_ENERGY / MINUTES_PER_COFFEE;
const FULLNESS_PER_MINUTE = SNACK_FULLNESS / MINUTES_PER_SNACK;

/** Below these you're tired / hungry, and the office starts to show it. */
export const TIRED_BELOW = 0.15;
export const HUNGRY_BELOW = 0.1;

/** Tired legs walk slower; tired and hungry, even turning your head feels heavy. */
const TIRED_WALK = 0.8;
const DRAINED_LOOK = 0.85;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Active minutes on the floor wear both meters down. */
export function drain(wellbeing: Wellbeing, activeMinutes: number): Wellbeing {
  if (activeMinutes <= 0) return wellbeing;
  return { energy: clamp(wellbeing.energy - ENERGY_PER_MINUTE * activeMinutes), fullness: clamp(wellbeing.fullness - FULLNESS_PER_MINUTE * activeMinutes) };
}

export type Refuel = "coffee" | "snack";

/** `portion` of a cup or a snack (a sip or a bite is a fraction of one). */
export function refuel(wellbeing: Wellbeing, kind: Refuel, portion: number): Wellbeing {
  const share = clamp(portion);
  return kind === "coffee" ? { ...wellbeing, energy: clamp(wellbeing.energy + COFFEE_ENERGY * share) } : { ...wellbeing, fullness: clamp(wellbeing.fullness + SNACK_FULLNESS * share) };
}

export type Condition = { readonly isTired: boolean; readonly isHungry: boolean };

export function conditionOf(wellbeing: Wellbeing): Condition {
  return { isTired: wellbeing.energy < TIRED_BELOW, isHungry: wellbeing.fullness < HUNGRY_BELOW };
}

export function walkScaleOf(wellbeing: Wellbeing): number {
  return conditionOf(wellbeing).isTired ? TIRED_WALK : 1;
}

export function lookScaleOf(wellbeing: Wellbeing): number {
  const { isTired, isHungry } = conditionOf(wellbeing);
  return isTired && isHungry ? DRAINED_LOOK : 1;
}

/** 0 while you're fine, rising to 1 as energy runs out: how dark the edges of your view get. */
export function tirednessOf(wellbeing: Wellbeing): number {
  return wellbeing.energy >= TIRED_BELOW ? 0 : 1 - wellbeing.energy / TIRED_BELOW;
}
