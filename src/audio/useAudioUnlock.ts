import { useEffect } from "react";
import type { AudioEngine } from "./engine.ts";

/**
 * The HTML spec's activation-triggering events: touch only activates on
 * pointerup/touchend, a mouse only on pointerdown/mousedown.
 */
const GESTURES = ["pointerdown", "pointerup", "touchend", "keydown"] as const;

/**
 * Unlocks audio from the first user gesture anywhere on the page, and keeps
 * listening so a later gesture can resume a context iOS interrupted.
 */
export function useAudioUnlock(engine: Pick<AudioEngine, "unlock">): void {
  useEffect(() => {
    const unlock = () => engine.unlock();
    for (const gesture of GESTURES) window.addEventListener(gesture, unlock, { capture: true, passive: true });
    return () => {
      for (const gesture of GESTURES) window.removeEventListener(gesture, unlock, { capture: true });
    };
  }, [engine]);
}
