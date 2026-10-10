/** Counts active play time: visible page, input within the idle window. AFK and hidden tabs earn nothing. */

/** Input older than this means the player walked away. */
export const IDLE_AFTER_MS = 60_000;
/** Gaps longer than this (a sleeping laptop, a throttled tab) are never counted as play. */
const MAX_GAP_MS = 15_000;

export type ActivityState = { readonly lastSampleAt: number; readonly activeMs: number };

export type Sample = { readonly at: number; readonly isVisible: boolean; readonly lastInputAt: number };

/** Adds the time since the last sample if the player was present; returns whole minutes ready to pay. */
export function accrue(state: ActivityState, sample: Sample): { readonly state: ActivityState; readonly minutes: number } {
  const gap = sample.at - state.lastSampleAt;
  const isPresent = sample.isVisible && sample.at - sample.lastInputAt <= IDLE_AFTER_MS;
  const counted = isPresent && gap > 0 ? Math.min(gap, MAX_GAP_MS) : 0;
  const activeMs = state.activeMs + counted;
  const minutes = Math.floor(activeMs / 60_000);
  return { state: { lastSampleAt: sample.at, activeMs: activeMs - minutes * 60_000 }, minutes };
}
