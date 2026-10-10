import type { ClientSegment } from "./clients.ts";
import type { Commerce } from "./commerce.ts";

/** What one client segment's build defects do to its checkouts this second. */
export type DefectEffect = {
  /** Share of the segment's checkout requests that checkout-api answers with a 5xx. */
  readonly rejectedShare: number;
  /** Share of the segment's customers whose checkout dies in the client, before any request. */
  readonly clientFailureShare: number;
};

export const NO_DEFECT: DefectEffect = { rejectedShare: 0, clientFailureShare: 0 };

/** The segment's defects at `t`. Neutral: no build fails. */
export function clientDefects(_commerce: Commerce, _segment: ClientSegment, _t: number): DefectEffect {
  return NO_DEFECT;
}
