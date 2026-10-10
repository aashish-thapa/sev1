import type { Commerce } from "./commerce.ts";

/** A defect a build carries. The engine applies its physics; rolling back removes it. */
export type Trait = ConnectionLeak | CrashWhileServing;

export type ConnectionLeak = {
  readonly kind: "leaks-connection-on-dependency-timeout";
  readonly dependency: string;
  /** Expected leaked connections per second for a pod serving `perPodBaselineRps`. */
  readonly leaksPerSecondAtBaseline: number;
  readonly perPodBaselineRps: number;
};

/** Why the kubelet last saw a container die, as `kubectl describe pod` reports it. */
export type Termination = { readonly reason: "OOMKilled" | "Error"; readonly exitCode: number };

/**
 * The build passes readiness, then dies after serving for a while: a memory leak hits its
 * limit, or the first real request reaches a code path that throws.
 */
export type CrashWhileServing = {
  readonly kind: "crashes-while-serving";
  readonly termination: Termination;
  /** Seconds of serving before the crash; each pod adds up to `jitterSeconds` so they don't die in lockstep. */
  readonly afterSeconds: number;
  readonly jitterSeconds: number;
  /** The last line the process logs before it dies. */
  readonly lastWords: string;
  /** True when the defect sits on the checkout path, so every checkout the build serves fails too. */
  readonly failsCheckouts: boolean;
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
  /** Absent until the container has died at least once. */
  readonly lastTermination?: Termination;
};

export type Deployment = {
  readonly name: string;
  readonly replicas: number;
  readonly poolSize: number;
  /** Requests per second one pod can serve before it sheds the rest; absent means unlimited. */
  readonly podCapacityRps?: number;
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
  /** The index checkout's hot query relies on; absent where the scenario never touches it. */
  readonly hotIndex?: HotIndex;
};

/** How an index rebuild is running: CONCURRENTLY keeps the table writable, a plain REINDEX locks it. */
export type IndexRebuild = { readonly secondsLeft: number; readonly isLocking: boolean };

/**
 * An index on `orders` the checkout query needs. While it's invalid Postgres ignores it and
 * every checkout seq-scans the table; the longer that goes on, the more the scans evict the
 * hot set from shared_buffers (`cacheEviction`, 0…1) and the slower each one gets.
 */
export type HotIndex = {
  readonly name: string;
  readonly definition: string;
  /** The checkout query that needs this index. */
  readonly query: string;
  readonly isValid: boolean;
  readonly cacheEviction: number;
  readonly rebuild: IndexRebuild | null;
};

export type Traffic = {
  readonly requestsPerSecond: number;
  /** Share of requests that are checkouts (and call the dependency). */
  readonly checkoutShare: number;
  readonly connectionHoldSeconds: number;
};

/** A finished Kubernetes Job (a migration, a backfill); its output is in `logs` under its name. */
export type Job = {
  readonly name: string;
  readonly status: "Complete" | "Failed";
  /** Simulated second it finished; negative when that was before the page. */
  readonly finishedAt: number;
  readonly durationSeconds: number;
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
  /** Jobs that ran recently; absent where the scenario has none. */
  readonly jobs?: readonly Job[];
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
