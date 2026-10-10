import { useEffect, useRef } from "react";
import { accrue, type ActivityState } from "./activity.ts";

const SAMPLE_MS = 5_000;
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/** While `isOn`, calls `onMinutes` each time another whole minute of active play has passed. */
export function useActivityClock(isOn: boolean, onMinutes: (minutes: number) => void): void {
  const pay = useRef(onMinutes);
  useEffect(() => {
    pay.current = onMinutes;
  }, [onMinutes]);

  useEffect(() => {
    if (!isOn) return;
    let lastInputAt = performance.now();
    let state: ActivityState = { lastSampleAt: lastInputAt, activeMs: 0 };
    const markInput = () => {
      lastInputAt = performance.now();
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, markInput, { passive: true });
    const timer = window.setInterval(() => {
      const result = accrue(state, { at: performance.now(), isVisible: document.visibilityState === "visible", lastInputAt });
      state = result.state;
      if (result.minutes > 0) pay.current(result.minutes);
    }, SAMPLE_MS);
    return () => {
      window.clearInterval(timer);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, markInput);
    };
  }, [isOn]);
}
