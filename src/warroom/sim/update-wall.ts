import { firingShare, REMOTE_CONFIG_PROPAGATION_SECONDS, type ClientSegment } from "./clients.ts";
import { findConfig, latestChange, type Commerce } from "./commerce.ts";

function versionParts(version: string): readonly number[] | null {
  const parts = version.trim().split(".");
  return parts.every((part) => /^\d+$/.test(part)) ? parts.map(Number) : null;
}

/** Dotted numeric order, so 7.10.0 is newer than 7.9.0. Anything that isn't a version is never older: apps ignore a minimum they can't parse. */
export function isOlderThan(version: string, minimum: string): boolean {
  const left = versionParts(version);
  const right = versionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

/**
 * Share (0..1) of one client segment's customers stuck behind the update wall at `t`: their build is
 * below the minimum named by `commerce.updateWall`, so they send no checkout and count as lost. A new
 * minimum reaches apps on their next remote-config fetch, as any other key does.
 */
export function updateWall(commerce: Commerce, segment: ClientSegment, t: number): number {
  const entry = commerce.updateWall && findConfig(commerce, commerce.updateWall.configKey);
  // A browser always loads the current web build; only installed apps fall behind a minimum.
  if (!entry || segment.platform === "web") return 0;
  return firingShare(latestChange(entry.history), t, REMOTE_CONFIG_PROPAGATION_SECONDS, (minimum) => isOlderThan(segment.version, minimum));
}
