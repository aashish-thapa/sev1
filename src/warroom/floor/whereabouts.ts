import type { Surface, Zone } from "../../audio/index.ts";
import type { Footprint } from "./layout.ts";
import { ZONES } from "./office.ts";

export type Whereabouts = { readonly zone: Zone; readonly surface: Surface; readonly rackProximity: number };

const SOUND_ZONE: Record<string, Zone> = {
  "data-centre": "data-centre",
  corridor: "corridor",
  "dev-floor": "desk",
  "meeting-a": "meeting",
  "meeting-b": "meeting",
};

/** Which part of the office the player is standing in, as far as their ears are concerned. */
export function whereabouts(point: { x: number; z: number }, racks: readonly Footprint[]): Whereabouts {
  const room = ZONES.find((zone) => point.x >= zone.minX && point.x <= zone.maxX && point.z >= zone.minZ && point.z <= zone.maxZ);
  const zone = room ? (SOUND_ZONE[room.name] ?? "other") : "other";
  const surface: Surface = room?.floor === "carpet" ? "carpet" : "tile";
  const nearest = racks.reduce((best, rack) => Math.min(best, Math.hypot(rack.x - point.x, rack.z - point.z)), Infinity);
  const rackProximity = zone === "data-centre" ? Math.max(0, 1 - nearest / 5) : 0;
  return { zone, surface, rackProximity: Math.round(rackProximity * 10) / 10 };
}
