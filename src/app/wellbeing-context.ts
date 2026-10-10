import { createContext, useContext } from "react";
import type { ConsumableId } from "../domain/pantry.ts";
import { RESTED, type Refuel, type Wellbeing } from "../domain/wellbeing.ts";

/** Your energy and fullness, and the pantry actions that change them — read by the office floor. */
export type WellbeingAccess = {
  readonly wellbeing: Wellbeing;
  takeFromPantry(id: ConsumableId): void;
  consume(kind: Refuel, portion: number): void;
};

/** Outside the app shell (tests, previews) you're rested and the pantry does nothing. */
export const WellbeingContext = createContext<WellbeingAccess>({ wellbeing: RESTED, takeFromPantry: () => undefined, consume: () => undefined });

export function useWellbeing(): WellbeingAccess {
  return useContext(WellbeingContext);
}
