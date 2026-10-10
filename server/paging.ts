/**
 * When a quiet room's pager goes off. Company offices are calm when members walk in and get paged
 * a few minutes later, like a solo shift; ordinary war rooms have no paging policy and start live.
 */
export type Paging = {
  /** How long the office stays quiet, counted from when someone is first there to hear the pager. */
  quietMs(): number;
  /** After an incident closes, how long before the office goes quiet again (long enough for every client to see it close). */
  readonly resetAfterCloseMs: number;
};

const QUIET_MIN_MS = 2 * 60_000;
const QUIET_SPREAD_MS = 3 * 60_000;

/** Two to five minutes of quiet, then the pager. */
export function officePaging(random: () => number): Paging {
  return { quietMs: () => QUIET_MIN_MS + random() * QUIET_SPREAD_MS, resetAfterCloseMs: 5_000 };
}
