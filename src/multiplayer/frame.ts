import { z } from "zod";
import type { Commerce } from "../warroom/sim/commerce.ts";
import type { Incident } from "../warroom/incident.ts";
import type { ClusterEvent, ClusterState, Deployment, LogEntry, Pod, Revision, SeriesName } from "../warroom/sim/model.ts";

/**
 * Wire format for the incident. A full snapshot grows to ~90 KB (logs dominate), so after the first
 * frame the server only sends what changed: bounded append-only lists travel as `ListDelta`s and
 * static revision history is omitted until it changes. A full frame is a delta against nothing.
 */

/** `next = previous.slice(drop).concat(append)` — the shape of a bounded, append-only list. */
export type ListDelta<T> = { readonly drop: number; readonly append: readonly T[] };

const listDelta = <T extends z.ZodType>(item: T) => z.object({ drop: z.int().nonnegative(), append: z.array(item).readonly() });

const TraitSchema = z.object({
  kind: z.literal("leaks-connection-on-dependency-timeout"),
  dependency: z.string(),
  leaksPerSecondAtBaseline: z.number(),
  perPodBaselineRps: z.number(),
});

const RevisionSchema = z.object({
  number: z.int(),
  tag: z.string(),
  changeCause: z.string(),
  traits: z.array(TraitSchema).readonly(),
}) satisfies z.ZodType<Revision>;

const PodFrameSchema = z.object({
  name: z.string(),
  templateHash: z.string(),
  revision: z.int(),
  phase: z.enum(["Starting", "Running", "CrashLoopBackOff", "Terminating"]),
  startedAt: z.number(),
  phaseLeft: z.number(),
  leaked: z.number(),
  restarts: z.int(),
  connectionHistory: listDelta(z.number()),
});

const DeploymentFrameSchema = z.object({
  name: z.string(),
  replicas: z.int(),
  poolSize: z.int(),
  revision: z.int(),
  generation: z.int(),
  /** Absent when unchanged since the previous frame. */
  revisions: z.array(RevisionSchema).readonly().optional(),
  pods: z.array(PodFrameSchema),
});

const LogEntrySchema = z.object({
  t: z.number(),
  source: z.string(),
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]),
  text: z.string(),
}) satisfies z.ZodType<LogEntry>;

const ClusterEventSchema = z.object({
  t: z.number(),
  type: z.enum(["Normal", "Warning"]),
  reason: z.string(),
  object: z.string(),
  message: z.string(),
}) satisfies z.ZodType<ClusterEvent>;

const ClusterFrameSchema = z.object({
  t: z.number(),
  deployments: z.array(DeploymentFrameSchema),
  database: z.object({ name: z.string(), host: z.string(), maxConnections: z.int(), reservedConnections: z.int() }),
  traffic: z.object({ requestsPerSecond: z.number(), checkoutShare: z.number(), connectionHoldSeconds: z.number() }),
  /** Only sources that changed; `null` removes a source. */
  logs: z.record(z.string(), listDelta(LogEntrySchema).nullable()),
  events: listDelta(ClusterEventSchema),
  series: z.object({ errorRate: listDelta(z.number()), p99Ms: listDelta(z.number()), dbConnections: listDelta(z.number()) }),
  errorRate: z.number(),
  failedCheckouts: z.number(),
  healthyFor: z.number(),
  crashLoopsCaused: z.int(),
  sessionsTerminated: z.int(),
  nameCounter: z.int(),
  /**
   * Cross-role scenarios' shop-floor state (flags, client builds, gateway, WAF, ledger).
   * Sent whole and only when it changed; the server is the trusted source of it.
   */
  commerce: z.custom<Commerce>((value) => typeof value === "object" && value !== null).optional(),
});

export const IncidentPhaseSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("live") }),
  z.object({ name: z.literal("monitoring"), secondsLeft: z.number() }),
  z.object({ name: z.literal("closed"), closedAt: z.number() }),
]) satisfies z.ZodType<Incident["phase"]>;

export const IncidentFrameSchema = z.object({
  /** True when the frame stands alone (join, rejoin); false when it applies to the previous incident. */
  full: z.boolean(),
  phase: IncidentPhaseSchema,
  reopenCount: z.int().nonnegative(),
  declaredAt: z.number().nullable(),
  cluster: ClusterFrameSchema,
});
export type IncidentFrame = z.infer<typeof IncidentFrameSchema>;

/** Smallest `drop` such that the kept tail of `previous` prefixes `next`; always terminates at `drop = previous.length`. */
export function diffList<T>(previous: readonly T[], next: readonly T[]): ListDelta<T> {
  let drop = Math.max(0, previous.length - next.length);
  while (!keptTailPrefixes(previous, drop, next)) drop += 1;
  return { drop, append: next.slice(previous.length - drop) };
}

export function applyList<T>(previous: readonly T[], delta: ListDelta<T>): readonly T[] {
  if (delta.drop > previous.length) throw new RangeError(`delta drops ${delta.drop} of ${previous.length} items`);
  return [...previous.slice(delta.drop), ...delta.append];
}

function keptTailPrefixes<T>(previous: readonly T[], drop: number, next: readonly T[]): boolean {
  const kept = previous.length - drop;
  if (kept > next.length) return false;
  for (let index = 0; index < kept; index += 1) {
    if (!Object.is(previous[drop + index], next[index])) return false;
  }
  return true;
}

const EMPTY_CLUSTER_LISTS = {
  logs: {},
  events: [],
  series: { errorRate: [], p99Ms: [], dbConnections: [] },
} as const satisfies Pick<ClusterState, "logs" | "events" | "series">;

/** Encodes `next` relative to `previous`; pass `null` for a full frame. */
export function encodeFrame(previous: Incident | null, next: Incident): IncidentFrame {
  const base = previous?.cluster;
  const cluster = next.cluster;
  const previousDeployments = new Map(base?.deployments.map((deployment) => [deployment.name, deployment]));

  return {
    full: previous === null,
    phase: next.phase,
    reopenCount: next.reopenCount,
    declaredAt: next.declaredAt,
    cluster: {
      t: cluster.t,
      deployments: cluster.deployments.map((deployment) => encodeDeployment(previousDeployments.get(deployment.name), deployment)),
      database: cluster.database,
      traffic: cluster.traffic,
      logs: diffLogs(base?.logs ?? EMPTY_CLUSTER_LISTS.logs, cluster.logs),
      events: diffList(base?.events ?? EMPTY_CLUSTER_LISTS.events, cluster.events),
      series: mapSeries((name) => diffList(base?.series[name] ?? [], cluster.series[name])),
      errorRate: cluster.errorRate,
      failedCheckouts: cluster.failedCheckouts,
      healthyFor: cluster.healthyFor,
      crashLoopsCaused: cluster.crashLoopsCaused,
      sessionsTerminated: cluster.sessionsTerminated,
      nameCounter: cluster.nameCounter,
      ...(cluster.commerce && cluster.commerce !== base?.commerce ? { commerce: cluster.commerce } : {}),
    },
  };
}

/** Inverse of `encodeFrame`: `applyFrame(previous, encodeFrame(previous, next))` deep-equals `next`. */
export function applyFrame(previous: Incident | null, frame: IncidentFrame): Incident {
  if (!frame.full && previous === null) throw new Error("received a delta frame before any full frame");
  const base = frame.full ? null : previous?.cluster;
  const previousDeployments = new Map(base?.deployments.map((deployment) => [deployment.name, deployment]));
  const { cluster } = frame;

  return {
    phase: frame.phase,
    reopenCount: frame.reopenCount,
    declaredAt: frame.declaredAt,
    cluster: {
      ...cluster,
      deployments: cluster.deployments.map((deployment) => applyDeployment(previousDeployments.get(deployment.name), deployment)),
      logs: applyLogs(base?.logs ?? EMPTY_CLUSTER_LISTS.logs, cluster.logs),
      events: applyList(base?.events ?? EMPTY_CLUSTER_LISTS.events, cluster.events),
      series: mapSeries((name) => applyList(base?.series[name] ?? [], cluster.series[name])),
      ...withCommerce(cluster.commerce ?? base?.commerce),
    },
  };
}

function withCommerce(commerce: Commerce | undefined): { commerce?: Commerce } {
  return commerce ? { commerce } : {};
}

type DeploymentFrame = IncidentFrame["cluster"]["deployments"][number];

function encodeDeployment(previous: Deployment | undefined, next: Deployment): DeploymentFrame {
  const previousPods = new Map(previous?.pods.map((pod) => [pod.name, pod]));
  const { revisions, pods, ...rest } = next;
  return {
    ...rest,
    ...(previous?.revisions === revisions ? {} : { revisions }),
    pods: pods.map((pod) => ({
      ...pod,
      connectionHistory: diffList(previousPods.get(pod.name)?.connectionHistory ?? [], pod.connectionHistory),
    })),
  };
}

function applyDeployment(previous: Deployment | undefined, frame: DeploymentFrame): Deployment {
  const revisions = frame.revisions ?? previous?.revisions;
  if (!revisions) throw new Error(`frame omits revisions for unknown deployment ${frame.name}`);
  const previousPods = new Map(previous?.pods.map((pod) => [pod.name, pod]));
  return {
    ...frame,
    revisions,
    pods: frame.pods.map(
      (pod): Pod => ({ ...pod, connectionHistory: applyList(previousPods.get(pod.name)?.connectionHistory ?? [], pod.connectionHistory) }),
    ),
  };
}

type LogsFrame = IncidentFrame["cluster"]["logs"];

function diffLogs(previous: ClusterState["logs"], next: ClusterState["logs"]): LogsFrame {
  const frame: Record<string, ListDelta<LogEntry> | null> = {};
  for (const [source, entries] of Object.entries(next)) {
    if (previous[source] !== entries) frame[source] = diffList(previous[source] ?? [], entries);
  }
  for (const source of Object.keys(previous)) {
    if (!(source in next)) frame[source] = null;
  }
  return frame;
}

function applyLogs(previous: ClusterState["logs"], frame: LogsFrame): ClusterState["logs"] {
  const logs: Record<string, readonly LogEntry[]> = { ...previous };
  for (const [source, delta] of Object.entries(frame)) {
    if (delta === null) delete logs[source];
    else logs[source] = applyList(previous[source] ?? [], delta);
  }
  return logs;
}

const SERIES_NAMES = ["errorRate", "p99Ms", "dbConnections"] as const satisfies readonly SeriesName[];

function mapSeries<T>(build: (name: SeriesName) => T): Record<SeriesName, T> {
  return Object.fromEntries(SERIES_NAMES.map((name) => [name, build(name)])) as Record<SeriesName, T>;
}
