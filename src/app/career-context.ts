import { createContext, useContext } from "react";
import { careerAt, type Career } from "../domain/career.ts";

/** The player's place on the ladder, readable by the HUD and the promotion toast. */
export const CareerContext = createContext<Career>(careerAt(0));

export function useCareer(): Career {
  return useContext(CareerContext);
}
