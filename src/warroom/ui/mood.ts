import type { Incident } from "../incident.ts";
import type { ClusterState } from "../sim/model.ts";

/** How bad it feels, 0..1: the failure rate dominates; monitoring is a held breath. */
export function panicOf(incident: Incident): number {
  if (incident.phase.name !== "live") return incident.phase.name === "monitoring" ? 0.1 : 0;
  return Math.min(1, incident.cluster.errorRate * 1.25);
}

/**
 * What the floor shows before anyone is paged: the same cluster with every pool
 * healthy and no failures, so the data centre looks like a normal Tuesday.
 */
export function calmView(cluster: ClusterState): ClusterState {
  return {
    ...cluster,
    deployments: cluster.deployments.map((deployment) => ({
      ...deployment,
      pods: deployment.pods.map((pod) => ({ ...pod, leaked: Math.min(pod.leaked, 2), connectionHistory: [] })),
    })),
    errorRate: 0,
    failedCheckouts: 0,
  };
}
