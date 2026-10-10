import type { Database, HotIndex } from "./model.ts";

/** A checkout's seq scan with the hot set still cached, and the most eviction adds on top. */
const SEQ_SCAN_SECONDS = 0.25;
const EVICTED_SCAN_EXTRA_SECONDS = 1.6;
/** Seq scans push the working set out of shared_buffers over about five minutes; a fixed index lets it warm back in a minute. */
const EVICTION_PER_SECOND = 1 / 300;
const WARMING_PER_SECOND = 1 / 60;
/** Behind a plain REINDEX's lock, checkout waits until Hikari gives up on it. */
const LOCK_WAIT_SECONDS = 30;

export const REBUILD_SECONDS = { concurrent: 45, locking: 20 } as const;

/** Extra seconds each checkout holds its connection because of the hot index's state. */
export function checkoutQuerySeconds(database: Database): number {
  const index = database.hotIndex;
  if (!index) return 0;
  if (index.rebuild?.isLocking) return LOCK_WAIT_SECONDS;
  return index.isValid ? 0 : SEQ_SCAN_SECONDS + EVICTED_SCAN_EXTRA_SECONDS * index.cacheEviction;
}

/** One second of the index's life: a running rebuild progresses, the cache cools or warms. */
export function stepHotIndex(index: HotIndex): HotIndex {
  const rebuild = index.rebuild ? { ...index.rebuild, secondsLeft: index.rebuild.secondsLeft - 1 } : null;
  const isRebuilt = rebuild !== null && rebuild.secondsLeft <= 0;
  const isValid = index.isValid || isRebuilt;
  const cacheEviction = isValid
    ? Math.max(0, index.cacheEviction - WARMING_PER_SECOND)
    : Math.min(1, index.cacheEviction + EVICTION_PER_SECOND);
  return { ...index, isValid, cacheEviction, rebuild: isRebuilt ? null : rebuild };
}
