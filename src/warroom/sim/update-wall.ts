import type { ClientSegment } from "./clients.ts";
import type { Commerce } from "./commerce.ts";

/**
 * Share (0..1) of one client segment's customers stuck behind the update wall at `t`: their build is
 * below the minimum named by `commerce.updateWall`, so they send no checkout and count as lost.
 * Neutral: walls nobody.
 */
export function updateWall(_commerce: Commerce, _segment: ClientSegment, _t: number): number {
  return 0;
}
