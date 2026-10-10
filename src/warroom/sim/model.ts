import type { Commerce } from "./commerce.ts";

/** A defect a build carries. The engine applies its physics; rolling back removes it. */
export type Trait = {
  readonly kind: "leaks-connection-on-dependency-timeout";
  readonly dependency: string;
  /** Expected leaked connections per second for a pod serving `perPodBaselineRps`. */
  readonly leaksPerSecondAtBaseline: number;
  readonly perPodBaselineRps: number;
};

export type Revision = {
  readonly number: number;
  readonly tag: string;
  readonly changeCause: string;
  readonly traits: readonly Trait[];
};

export type PodPhase = "Starting" | "Running" | "CrashLoopBackOff" | "Terminating";

export type Pod = {
  readonly name: string;
  readonly templateHash: string;
  readonly revision: number;
  readonly phase: PodPhase;
  readonly startedAt: number;
  /** Seconds left in the current phase (startup, back-off, termination grace). */
  readonly phaseLeft: number;
  readonly leaked: number;
  readonly restarts: number;
  readonly connectionHistory: readonly number[];
};

export type Deployment = {
  readonly name: string;
  readonly replicas: number;
  readonly poolSize: number;
  readonly revision: number;
  /** Bumped by `rollout restart` so identical revisions still roll. */
  readonly generation: number;
  readonly revisions: readonly Revision[];
  readonly pods: readonly Pod[];
};

export type Database = {
  readonly name: string;
  readonly host: string;
  readonly maxConnections: number;
  readonly reservedConnections: number;
};

export type Traffic = {
  readonly requestsPerSecond: number;
  /** Share of requests that are checkouts (and call the dependency). */
  readonly checkoutShare: number;
  readonly connectionHoldSeconds: number;
};

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export type LogEntry = {
  readonly t: number;
  readonly source: string;
  readonly level: LogLevel;
  readonly text: string;
};

export type ClusterEvent = {
  readonly t: number;
  readonly type: "Normal" | "Warning";
  readonly reason: string;
  readonly object: string;
  readonly message: string;
};

export type SeriesName = "errorRate" | "p99Ms" | "dbConnections";

export type ClusterState = {
  /** Seconds since the incident opened. */
  readonly t: number;
  readonly deployments: readonly Deployment[];
  readonly database: Database;
  readonly traffic: Traffic;
  readonly logs: Readonly<Record<string, readonly LogEntry[]>>;
  readonly events: readonly ClusterEvent[];
  readonly series: Readonly<Record<SeriesName, readonly number[]>>;
  readonly errorRate: number;
  readonly failedCheckouts: number;
  readonly healthyFor: number;
  readonly crashLoopsCaused: number;
  readonly sessionsTerminated: number;
  /** Monotonic counter feeding deterministic pod names. */
  readonly nameCounter: number;
  /** Clients, edge, payment gateway and ledger around the cluster; absent in cluster-only scenarios. */
  readonly commerce?: Commerce;
};

export const POD_STARTUP_SECONDS = 15;
export const TERMINATION_GRACE_SECONDS = 5;
export const SERIES_LENGTH = 90;
export const LOG_LIMIT = 120;

export function appendCapped(series: readonly number[], value: number, limit: number): readonly number[] {
  const next = [...series, value];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function isLive(pod: Pod): boolean {
  return pod.phase !== "Terminating";
}

/** Readiness is a shallow /healthz that never touches the database — a starved pod still serves (and fails). */
export function isServing(pod: Pod): boolean {
  return pod.phase === "Running";
}

export function holdsPool(pod: Pod): boolean {
  return pod.phase === "Running" || pod.phase === "Terminating";
}

export function currentTemplateHash(deployment: Deployment): string {
  return templateHash(deployment.name, deployment.revision, deployment.generation);
}

export function templateHash(name: string, revision: number, generation: number): string {
  let hash = 2166136261;
  for (const char of `${name}:${revision}:${generation}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  // Kubernetes' pod-template-hash alphabet avoids vowels and look-alike digits.
  const alphabet = "bcdfghjklmnpqrstvwxz2456789";
  let seed = hash >>> 0;
  let out = "";
  for (let index = 0; index < 9; index += 1) {
    out += alphabet[seed % alphabet.length];
    seed = Math.imul(seed ^ (seed >>> 13), 2654435761) >>> 0;
  }
  return out;
}

export function revisionOf(deployment: Deployment, number: number): Revision {
  const revision = deployment.revisions.find((candidate) => candidate.number === number);
  if (!revision) throw new Error(`${deployment.name} has no revision ${number}`);
  return revision;
}
