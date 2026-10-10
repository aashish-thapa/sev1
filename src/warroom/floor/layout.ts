import { databaseHealth, deploymentHealth, edgeHealth, podHealth, visiblePods, type Health, type NodeId } from "../health.ts";
import type { Scenario } from "../scenario.ts";
import { openConnections } from "../sim/engine.ts";
import type { ClusterState, PodPhase } from "../sim/model.ts";

/** Axis-aligned footprint on the floor plane, metres. */
export type Footprint = { readonly x: number; readonly z: number; readonly width: number; readonly depth: number };

export type RackKind = "network" | "compute" | "database" | "external" | "idle";

export type Rack = {
  readonly key: string;
  readonly node: NodeId | null;
  readonly kind: RackKind;
  readonly label: string;
  readonly caption: string;
  readonly health: Health;
  readonly phase?: PodPhase;
  readonly footprint: Footprint;
  readonly height: number;
  /** Which way the rack's front panel points along z: +1 toward the viewer at spawn, -1 the other way. */
  readonly front: 1 | -1;
};


const RACK = { width: 0.8, depth: 1.1, height: 2.1 } as const;
const COMPUTE_ROW_Z = -2.5;
const SUPPORT_ROW_Z = 2;

/** Lays the live cluster out as a server hall. Same input, same hall. */
export function layoutHall(cluster: ClusterState, scenario: Scenario): Rack[] {
  const deployment = cluster.deployments[0];
  const pods = visiblePods(cluster);
  const poolSize = deployment?.poolSize ?? 1;
  const racks: Rack[] = [];

  racks.push({
    key: "edge",
    node: { kind: "edge" },
    kind: "network",
    label: "edge-lb",
    caption: `${Math.round(cluster.errorRate * 100)}% 5xx`,
    health: edgeHealth(cluster, scenario),
    footprint: { x: -7, z: COMPUTE_ROW_Z, width: RACK.width, depth: RACK.depth },
    height: RACK.height,
    front: 1,
  });

  pods.forEach((pod, index) => {
    racks.push({
      key: pod.name,
      node: { kind: "pod", name: pod.name },
      kind: "compute",
      label: `…${pod.name.slice(-5)}`,
      caption: pod.phase === "Running" ? `${Math.min(pod.leaked, poolSize)}/${poolSize} conn` : pod.phase,
      health: podHealth(pod, poolSize),
      phase: pod.phase,
      footprint: { x: -4 + index * 1.05, z: COMPUTE_ROW_Z, width: RACK.width, depth: RACK.depth },
      height: RACK.height,
      front: 1,
    });
  });

  // Unrelated tenants make the hall feel like a real floor; they never alarm.
  for (let index = 0; index < 4; index += 1) {
    racks.push({
      key: `idle-a-${index}`,
      node: null,
      kind: "idle",
      label: "",
      caption: "",
      health: "ok",
      footprint: { x: 3.4 + index * 1.05, z: COMPUTE_ROW_Z, width: RACK.width, depth: RACK.depth },
      height: RACK.height,
      front: 1,
    });
  }

  racks.push({
    key: "database",
    node: { kind: "database" },
    kind: "database",
    label: cluster.database.name,
    caption: `${openConnections(cluster.deployments)}/${cluster.database.maxConnections} conn`,
    health: databaseHealth(cluster),
    footprint: { x: -4.5, z: SUPPORT_ROW_Z, width: RACK.width * 2.2, depth: RACK.depth * 1.2 },
    height: RACK.height + 0.2,
    front: -1,
  });

  for (let index = 0; index < 5; index += 1) {
    racks.push({
      key: `idle-b-${index}`,
      node: null,
      kind: "idle",
      label: "",
      caption: "",
      health: "ok",
      footprint: { x: -1.4 + index * 1.05, z: SUPPORT_ROW_Z, width: RACK.width, depth: RACK.depth },
      height: RACK.height,
      front: -1,
    });
  }

  scenario.externals.forEach((external, index) => {
    racks.push({
      key: `external-${external.id}`,
      node: { kind: "external", id: external.id },
      kind: "external",
      label: external.id,
      caption: "external · cross-connect",
      health: external.status === "degraded" ? "warn" : "ok",
      footprint: { x: 8, z: -5.4 - index * 2.4, width: 1.8, depth: 1.6 },
      height: 2.4,
      front: 1,
    });
  });

  return racks;
}

/**
 * What the player collides with. Racks closer than a body-width are merged into one
 * solid row, so nobody can wedge themselves into the gap between two cabinets.
 */
export function obstaclesOf(racks: readonly Rack[]): Footprint[] {
  const MERGE_GAP = 0.8;
  const byRow = new Map<number, Footprint[]>();
  for (const { footprint } of racks) byRow.set(footprint.z, [...(byRow.get(footprint.z) ?? []), footprint]);

  return [...byRow.values()].flatMap((row) => {
    const sorted = [...row].sort((left, right) => left.x - right.x);
    const merged: { minX: number; maxX: number; z: number; depth: number }[] = [];
    for (const box of sorted) {
      const minX = box.x - box.width / 2;
      const maxX = box.x + box.width / 2;
      const last = merged.at(-1);
      if (last && minX - last.maxX < MERGE_GAP) {
        last.maxX = Math.max(last.maxX, maxX);
        last.depth = Math.max(last.depth, box.depth);
      } else {
        merged.push({ minX, maxX, z: box.z, depth: box.depth });
      }
    }
    return merged.map((span) => ({ x: (span.minX + span.maxX) / 2, z: span.z, width: span.maxX - span.minX, depth: span.depth }));
  });
}

export function rowSigns(cluster: ClusterState): { label: string; health: Health; x: number; z: number }[] {
  const deployment = cluster.deployments[0];
  if (!deployment) return [];
  const pods = visiblePods(cluster);
  return [
    {
      label: deployment.name,
      health: deploymentHealth(pods, deployment.poolSize),
      x: -4 + ((Math.max(pods.length, 1) - 1) * 1.05) / 2,
      z: COMPUTE_ROW_Z,
    },
  ];
}
