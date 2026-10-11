import { alertRate } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { openConnections } from "./sim/engine.ts";
import { isLive, type ClusterState, type Pod } from "./sim/model.ts";

export type Health = "ok" | "warn" | "critical" | "pending";

export const HEALTH_GLYPH: Record<Health, string> = { ok: "●", warn: "◆", critical: "▲", pending: "○" };
export const HEALTH_WORD: Record<Health, string> = { ok: "healthy", warn: "degraded", critical: "failing", pending: "starting" };

/** Identifies anything the player can inspect, on the map or on the floor. */
export type NodeId = { kind: "edge" } | { kind: "pod"; name: string } | { kind: "database" } | { kind: "external"; id: string };

export function sameNode(left: NodeId | null, right: NodeId | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function podHealth(pod: Pod, poolSize: number): Health {
  if (pod.phase === "CrashLoopBackOff") return "critical";
  if (pod.phase === "Starting" || pod.phase === "Terminating") return "pending";
  if (pod.leaked >= poolSize) return "critical";
  return pod.leaked >= poolSize * 0.7 ? "warn" : "ok";
}

export function deploymentHealth(pods: readonly Pod[], poolSize: number): Health {
  const health = pods.map((pod) => podHealth(pod, poolSize));
  if (health.includes("critical")) return "critical";
  if (health.includes("warn")) return "warn";
  return health.length > 0 && health.every((value) => value === "pending") ? "pending" : "ok";
}

/** Lit by the rate the pager watches, so a scenario paging on lost customers doesn't look healthy. */
export function edgeHealth(cluster: ClusterState, scenario: Scenario): Health {
  const rate = alertRate(scenario, cluster);
  return rate > 0.05 ? "critical" : rate > 0.01 ? "warn" : "ok";
}

export function databaseHealth(cluster: ClusterState): Health {
  const capacity = cluster.database.maxConnections - cluster.database.reservedConnections;
  const connections = openConnections(cluster.deployments);
  return connections >= capacity ? "critical" : connections >= capacity * 0.85 ? "warn" : "ok";
}

export function visiblePods(cluster: ClusterState): readonly Pod[] {
  return cluster.deployments[0]?.pods.filter((pod) => isLive(pod) || pod.phase === "Terminating") ?? [];
}
