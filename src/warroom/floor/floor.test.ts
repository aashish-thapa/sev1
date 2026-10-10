import { describe, expect, it } from "vitest";
import { openIncident } from "../incident.ts";
import { checkoutPoolLeak } from "../scenarios/checkout-pool-leak.ts";
import { layoutHall, obstaclesOf } from "./layout.ts";
import { facing, walk, type Player } from "./player.ts";

const still = { forward: 0, strafe: 0, yawDelta: 0, pitchDelta: 0 };

describe("server hall", () => {
  const cluster = openIncident(checkoutPoolLeak).cluster;
  const racks = layoutHall(cluster, checkoutPoolLeak);

  it("gives every live pod its own rack and marks the starved one critical", () => {
    const compute = racks.filter((rack) => rack.kind === "compute");
    expect(compute).toHaveLength(cluster.deployments[0].pods.length);
    expect(compute.some((rack) => rack.health === "critical")).toBe(true);
  });

  it("never lets racks overlap", () => {
    for (const [index, a] of racks.entries()) {
      for (const b of racks.slice(index + 1)) {
        const apart =
          Math.abs(a.footprint.x - b.footprint.x) >= (a.footprint.width + b.footprint.width) / 2 ||
          Math.abs(a.footprint.z - b.footprint.z) >= (a.footprint.depth + b.footprint.depth) / 2;
        expect(apart, `${a.key} overlaps ${b.key}`).toBe(true);
      }
    }
  });

  it("walks forward along -z and stops at a rack instead of passing through", () => {
    let player: Player = { x: -4, z: 2, yaw: 0, pitch: 0 };
    player = walk(player, { ...still, forward: 1 }, 0.1, []);
    expect(player.z).toBeLessThan(2);
    for (let frame = 0; frame < 200; frame += 1) player = walk(player, { ...still, forward: 1 }, 1 / 60, obstaclesOf(racks));
    const blocker = racks.find((rack) => rack.key !== "database" && Math.abs(rack.footprint.x + 4) < 0.5 && rack.footprint.z < 0);
    expect(blocker).toBeDefined();
    expect(player.z).toBeGreaterThan((blocker?.footprint.z ?? 0) + (blocker?.footprint.depth ?? 0) / 2);
  });

  it("can't be squeezed into the gap between two cabinets in a row", () => {
    const pods = racks.filter((rack) => rack.kind === "compute");
    const gapX = (pods[0].footprint.x + pods[1].footprint.x) / 2;
    let player: Player = { x: gapX, z: 0, yaw: 0, pitch: 0 };
    for (let frame = 0; frame < 240; frame += 1) player = walk(player, { ...still, forward: 1 }, 1 / 60, obstaclesOf(racks));
    expect(player.z).toBeGreaterThan(pods[0].footprint.z + pods[0].footprint.depth / 2);
  });

  it("finds the rack in front of the player and ignores the one behind", () => {
    const pod = racks.find((rack) => rack.kind === "compute");
    if (!pod) throw new Error("no compute rack");
    const inFront: Player = { x: pod.footprint.x, z: pod.footprint.z + 1.6, yaw: 0, pitch: 0 };
    expect(facing(inFront, racks)?.key).toBe(pod.key);
    expect(facing({ ...inFront, yaw: Math.PI }, racks.filter((rack) => rack.key === pod.key))).toBeNull();
  });
});
