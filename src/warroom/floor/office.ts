import type { Role } from "../../domain/incident.ts";
import { AVATARS, type AvatarId } from "./assets/catalog.ts";
import { furnishingFootprints } from "./environment/furnishing.ts";
import type { Footprint } from "./layout.ts";

/**
 * The office floor plate, metres. +x east, +z south (toward the windows of the dev floor).
 *
 *   z=-15 ┌──────────┬──────────────────────┬────────────┐
 *         │ storage  │      DATA CENTRE      │  kitchen   │
 *   z=-6  ├──┬───┬───┤      (glass front)    │  (open to  │
 *         │ cabin A │ cabin B │              │  corridor) │
 *   z=1   ├──door───┴─door────┴──glass──door─┴────────────┤
 *         │                 main corridor                 │
 *   z=4.5 ├────────── open dev floor ──────────┬─room A─┬─room B─┤
 *   z=15  └────────────────────────────────────┴────────┴────────┘
 */
export const BUILDING = { minX: -22, maxX: 22, minZ: -15, maxZ: 15, ceiling: 3.6 } as const;

/** Where the data-centre racks (laid out around their own origin) sit in the building. */
export const DATACENTRE_ORIGIN = { x: 0, z: -7 } as const;

export type WallKind = "solid" | "glass";
export type Wall = { readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly kind: WallKind };

const WALL_THICKNESS = 0.2;

/** The data centre's only door: a gap in its glass front onto the corridor. */
export const DATACENTRE_DOOR = { fromX: 7, toX: 9, z: 1 } as const;
/** The data centre's glass front, wall to wall. */
export const DATACENTRE_FRONT = { fromX: -11, toX: 11, z: 1 } as const;

/** Interior and exterior walls; door openings are simply the gaps between segments. */
export const WALLS: readonly Wall[] = [
  // Exterior.
  { from: [-22, -15], to: [22, -15], kind: "solid" },
  { from: [-22, 15], to: [22, 15], kind: "glass" },
  { from: [-22, -15], to: [-22, 15], kind: "solid" },
  { from: [22, -15], to: [22, 15], kind: "solid" },
  // Data centre: solid sides, glass front onto the corridor with a door at x 7..9.
  { from: [-11, -15], to: [-11, 1], kind: "solid" },
  { from: [11, -15], to: [11, 1], kind: "solid" },
  { from: [-11, 1], to: [DATACENTRE_DOOR.fromX, 1], kind: "glass" },
  { from: [DATACENTRE_DOOR.toX, 1], to: [11, 1], kind: "glass" },
  // Cabins A and B with doors onto the corridor, storage behind them.
  { from: [-22, -6], to: [-11, -6], kind: "solid" },
  { from: [-16.5, -6], to: [-16.5, 1], kind: "solid" },
  { from: [-22, 1], to: [-20, 1], kind: "glass" },
  { from: [-18.5, 1], to: [-14.5, 1], kind: "glass" },
  { from: [-13, 1], to: [-11, 1], kind: "glass" },
  // Meeting rooms A and B: glass, doors onto the corridor.
  { from: [7, 4.5], to: [7, 15], kind: "glass" },
  { from: [14.5, 4.5], to: [14.5, 15], kind: "glass" },
  { from: [7, 4.5], to: [10, 4.5], kind: "glass" },
  { from: [11.5, 4.5], to: [17.5, 4.5], kind: "glass" },
  { from: [19, 4.5], to: [22, 4.5], kind: "glass" },
];

export type Zone = { readonly name: string; readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly floor: "carpet" | "tile" | "raised" | "wood" };

export const ZONES: readonly Zone[] = [
  { name: "data-centre", minX: -11, maxX: 11, minZ: -15, maxZ: 1, floor: "raised" },
  { name: "kitchen", minX: 11, maxX: 22, minZ: -15, maxZ: 1, floor: "tile" },
  { name: "cabins", minX: -22, maxX: -11, minZ: -6, maxZ: 1, floor: "wood" },
  { name: "corridor", minX: -22, maxX: 22, minZ: 1, maxZ: 4.5, floor: "tile" },
  { name: "dev-floor", minX: -22, maxX: 7, minZ: 4.5, maxZ: 15, floor: "carpet" },
  { name: "meeting-a", minX: 7, maxX: 14.5, minZ: 4.5, maxZ: 15, floor: "wood" },
  { name: "meeting-b", minX: 14.5, maxX: 22, minZ: 4.5, maxZ: 15, floor: "wood" },
];

/**
 * A desk. Clusters are back to back with monitors along the shared middle; `facing` is the
 * direction (along z) its occupant looks: north desks' people face south and vice versa.
 */
export type Desk = { readonly id: string; readonly x: number; readonly z: number; readonly facing: 1 | -1 };

const CLUSTER_XS = [-18, -13, -8, -3, 2] as const;
const CLUSTER_ROWS = [8, 12.5] as const;
export const DESK = { width: 1.5, depth: 0.75, height: 0.74 } as const;

/** Where a four-desk cluster stands: the middle of its two pairs of desks. */
export type DeskCluster = { readonly x: number; readonly z: number };

export const CLUSTERS: readonly DeskCluster[] = CLUSTER_ROWS.flatMap((z) => CLUSTER_XS.map((x) => ({ x, z })));

/** A cluster's four desks: two side by side, two back to back. */
export function desksOf({ x, z }: DeskCluster): Desk[] {
  return [-1, 1].flatMap((side) =>
    [-1, 1].map((front) => ({
      id: `desk-${x}-${z}-${side}-${front}`,
      x: x + side * (DESK.width / 2 + 0.05),
      z: z + front * (DESK.depth / 2),
      facing: (front === -1 ? 1 : -1) as 1 | -1,
    })),
  );
}

export const DESKS: readonly Desk[] = CLUSTERS.flatMap(desksOf);

/** Your desk: front cluster, south side, so you look past your monitor at the data-centre glass. */
export const PLAYER_DESK = DESKS.find((desk) => desk.x < -3 && desk.x > -4 && desk.z > 8 && desk.z < 9 && desk.facing === -1) ?? DESKS[0];

/** Where someone sitting at `desk` is, in the aisle beside it. */
export function seatOf(desk: Desk): { x: number; z: number } {
  return { x: desk.x, z: desk.z - desk.facing * (DESK.depth / 2 + 0.38) };
}

/** Standing just behind your chair, looking north through the data-centre glass. */
export const SPAWN = { x: PLAYER_DESK.x, z: PLAYER_DESK.z + 1.3, yaw: 0 } as const;


/** Built-in fittings drawn procedurally; loose furniture and props live in `environment/furnishing.ts`. */
export type Furniture = { readonly kind: "table" | "counter" | "fridge" | "coffee" | "snacks"; readonly footprint: Footprint; readonly height: number };

export const FURNITURE: readonly Furniture[] = [
  { kind: "table", footprint: { x: 10.75, z: 10, width: 3.2, depth: 1.4 }, height: 0.75 },
  { kind: "table", footprint: { x: 18.25, z: 10, width: 3.2, depth: 1.4 }, height: 0.75 },
  { kind: "counter", footprint: { x: 21.2, z: -7, width: 1, depth: 9 }, height: 0.95 },
  { kind: "coffee", footprint: { x: 21.2, z: -9.5, width: 0.6, depth: 0.5 }, height: 1.45 },
  // On the counter: a fruit bowl and a shelf of packets.
  { kind: "snacks", footprint: { x: 21.2, z: -6.6, width: 0.6, depth: 0.8 }, height: 1.4 },
  { kind: "fridge", footprint: { x: 21.2, z: -2.8, width: 0.9, depth: 0.8 }, height: 1.9 },
  { kind: "table", footprint: { x: 15, z: -10, width: 1.2, depth: 1.2 }, height: 0.75 },
  { kind: "table", footprint: { x: 15, z: -5, width: 1.2, depth: 1.2 }, height: 0.75 },
];

/** Wall segments as collision boxes. */
export function wallFootprints(): Footprint[] {
  return WALLS.map(({ from: [x1, z1], to: [x2, z2] }) => ({
    x: (x1 + x2) / 2,
    z: (z1 + z2) / 2,
    width: Math.abs(x2 - x1) || WALL_THICKNESS,
    depth: Math.abs(z2 - z1) || WALL_THICKNESS,
  }));
}

/** Everything static the player bumps into, except the racks (which move with the incident). */
export function officeObstacles(clusters: readonly DeskCluster[] = CLUSTERS): Footprint[] {
  return [...wallFootprints(), ...deskClusterFootprints(clusters), ...FURNITURE.map((item) => item.footprint), ...furnishingFootprints()];
}

/** One box per four-desk cluster, so nobody slips between two desks. */
export function deskClusterFootprints(clusters: readonly DeskCluster[] = CLUSTERS): Footprint[] {
  return clusters.map(({ x, z }) => ({ x, z, width: DESK.width * 2 + 0.1, depth: DESK.depth * 2 }));
}

// ── Role rooms and their wall screens ─────────────────────────────

/** A wall-mounted screen. `normal` is the direction it faces (unit vector on the floor plane). */
export type WallScreen = {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly normal: readonly [number, number];
  /** Whose problems show up on it; `null` is the library — open discussion for everyone. */
  readonly role: Role | null;
  readonly title: string;
};

export const SCREEN_SIZE = { width: 2.2, height: 1.25, y: 1.65 } as const;

export const WALL_SCREENS: readonly WallScreen[] = [
  { id: "screen-dc", x: -10.85, z: -2.6, normal: [1, 0], role: "infrastructure", title: "NOC wall · Data centre" },
  { id: "screen-device-lab", x: -19.25, z: -5.85, normal: [0, 1], role: "mobile", title: "Device lab" },
  { id: "screen-soc", x: -13.75, z: -5.85, normal: [0, 1], role: "security", title: "SOC" },
  { id: "screen-web-studio", x: -21.85, z: 10.25, normal: [1, 0], role: "frontend", title: "Web studio" },
  { id: "screen-data-lab", x: 18.25, z: 14.8, normal: [0, -1], role: "data", title: "Data lab" },
  { id: "screen-library", x: 10.75, z: 14.8, normal: [0, -1], role: null, title: "Library · discussions" },
];

/** Where a player of `role` starts: in their own room, a couple of steps back from its screen. */
export function spawnFor(role: Role): { x: number; z: number; yaw: number } {
  const screen = WALL_SCREENS.find((candidate) => candidate.role === role);
  if (!screen) return SPAWN;
  const [nx, nz] = screen.normal;
  // Looking at the screen means facing against its normal.
  return { x: screen.x + nx * 2.2, z: screen.z + nz * 2.2, yaw: Math.atan2(nx, nz) };
}

/** Floor area in front of a screen that the player can stand on to use it. */
export function screenFootprint(screen: WallScreen): Footprint {
  const [nx, nz] = screen.normal;
  return { x: screen.x + nx * 0.05, z: screen.z + nz * 0.05, width: nx === 0 ? SCREEN_SIZE.width : 0.1, depth: nz === 0 ? SCREEN_SIZE.width : 0.1 };
}

/** Where the colleague who presents at a screen stands: beside it, facing the room. */
export function presenterSpot(screen: WallScreen): { x: number; z: number; yaw: number } {
  const [nx, nz] = screen.normal;
  const sideX = -nz;
  const sideZ = nx;
  return {
    x: screen.x + nx * 0.9 + sideX * (SCREEN_SIZE.width / 2 + 0.45),
    z: screen.z + nz * 0.9 + sideZ * (SCREEN_SIZE.width / 2 + 0.45),
    yaw: Math.atan2(nx, nz),
  };
}

// ── Navigation graph for people ───────────────────────────────────

export type NavNode = { readonly id: string; readonly x: number; readonly z: number };

const LANE_XS = [-20.5, -15.5, -10.5, -5.5, -0.5, 4.5] as const;
const CORRIDOR_Z = 2.75;
const FRONT_AISLE_Z = 5.75;
const MID_AISLE_Z = 10.25;

const node = (id: string, x: number, z: number): NavNode => ({ id, x, z });

export const NAV_NODES: readonly NavNode[] = [
  ...[-20.5, -19.25, -15.5, -13.75, -10.5, -5.5, -0.5, 4.5, 8, 10.75, 14, 18.25, 20.5].map((x) => node(`corridor:${x}`, x, CORRIDOR_Z)),
  ...LANE_XS.map((x) => node(`front:${x}`, x, FRONT_AISLE_Z)),
  ...LANE_XS.map((x) => node(`mid:${x}`, x, MID_AISLE_Z)),
  node("dc:door", 8, 1),
  node("dc:entry", 8, -2.5),
  node("dc:aisle-east", 8, -7.25),
  node("dc:aisle-mid", 0, -7.25),
  node("dc:aisle-west", -6, -7.25),
  node("room-a:door", 10.75, 4.5),
  node("room-a", 10.75, 7.8),
  node("room-b:door", 18.25, 4.5),
  node("room-b", 18.25, 7.8),
  node("kitchen", 14, -2),
  node("kitchen:coffee", 19.8, -9.5),
  node("kitchen:snacks", 19.8, -6.6),
  node("cabin-a:door", -19.25, 1),
  node("cabin-a", -19.25, -1.6),
  node("cabin-b:door", -13.75, 1),
  node("cabin-b", -13.75, -1.6),
];

const CORRIDOR_ORDER = NAV_NODES.filter((item) => item.id.startsWith("corridor:")).map((item) => item.id);

export const NAV_EDGES: readonly (readonly [string, string])[] = [
  ...CORRIDOR_ORDER.slice(1).map((id, index) => [CORRIDOR_ORDER[index], id] as const),
  ...LANE_XS.flatMap((x, index) => {
    const edges: (readonly [string, string])[] = [
      [`front:${x}`, `corridor:${x}`],
      [`front:${x}`, `mid:${x}`],
    ];
    const next = LANE_XS[index + 1];
    if (next !== undefined) edges.push([`front:${x}`, `front:${next}`], [`mid:${x}`, `mid:${next}`]);
    return edges;
  }),
  ["corridor:8", "dc:door"],
  ["dc:door", "dc:entry"],
  ["dc:entry", "dc:aisle-east"],
  ["dc:aisle-east", "dc:aisle-mid"],
  ["dc:aisle-mid", "dc:aisle-west"],
  ["corridor:10.75", "room-a:door"],
  ["room-a:door", "room-a"],
  ["corridor:18.25", "room-b:door"],
  ["room-b:door", "room-b"],
  ["corridor:14", "kitchen"],
  ["kitchen", "kitchen:coffee"],
  ["kitchen", "kitchen:snacks"],
  ["corridor:-19.25", "cabin-a:door"],
  ["cabin-a:door", "cabin-a"],
  ["corridor:-13.75", "cabin-b:door"],
  ["cabin-b:door", "cabin-b"],
];

// ── People ────────────────────────────────────────────────────────

/** What someone standing still is doing — it picks their animation. */
/** What someone can be seen carrying around the office. */
export type Carried = "cup" | "snack";

export type StandingActivity = "chatting" | "on-phone" | "on-laptop" | "presenting" | "waiting";

export type Person =
  | { readonly kind: "seated"; readonly id: string; readonly desk: Desk; readonly avatar: AvatarId }
  | {
      readonly kind: "standing";
      readonly id: string;
      readonly x: number;
      readonly z: number;
      readonly yaw: number;
      readonly activity: StandingActivity;
      readonly avatar: AvatarId;
      /** Something in their hand while they stand there. */
      readonly holds?: Carried;
    }
  | {
      readonly kind: "walker";
      readonly id: string;
      readonly stops: readonly { readonly node: string; readonly pause: number }[];
      readonly avatar: AvatarId;
      readonly offset: number;
      /** Picks something up at the `from` stop and carries it until leaving the stop after. */
      readonly carries?: { readonly item: Carried; readonly from: string };
    }
  /** Someone from the incident channel: waits at home, walks over when their message lands. */
  | { readonly kind: "messenger"; readonly id: string; readonly name: string; readonly home: string; readonly avatar: AvatarId };

/** Steps through the cast with a stride coprime to its size, so neighbours never share a face. */
function castMember(index: number): AvatarId {
  return AVATARS[(index * 5 + 2) % AVATARS.length].id;
}

const seatedDesks = DESKS.filter((desk, index) => desk.id !== PLAYER_DESK.id && index % 3 !== 1);

export const PEOPLE: readonly Person[] = [
  ...seatedDesks.slice(0, 18).map((desk, index): Person => ({ kind: "seated", id: `seated-${index}`, desk, avatar: castMember(index) })),
  { kind: "standing", id: "stand-room-b-1", x: 17.2, z: 11.4, yaw: Math.PI * 0.85, activity: "chatting", avatar: "Male_Adult_07", holds: "cup" },
  { kind: "standing", id: "stand-room-b-2", x: 19.4, z: 11.5, yaw: Math.PI * 1.15, activity: "waiting", avatar: "Female_Adult_08", holds: "cup" },
  { kind: "standing", id: "stand-kitchen", x: 15.7, z: -5.6, yaw: Math.PI * 0.3, activity: "on-phone", avatar: "Male_Adult_12" },
  { kind: "walker", id: "walker-coffee", stops: [{ node: "mid:-10.5", pause: 4 }, { node: "kitchen:coffee", pause: 7 }], avatar: "Female_Adult_02", offset: 0, carries: { item: "cup", from: "kitchen:coffee" } },
  { kind: "walker", id: "walker-snack", stops: [{ node: "kitchen:snacks", pause: 5 }, { node: "front:-0.5", pause: 6 }], avatar: "Male_Adult_02", offset: 23, carries: { item: "snack", from: "kitchen:snacks" } },
  { kind: "walker", id: "walker-meeting", stops: [{ node: "mid:-0.5", pause: 6 }, { node: "room-a", pause: 9 }], avatar: "Male_Adult_04", offset: 11 },
  { kind: "walker", id: "walker-tech", stops: [{ node: "dc:aisle-mid", pause: 8 }, { node: "corridor:-5.5", pause: 2 }, { node: "kitchen", pause: 5 }], avatar: "Female_Adult_12", offset: 4 },
  { kind: "walker", id: "walker-phone", stops: [{ node: "corridor:-15.5", pause: 3 }, { node: "corridor:4.5", pause: 3 }], avatar: "Male_Adult_09", offset: 17 },
  { kind: "messenger", id: "maya", name: "Maya Okonkwo", home: "cabin-a", avatar: "Female_Adult_09" },
  { kind: "messenger", id: "sam", name: "Sam Tan", home: "room-a", avatar: "Male_Adult_10" },
  { kind: "messenger", id: "elena", name: "Elena Ruiz", home: "room-b", avatar: "Female_Adult_05" },
  ...WALL_SCREENS.map((screen, index): Person => {
    const spot = presenterSpot(screen);
    return { kind: "standing", id: `presenter-${screen.id}`, x: spot.x, z: spot.z, yaw: spot.yaw, activity: "presenting", avatar: castMember(index + 7) };
  }),
];
