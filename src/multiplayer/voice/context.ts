import { createContext, useContext } from "react";

/** Speaking levels (0…1 by player id) for whatever draws teammates; empty outside a room with voice. */
export const SpeakingContext = createContext<ReadonlyMap<string, number>>(new Map());

export function useSpeakingLevels(): ReadonlyMap<string, number> {
  return useContext(SpeakingContext);
}
