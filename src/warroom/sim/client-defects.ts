import { triggerShare, type ClientSegment } from "./clients.ts";
import type { ClientDefect, Commerce } from "./commerce.ts";

/** What one client segment's build defects do to its checkouts this second. */
export type DefectEffect = {
  /** Share of the segment's checkout requests that checkout-api answers with a 5xx. */
  readonly rejectedShare: number;
  /** Share of the segment's customers whose checkout dies in the client, before any request. */
  readonly clientFailureShare: number;
};

export const NO_DEFECT: DefectEffect = { rejectedShare: 0, clientFailureShare: 0 };

/** Defects fail checkouts independently: one survives only if every defect spares it. */
function failing(defects: readonly ClientDefect[], commerce: Commerce, t: number): number {
  return 1 - defects.reduce((spared, defect) => spared * (1 - defect.failShare * triggerShare(defect.trigger, commerce, t)), 1);
}

/** The segment's build defects at `t`, each firing on the clients its flag or remote-config trigger has reached. */
export function clientDefects(commerce: Commerce, segment: ClientSegment, t: number): DefectEffect {
  if (segment.defects.length === 0) return NO_DEFECT;
  return {
    rejectedShare: failing(segment.defects.filter((defect) => defect.where === "server"), commerce, t),
    clientFailureShare: failing(segment.defects.filter((defect) => defect.where === "client"), commerce, t),
  };
}
