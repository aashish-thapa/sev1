export type BackoffPolicy = {
  readonly baseMs: number;
  readonly capMs: number;
  /** Attempts after which the caller gives up. */
  readonly maxAttempts: number;
};

export const RECONNECT_BACKOFF: BackoffPolicy = { baseMs: 500, capMs: 15_000, maxAttempts: 12 };

/**
 * "Full jitter": uniform in [0, min(cap, base·2^attempt)). Spreads a room's worth of clients that
 * lost the server at the same moment instead of having them reconnect in lockstep.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
