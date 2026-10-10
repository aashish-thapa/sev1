import type { PropName } from "../assets/catalog.ts";
import type { Footprint } from "../layout.ts";

/**
 * Where a model's reference point sits: the middle of its base on the floor (or a desk top),
 * the middle of its top against the ceiling, or the middle of its back against a wall.
 */
export type Anchor = "floor" | "ceiling" | "wall";

export type PropFit = {
  /** Real-world height the model is scaled to (uniformly). */
  readonly height: number;
  /** Width × depth at that height, facing +z — what the player bumps into. `null` for things off the floor. */
  readonly footprint: readonly [number, number] | null;
  readonly anchor: Anchor;
  /** Lying-flat scans (sticky notes) are stood up on the wall: tilt about x before anything else. */
  readonly tilt?: number;
  /** Materials (by name fragment) that are light sources and should glow. */
  readonly glow?: string;
};

/** Sizes measured from the built models (`scripts/assets`), corrected where the scan's units are off. */
export const PROP_FIT: Readonly<Record<PropName, PropFit>> = {
  "executive-desk": { height: 0.76, footprint: [1.92, 0.91], anchor: "floor" },
  "plant-large": { height: 1.15, footprint: [0.96, 0.9], anchor: "floor" },
  "plant-small": { height: 0.27, footprint: null, anchor: "floor" },
  sofa: { height: 0.71, footprint: [1.81, 0.82], anchor: "floor" },
  "coffee-table": { height: 0.39, footprint: [0.6, 1.2], anchor: "floor" },
  "coffee-cart": { height: 1.72, footprint: [2.17, 1.07], anchor: "floor" },
  // The scan is in decimetres; a steel shelving unit stands about 1.9 m.
  shelves: { height: 1.9, footprint: [0.97, 0.45], anchor: "floor" },
  "wall-clock": { height: 0.36, footprint: null, anchor: "wall" },
  armchair: { height: 0.86, footprint: [0.69, 0.84], anchor: "floor" },
  "lounge-chair": { height: 1.05, footprint: [0.91, 1.07], anchor: "floor" },
  "security-camera": { height: 0.29, footprint: null, anchor: "wall" },
  "desk-lamp": { height: 0.62, footprint: null, anchor: "floor", glow: "_light" },
  "pendant-lamp": { height: 0.95, footprint: null, anchor: "ceiling", glow: "globe" },
  "projector-screen": { height: 1.8, footprint: [1.09, 0.92], anchor: "floor" },
  "sticky-notes": { height: 0.66, footprint: null, anchor: "wall", tilt: Math.PI / 2 },
};

/** Quarter turns about y; 0 faces +z (south), 1 faces +x (east), 2 north, 3 west. */
export type Turns = 0 | 1 | 2 | 3;

export type Placement = {
  readonly prop: PropName;
  readonly x: number;
  readonly z: number;
  /** Height of the anchor point: the floor (0), a desk top, a wall mount. Ceiling props ignore it. */
  readonly y: number;
  readonly turns: Turns;
};

const on = (prop: PropName, x: number, z: number, turns: Turns, y = 0): Placement => ({ prop, x, z, y, turns });

const EXECUTIVE_DESK_TOP = 0.76;
const WALL_FACE = 0.1;

/** The office's furnishings. Coordinates follow `office.ts` (metres, +x east, +z south). */
export const FURNISHING: readonly Placement[] = [
  // Cabins: an executive desk along the side wall, a swivel chair in front, a guest armchair, a plant by the glass.
  on("executive-desk", -21.42, -2.6, 1),
  on("lounge-chair", -20.2, -2.6, 3),
  on("desk-lamp", -21.6, -3.3, 1, EXECUTIVE_DESK_TOP),
  on("plant-small", -21.6, -1.9, 0, EXECUTIVE_DESK_TOP),
  on("plant-large", -17.15, 0.35, 0),
  on("executive-desk", -11.58, -2.6, 3),
  on("lounge-chair", -12.8, -2.6, 1),
  on("desk-lamp", -11.4, -1.9, 3, EXECUTIVE_DESK_TOP),
  on("plant-small", -11.4, -3.3, 0, EXECUTIVE_DESK_TOP),
  on("plant-large", -11.7, 0.35, 0),

  // Corridor: plants against the data-centre glass, clear of the doors.
  on("plant-large", -8.5, 1.6, 0),
  on("plant-large", -1.5, 1.6, 0),
  on("plant-large", 4.5, 1.6, 0),
  on("plant-large", 12, 0.3, 0),
  on("plant-large", 16.3, 0.3, 0),

  // Data centre: cameras high in the corners, watching the aisles.
  on("security-camera", -11 + WALL_FACE, -14.4, 1, 3.1),
  on("security-camera", 11 - WALL_FACE, -14.4, 3, 3.1),
  on("security-camera", -11 + WALL_FACE, 0.4, 1, 3.1),
  on("security-camera", 11 - WALL_FACE, 0.4, 3, 3.1),
  on("wall-clock", 0, -15 + WALL_FACE, 0, 2.85),

  // Kitchen: coffee cart and shelving on the back wall, lamps over the tables.
  on("coffee-cart", 15, -14.35, 0),
  on("shelves", 19.6, -14.62, 0),
  on("plant-large", 12, -14.4, 0),
  on("pendant-lamp", 15, -10, 0),
  on("pendant-lamp", 15, -5, 0),
  on("wall-clock", 22 - WALL_FACE, -7, 3, 2.6),

  // Dev floor: a lounge corner by the windows, the team's sticky-note wall, a clock.
  on("sofa", -21.45, 13.4, 1),
  on("coffee-table", -20.4, 13.4, 0),
  on("lounge-chair", -19.45, 14.3, 3),
  on("plant-large", -10.5, 14.35, 0),
  on("plant-large", -0.5, 14.35, 0),
  on("plant-large", 6.2, 14.35, 0),
  on("sticky-notes", -22 + WALL_FACE, 6.6, 1, 1.45),
  on("wall-clock", -22 + WALL_FACE, 13, 1, 2.6),
  on("sticky-notes", 7 - 0.03, 7.4, 3, 1.4),

  // Meeting rooms: chairs along the tables, pendant lights, a pull-up screen in room B.
  ...[9.6, 11.9].flatMap((x) => [on("armchair", x, 8.75, 0), on("armchair", x, 11.25, 2)]),
  ...[17.1, 19.4].map((x) => on("armchair", x, 8.75, 0)),
  on("pendant-lamp", 10, 10, 0),
  on("pendant-lamp", 11.5, 10, 0),
  on("pendant-lamp", 17.5, 10, 0),
  on("pendant-lamp", 19, 10, 0),
  on("projector-screen", 21.2, 5.6, 3),
];

/** What each placement occupies on the floor, rotated with it; wall, ceiling and desk-top things take none. */
export function furnishingFootprints(placements: readonly Placement[] = FURNISHING): Footprint[] {
  return placements.flatMap((placement) => {
    const size = PROP_FIT[placement.prop].footprint;
    if (!size || placement.y > 0) return [];
    const [width, depth] = placement.turns % 2 === 0 ? size : [size[1], size[0]];
    return [{ x: placement.x, z: placement.z, width, depth }];
  });
}
