import type { MeshStandardMaterial } from "three";
import type { SurfaceMap, SurfaceName } from "../assets/catalog.ts";
import type { Zone } from "../office.ts";

/**
 * How a scanned surface is laid in the building. `tileMetres` is the real-world size one copy of the
 * texture covers (from Poly Haven's scan dimensions); geometry UVs are generated in those tiles.
 */
export type Finish = {
  readonly surface: SurfaceName;
  readonly tileMetres: number;
  readonly maps: readonly SurfaceMap[];
  /** Paint over the scan's own colour: the scan keeps its relief and sheen, the token sets the colour. */
  readonly paint: string | null;
  readonly normalScale: number;
};

export const FINISHES = {
  carpet: { surface: "carpet", tileMetres: 0.55, maps: ["color", "normal", "roughness", "ao"], paint: null, normalScale: 0.8 },
  wood: { surface: "office-floor", tileMetres: 1.7, maps: ["color", "normal", "roughness", "ao"], paint: null, normalScale: 1 },
  /** The scan's 4×4 slabs over 2.3 m read as 0.6 m raised-floor panels. */
  raised: { surface: "raised-floor", tileMetres: 2.3, maps: ["color", "normal", "roughness", "ao"], paint: null, normalScale: 1 },
  stone: { surface: "raised-floor", tileMetres: 3.4, maps: ["color", "normal", "roughness", "ao"], paint: null, normalScale: 0.7 },
  plaster: { surface: "wall", tileMetres: 2, maps: ["normal", "roughness"], paint: "--color-world-wall", normalScale: 0.6 },
  /** Fine stucco relief at one ceiling-tile scale reads as mineral-fibre acoustic tiles. */
  ceiling: { surface: "ceiling", tileMetres: 0.6, maps: ["normal", "roughness"], paint: "--color-world-ceiling", normalScale: 0.5 },
} as const satisfies Record<string, Finish>;

export type FinishName = keyof typeof FINISHES;

export const FLOOR_FINISH: Readonly<Record<Zone["floor"], FinishName>> = {
  carpet: "carpet",
  wood: "wood",
  raised: "raised",
  tile: "stone",
};

export type FinishMaterials = Readonly<Record<FinishName, MeshStandardMaterial>>;
