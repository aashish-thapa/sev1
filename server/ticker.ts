/** After a stall this long (GC pause, suspended host) the ticker skips the missed ticks instead of bursting through them. */
const MAX_LAG_TICKS = 5;

export type StopTicker = () => void;

/**
 * Like setInterval, but each delay is measured from when the tick was due rather than when the
 * previous callback ran, so the simulated clock doesn't drift behind wall time. The interval is
 * re-read every tick, which lets monitoring fast-forward without restarting the ticker.
 */
export function startTicker(intervalMs: () => number, tick: () => void, now: () => number = () => performance.now()): StopTicker {
  let due = now() + intervalMs();
  let isStopped = false;
  let handle = setTimeout(fire, intervalMs());

  function fire() {
    tick();
    if (isStopped) return;
    const interval = intervalMs();
    const current = now();
    due += interval;
    if (current - due > interval * MAX_LAG_TICKS) due = current + interval;
    handle = setTimeout(fire, Math.max(0, due - current));
  }

  return () => {
    isStopped = true;
    clearTimeout(handle);
  };
}
