import { useCallback, useEffect, useState } from "react";

/**
 * Stopwatch for the current page. `restart` is called from the event that opens
 * a new page, so no effect ever has to reset state.
 */
export function useStopwatch(isRunning: boolean) {
  const [startedAt, setStartedAt] = useState(() => performance.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const restart = useCallback(() => {
    const at = performance.now();
    setStartedAt(at);
    setNow(at);
  }, []);

  const elapsedMs = useCallback(() => Math.round(performance.now() - startedAt), [startedAt]);

  return { seconds: Math.max(0, Math.floor((now - startedAt) / 1000)), elapsedMs, restart };
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
