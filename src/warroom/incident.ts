import { seededRandom } from "../domain/random.ts";
import type { Objective, Scenario } from "./scenario.ts";
import { step } from "./sim/engine.ts";
import { currentTemplateHash, isLive, type ClusterState } from "./sim/model.ts";

/** Simulated seconds of quiet the incident must survive after "resolved" before it closes. */
export const MONITORING_SECONDS = 600;
/** Both gates apply to whichever rate the scenario pages on. */
const REOPEN_ERROR_RATE = 0.05;
const RESOLVABLE_ERROR_RATE = 0.01;
const DEFAULT_ALERT_LABEL = "checkout 5xx";
const UNMET_OBJECTIVE_PENALTY = 10;
const DEFAULT_LOST_CHECKOUTS_PER_POINT = 150;

export type IncidentPhase =
  | { readonly name: "live" }
  | { readonly name: "monitoring"; readonly secondsLeft: number }
  | { readonly name: "closed"; readonly closedAt: number };

export type Incident = {
  readonly cluster: ClusterState;
  readonly phase: IncidentPhase;
  readonly reopenCount: number;
  readonly declaredAt: number | null;
};

export type IncidentNotice =
  | { readonly kind: "reopened"; readonly rate: number; readonly label: string; readonly wasRollingOut: boolean }
  | { readonly kind: "closed" }
  | { readonly kind: "refused"; readonly rate: number; readonly label: string };

/** The rate the pager watches: the scenario's own metric, or checkout 5xx. */
export function alertRate(scenario: Scenario, cluster: ClusterState): number {
  return scenario.alertMetric?.rate(cluster) ?? cluster.errorRate;
}

export function alertLabel(scenario: Scenario): string {
  return scenario.alertMetric?.label ?? DEFAULT_ALERT_LABEL;
}

export function openIncident(scenario: Scenario): Incident {
  return { cluster: scenario.initialState(), phase: { name: "live" }, reopenCount: 0, declaredAt: null };
}

/** Pure: each second's randomness derives from the scenario seed and the clock, so replays are exact. */
export function advance(incident: Incident, scenario: Scenario): { incident: Incident; notice?: IncidentNotice } {
  if (incident.phase.name === "closed") return { incident };
  const cluster = step(incident.cluster, seededRandom(`${scenario.seed}:${incident.cluster.t}`));

  if (incident.phase.name === "monitoring") {
    const rate = alertRate(scenario, cluster);
    if (rate > REOPEN_ERROR_RATE) {
      return {
        incident: { ...incident, cluster, phase: { name: "live" }, reopenCount: incident.reopenCount + 1 },
        notice: { kind: "reopened", rate, label: alertLabel(scenario), wasRollingOut: isRollingOut(cluster) },
      };
    }
    const secondsLeft = incident.phase.secondsLeft - 1;
    if (secondsLeft <= 0) {
      return { incident: { ...incident, cluster, phase: { name: "closed", closedAt: cluster.t } }, notice: { kind: "closed" } };
    }
    return { incident: { ...incident, cluster, phase: { name: "monitoring", secondsLeft } } };
  }
  return { incident: { ...incident, cluster } };
}

export function isRollingOut(cluster: ClusterState): boolean {
  return cluster.deployments.some((deployment) => {
    const hash = currentTemplateHash(deployment);
    return deployment.pods.some((pod) => isLive(pod) && pod.templateHash !== hash);
  });
}

export function declareResolved(incident: Incident, scenario: Scenario): { incident: Incident; notice?: IncidentNotice } {
  if (incident.phase.name !== "live") return { incident };
  const rate = alertRate(scenario, incident.cluster);
  if (rate >= RESOLVABLE_ERROR_RATE) {
    return { incident, notice: { kind: "refused", rate, label: alertLabel(scenario) } };
  }
  return {
    incident: { ...incident, phase: { name: "monitoring", secondsLeft: MONITORING_SECONDS }, declaredAt: incident.cluster.t },
  };
}

export type Grade = "S" | "A" | "B" | "C" | "D";

export type Debrief = {
  readonly points: number;
  readonly grade: Grade;
  readonly failedCheckouts: number;
  readonly minutesToResolve: number;
  readonly reopenCount: number;
  readonly crashLoopsCaused: number;
  readonly isRootCauseFixed: boolean;
  readonly isPostmortemCorrect: boolean;
  /** Per-role outcomes; absent when a debrief comes off the wire from an older client. */
  readonly objectives?: readonly Objective[];
};

export function debrief(incident: Incident, scenario: Scenario, isPostmortemCorrect: boolean): Debrief {
  const { cluster } = incident;
  const isRootCauseFixed = scenario.isRootCauseFixed(cluster);
  const failedCheckouts = Math.round(cluster.failedCheckouts);
  const objectives = scenario.objectives?.(cluster) ?? [];
  const penalties =
    objectives.filter((objective) => !objective.isMet).length * UNMET_OBJECTIVE_PENALTY +
    failedCheckouts / (scenario.lostCheckoutsPerPoint ?? DEFAULT_LOST_CHECKOUTS_PER_POINT) +
    incident.reopenCount * 15 +
    cluster.crashLoopsCaused * 5 +
    (isRootCauseFixed ? 0 : 25) +
    (isPostmortemCorrect ? 0 : 15);
  const points = Math.max(0, Math.round(100 - penalties));
  return {
    points,
    grade: points >= 90 ? "S" : points >= 75 ? "A" : points >= 55 ? "B" : points >= 35 ? "C" : "D",
    failedCheckouts,
    minutesToResolve: Math.round(((incident.declaredAt ?? cluster.t) / 60) * 10) / 10,
    reopenCount: incident.reopenCount,
    crashLoopsCaused: cluster.crashLoopsCaused,
    isRootCauseFixed,
    isPostmortemCorrect,
    objectives,
  };
}
