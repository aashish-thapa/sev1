import { describe, expect, it } from "vitest";
import { openIncident } from "../incident.ts";
import { checkoutPoolLeak } from "../scenarios/checkout-pool-leak.ts";
import { layoutHall } from "./layout.ts";
import { loopThrough, positionOnLoop, route } from "./navigation.ts";
import { BUILDING, DATACENTRE_ORIGIN, NAV_EDGES, NAV_NODES, officeObstacles, PEOPLE, presenterSpot, SPAWN, spawnFor, WALL_SCREENS } from "./office.ts";
import { walk } from "./player.ts";
import type { Footprint } from "./layout.ts";

const inside = (point: { x: number; z: number }, box: Footprint, margin = 0) =>
  Math.abs(point.x - box.x) < box.width / 2 + margin && Math.abs(point.z - box.z) < box.depth / 2 + margin;

const racks = layoutHall(openIncident(checkoutPoolLeak).cluster, checkoutPoolLeak).map((rack) => ({
  ...rack.footprint,
  x: rack.footprint.x + DATACENTRE_ORIGIN.x,
  z: rack.footprint.z + DATACENTRE_ORIGIN.z,
}));
const obstacles = [...officeObstacles(), ...racks];

describe("office", () => {
  it("spawns the player in free space inside the building", () => {
    expect(obstacles.some((box) => inside(SPAWN, box, 0.3))).toBe(false);
    expect(SPAWN.x).toBeGreaterThan(BUILDING.minX);
    expect(SPAWN.z).toBeLessThan(BUILDING.maxZ);
  });

  it("starts every role in free space in its own room", () => {
    for (const role of ["infrastructure", "frontend", "mobile", "security", "data"] as const) {
      const spot = spawnFor(role);
      expect(obstacles.find((box) => inside(spot, box, 0.3)), `${role} spawns inside something`).toBeUndefined();
    }
  });

  it("keeps every nav node out of walls, desks and racks", () => {
    for (const node of NAV_NODES) {
      const blocker = obstacles.find((box) => inside(node, box, 0.15));
      expect(blocker, `${node.id} sits inside an obstacle`).toBeUndefined();
    }
  });

  it("never routes a walking edge through an obstacle", () => {
    for (const [a, b] of NAV_EDGES) {
      const from = NAV_NODES.find((node) => node.id === a);
      const to = NAV_NODES.find((node) => node.id === b);
      if (!from || !to) throw new Error(`edge ${a}-${b} names a missing node`);
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.1);
      for (let index = 0; index <= steps; index += 1) {
        const point = { x: from.x + ((to.x - from.x) * index) / steps, z: from.z + ((to.z - from.z) * index) / steps };
        const blocker = obstacles.find((box) => inside(point, box, 0.12));
        expect(blocker, `edge ${a} → ${b} clips an obstacle at ${point.x.toFixed(2)},${point.z.toFixed(2)}`).toBeUndefined();
      }
    }
  });

  it("leaves room in front of every wall screen for the presenter and the player", () => {
    for (const screen of WALL_SCREENS) {
      const spot = presenterSpot(screen);
      expect(obstacles.find((box) => inside(spot, box, 0.25)), `${screen.id} presenter is blocked`).toBeUndefined();
      const viewer = { x: screen.x + screen.normal[0] * 1.6, z: screen.z + screen.normal[1] * 1.6 };
      expect(obstacles.find((box) => inside(viewer, box, 0.3)), `nowhere to stand at ${screen.id}`).toBeUndefined();
    }
  });

  it("connects every room to every other room", () => {
    for (const target of ["dc:aisle-west", "room-b", "kitchen:coffee", "cabin-a", "mid:-20.5"]) {
      expect(route("cabin-b", target).length).toBeGreaterThan(1);
    }
  });

  it("lets the player walk from their desk into the data centre through the door", () => {
    let player = { x: 8, z: 3.2, yaw: 0, pitch: 0 };
    for (let frame = 0; frame < 300; frame += 1) player = walk(player, { forward: 1, strafe: 0, yawDelta: 0, pitchDelta: 0 }, 1 / 60, obstacles);
    expect(player.z).toBeLessThan(0);
  });

  it("walks looping people along their routes and back", () => {
    for (const person of PEOPLE) {
      if (person.kind !== "walker") continue;
      const loop = loopThrough(person.stops);
      const start = positionOnLoop(loop, 0);
      const lap = positionOnLoop(loop, loop.duration);
      expect(Math.hypot(start.x - lap.x, start.z - lap.z)).toBeLessThan(1e-6);
    }
  });
});
