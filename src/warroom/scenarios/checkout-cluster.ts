import { seededRandom } from "../../domain/random.ts";
import { podName, step } from "../sim/engine.ts";
import { isLive, revisionOf, templateHash, type ClusterEvent, type ClusterState, type Deployment, type LogEntry, type Pod } from "../sim/model.ts";

export const CHECKOUT = "checkout-api";
const WARM_UP_SECONDS = 30;
/** One pod's ceiling: three pods carry 300 rps with headroom, two shed some of it, one sheds most. */
const POD_CAPACITY_RPS = 130;

type ClusterSetup = {
  /** Seeds the warm-up, so every player opens on the same logs and graphs. */
  readonly seed: string;
  readonly revisions: Deployment["revisions"];
  /** The revision the pods run (and the deployment points at) when the incident opens. */
  readonly revision: number;
  readonly replicas?: number;
  /** Pods already running when the warm-up starts; defaults to `replicas`. */
  readonly runningPods?: number;
  /** Seconds before the page that the running pods started. */
  readonly podsStartedAgo?: number;
  readonly events?: readonly ClusterEvent[];
  readonly logs?: Readonly<Record<string, readonly LogEntry[]>>;
};

/**
 * The checkout-api cluster most infra incidents happen to: three pods with pools of 20 on orders-db,
 * 300 rps, 40% of it checkouts. Runs the outage up to the moment the page fires, so logs and graphs
 * already have history, then zeroes the damage counters so scoring starts at the page.
 */
export function checkoutCluster(setup: ClusterSetup): ClusterState {
  const replicas = setup.replicas ?? 3;
  const hash = templateHash(CHECKOUT, setup.revision, 0);
  const startedAgo = setup.podsStartedAgo ?? 1_200;
  const pods: Pod[] = Array.from({ length: setup.runningPods ?? replicas }, (_, index) => ({
    name: podName(CHECKOUT, hash, index + 1),
    templateHash: hash,
    revision: setup.revision,
    phase: "Running",
    startedAt: -startedAgo - index * 35,
    phaseLeft: 0,
    leaked: 0,
    restarts: 0,
    connectionHistory: [],
  }));

  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [
      { name: CHECKOUT, replicas, poolSize: 20, podCapacityRps: POD_CAPACITY_RPS, revision: setup.revision, generation: 0, revisions: setup.revisions, pods },
    ],
    database: { name: "orders-db", host: "orders-db.internal", maxConnections: 100, reservedConnections: 3 },
    traffic: { requestsPerSecond: 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 },
    logs: setup.logs ?? {},
    events: setup.events ?? [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: pods.length,
  };
  const random = seededRandom(`${setup.seed}:warm-up`);
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

/** True once no live pod, and not the deployment itself, runs a build with a known defect. */
export function isOnCleanBuild(state: ClusterState): boolean {
  return state.deployments.every(
    (deployment) =>
      deployment.pods.filter(isLive).every((pod) => revisionOf(deployment, pod.revision).traits.length === 0) &&
      revisionOf(deployment, deployment.revision).traits.length === 0,
  );
}
