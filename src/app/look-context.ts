import { createContext, useContext } from "react";
import { DEFAULT_LOOK, type Look } from "../domain/look.ts";

/** The look the player chose, for anything that draws them (their own body on the floor, the lobby stage). */
export const LookContext = createContext<Look>(DEFAULT_LOOK);

export function useLook(): Look {
  return useContext(LookContext);
}
