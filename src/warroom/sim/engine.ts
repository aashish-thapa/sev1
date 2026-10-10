import type { Random } from "../../domain/random.ts";
import { commerceDemand, lostCheckouts, plainLoad, settleCommerce, type Load } from "./commerce-step.ts";
import { checkoutQuerySeconds, stepHotIndex } from "./database.ts";
import {
  appendCapped,
  currentTemplateHash,
  holdsPool,
  isLive,
  isServing,
  LOG_LIMIT,
  POD_STARTUP_SECONDS,
  revisionOf,
  SERIES_LENGTH,
  TERMINATION_GRACE_SECONDS,
  type ClusterEvent,
  type ClusterState,
  type CrashWhileServing,
  type Deployment,
  type HotIndex,
  type LogEntry,
  type LogLevel,
  type Pod,
  type SeriesName,
} from "./model.ts";

const HEALTHY_ERROR_RATE = 0.01;
const POOL_TIMEOUT_MS = 30_000;

/** Advances the cluster by one simulated second. Never mutates `state`. */
export function step(state: ClusterState, random: Random): ClusterState {
  const t = state.t + 1;
  const journal = new Journal(state, t);
  let nameCounter = state.nameCounter;
  const nextName = (deployment: Deployment, hash: string) => {
    nameCounter += 1;
    return podName(deployment.name, hash, nameCounter);
  };

  let open = openConnections(state.deployments);
  const capacity = state.database.maxConnections - state.database.reservedConnections;

  const lifecycled = state.deployments.map((deployment) => {
    const pods = deployment.pods.flatMap((pod): Pod[] => {
      const left = pod.phaseLeft - 1;
      if (pod.phase === "Terminating") {
        if (left > 0) return [{ ...pod, phaseLeft: left }];
        open -= deployment.poolSize;
        return [];
      }
      if (pod.phase === "CrashLoopBackOff") {
        return [left > 0 ? { ...pod, phaseLeft: left } : { ...pod, phase: "Starting", phaseLeft: POD_STARTUP_SECONDS }];
      }
      if (pod.phase === "Running") {
        const crash = crashDue(deployment, pod, t);
        if (!crash) return [pod];
        open -= deployment.poolSize;
        journal.died(deployment, pod, crash);
        const restarts = pod.restarts + 1;
        return [{ ...pod, phase: "CrashLoopBackOff", phaseLeft: backOffSeconds(restarts), restarts, lastTermination: crash.termination }];
      }
      if (pod.phase === "Starting") {
        if (left > 0) return [{ ...pod, phaseLeft: left }];
        if (open + deployment.poolSize > capacity) {
          journal.crash(deployment, pod, state.database);
          const restarts = pod.restarts + 1;
          return [{ ...pod, phase: "CrashLoopBackOff", phaseLeft: backOffSeconds(restarts), restarts, lastTermination: { reason: "Error", exitCode: 1 } }];
        }
        open += deployment.poolSize;
        journal.log(pod.name, "INFO", `Started ${applicationName(deployment)} in ${(13 + random() * 3).toFixed(3)} seconds (process running for ${(14 + random() * 3).toFixed(3)})`);
        return [{ ...pod, phase: "Running", phaseLeft: 0, startedAt: t, leaked: 0 }];
      }
      return [pod];
    });
    return { ...deployment, pods };
  });

  const reconciled = lifecycled.map((deployment) => reconcile(deployment, t, nextName, journal));
  const demand = state.commerce ? commerceDemand(state, state.commerce) : null;
  const load = demand ?? plainLoad(state.traffic);
  const [front, ...rest] = reconciled;
  const checkoutQuery = checkoutQuerySeconds(state.database);
  const holdSeconds = state.traffic.connectionHoldSeconds + load.checkoutShare * checkoutQuery;
  const routed = front ? routeTraffic(front, load, holdSeconds, t, random, journal) : null;
  const deployments = routed ? [routed.deployment, ...rest] : reconciled;

  const failedRps = routed?.failedRps ?? load.requestsPerSecond;
  const errorRate = load.requestsPerSecond > 0 ? failedRps / load.requestsPerSecond : 0;
  const checkoutAttempts = load.requestsPerSecond * load.checkoutShare;
  const checkoutFailureRate = routed && checkoutAttempts > 0 ? Math.min(1, routed.checkoutFailedRps / checkoutAttempts) : 1;
  const dbConnections = openConnections(deployments);
  const p99Ms = errorRate > HEALTHY_ERROR_RATE ? POOL_TIMEOUT_MS + random() * 900 : 38 + checkoutQuery * 1000 + random() * 30;
  const hotIndex = state.database.hotIndex;
  if (hotIndex) journal.indexActivity(state.database.name, hotIndex, checkoutQuery, random);
  const database = hotIndex ? { ...state.database, hotIndex: stepHotIndex(hotIndex) } : state.database;
  const commerce =
    state.commerce && demand
      ? settleCommerce(state.commerce, demand, { t, gatewayCallsPerSecond: routed?.gatewayCallsPerSecond ?? 0, checkoutFailureRate }, (source, level, text) => journal.log(source, level, text))
      : undefined;

  return {
    ...state,
    t,
    deployments,
    database,
    nameCounter,
    logs: journal.logs(),
    events: journal.events(),
    series: {
      errorRate: pushSeries(state.series.errorRate, errorRate),
      p99Ms: pushSeries(state.series.p99Ms, p99Ms),
      dbConnections: pushSeries(state.series.dbConnections, dbConnections),
    } satisfies Record<SeriesName, readonly number[]>,
    errorRate,
    failedCheckouts: state.failedCheckouts + (demand ? lostCheckouts(demand, checkoutFailureRate) : failedRps * state.traffic.checkoutShare),
    healthyFor: errorRate < HEALTHY_ERROR_RATE ? state.healthyFor + 1 : 0,
    crashLoopsCaused: state.crashLoopsCaused + journal.crashes,
    ...(commerce ? { commerce } : {}),
  };
}

export function openConnections(deployments: readonly Deployment[]): number {
  return deployments.reduce((sum, deployment) => sum + deployment.pods.filter(holdsPool).length * deployment.poolSize, 0);
}

/** RollingUpdate with maxSurge 1 / maxUnavailable 0, plus plain replica scaling. */
function reconcile(
  deployment: Deployment,
  t: number,
  nextName: (deployment: Deployment, hash: string) => string,
  journal: Journal,
): Deployment {
  const hash = currentTemplateHash(deployment);
  let pods = [...deployment.pods];
  const live = () => pods.filter(isLive);
  const current = () => live().filter((pod) => pod.templateHash === hash);
  const old = () => live().filter((pod) => pod.templateHash !== hash);

  const create = () => {
    const name = nextName(deployment, hash);
    pods.push({
      name,
      templateHash: hash,
      revision: deployment.revision,
      phase: "Starting",
      startedAt: t,
      phaseLeft: POD_STARTUP_SECONDS,
      leaked: 0,
      restarts: 0,
      connectionHistory: [],
    });
    journal.event("Normal", "Scheduled", `pod/${name}`, `Successfully assigned default/${name} to ip-10-0-12-${40 + (name.length % 50)}`);
  };
  const terminate = (pod: Pod) => {
    pods = pods.map((candidate) =>
      candidate.name === pod.name ? { ...candidate, phase: "Terminating", phaseLeft: TERMINATION_GRACE_SECONDS } : candidate,
    );
    journal.event("Normal", "Killing", `pod/${pod.name}`, `Stopping container ${deployment.name}`);
  };

  if (old().length > 0) {
    if (current().length < deployment.replicas && live().length < deployment.replicas + 1) create();
    const servingCurrent = current().filter(isServing).length;
    if (servingCurrent + old().length > deployment.replicas) {
      const victim = [...old()].sort((left, right) => Number(isServing(left)) - Number(isServing(right)))[0];
      if (victim) terminate(victim);
    }
  } else {
    while (current().length < deployment.replicas) create();
    const extra = current().length - deployment.replicas;
    [...current()].sort((left, right) => right.startedAt - left.startedAt).slice(0, Math.max(0, extra)).forEach(terminate);
  }
  return { ...deployment, pods };
}

function routeTraffic(deployment: Deployment, load: Load, connectionHoldSeconds: number, t: number, random: Random, journal: Journal) {
  const { requestsPerSecond, checkoutShare, gatewayFailShare, leakPressure, rejectedCheckoutShare, declinedCheckoutShare } = load;
  const serving = deployment.pods.filter(isServing);
  const offeredPerPod = serving.length > 0 ? requestsPerSecond / serving.length : 0;
  // Past its capacity a pod sheds the overflow; with no capacity set, any pod copes with any load.
  const perPodRps = Math.min(offeredPerPod, deployment.podCapacityRps ?? Infinity);
  const shedRps = (offeredPerPod - perPodRps) * serving.length;
  let failedRps = serving.length > 0 ? shedRps : requestsPerSecond;
  let checkoutFailedRps = serving.length > 0 ? shedRps * checkoutShare : requestsPerSecond * checkoutShare;
  let gatewayCallsPerSecond = 0;

  if (serving.length === 0 && t % 4 === 0) {
    journal.log("edge-lb", "ERROR", `"POST /checkout HTTP/1.1" 503 UH 0 19 0 - "-" "checkout-web/4.2" upstream=${deployment.name}`);
  } else if (shedRps > 0 && t % 4 === 0) {
    journal.log("edge-lb", "ERROR", `"POST /checkout HTTP/1.1" 503 UO 0 81 0 - "-" "checkout-web/4.2" upstream=${deployment.name} (upstream overflow)`);
  }

  const pods = deployment.pods.map((pod, index): Pod => {
    if (pod.phase !== "Running") return pod;
    const isPodServing = isServing(pod);
    const demand = isPodServing ? perPodRps * connectionHoldSeconds : 0;
    let leaked = pod.leaked;
    const available = deployment.poolSize - leaked;
    const failFraction = !isPodServing ? 0 : available <= 0 ? 1 : Math.max(0, 1 - available / demand);
    failedRps += perPodRps * failFraction;
    // A build that throws on checkout fails every checkout it reaches, before any gateway call;
    // a client defect fails its share of them the same way.
    const reachedCheckouts = isPodServing ? perPodRps * (1 - failFraction) * checkoutShare : 0;
    const thrown = reachedCheckouts * (throwsOnCheckout(deployment, pod) ? 1 : rejectedCheckoutShare);
    failedRps += thrown;
    checkoutFailedRps += thrown;
    // Starved requests fail before checkout-api ever calls the gateway; the rest may time out there.
    // A fraud decline ends the checkout before the gateway too, without failing the request.
    const gatewayCalls = (reachedCheckouts - thrown) * (1 - declinedCheckoutShare);
    const gatewayFailed = gatewayCalls * gatewayFailShare;
    failedRps += gatewayFailed;
    checkoutFailedRps += perPodRps * failFraction * checkoutShare + gatewayFailed;
    gatewayCallsPerSecond += gatewayCalls;

    for (const trait of revisionOf(deployment, pod.revision).traits) {
      if (trait.kind !== "leaks-connection-on-dependency-timeout") continue;
      const reached = perPodRps * (1 - failFraction);
      const leakRate = trait.leaksPerSecondAtBaseline * (reached / trait.perPodBaselineRps) * leakPressure;
      if (isPodServing && leaked < deployment.poolSize && random() < leakRate) {
        leaked += 1;
        journal.log(pod.name, "WARN", `${trait.dependency} POST /v1/charges timed out after 3000ms (attempt 3/3) order=ord_${Math.floor(random() * 9e6 + 1e6)}`);
      }
    }

    if (failFraction > 0 && (t + index) % 3 === 0) {
      const waiting = Math.max(1, Math.min(200, Math.round(perPodRps * failFraction * 1.6)) - Math.floor(random() * 9));
      journal.log(
        pod.name,
        "ERROR",
        `java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after ${POOL_TIMEOUT_MS + Math.floor(random() * 3)}ms (total=${deployment.poolSize}, active=${deployment.poolSize}, idle=0, waiting=${waiting})`,
      );
    } else if (gatewayFailShare > 0.15 && gatewayCalls > 0 && (t + index) % 3 === 1) {
      const order = `ord_${((t * 7919 + index * 104_729) % 9_000_000) + 1_000_000}`;
      journal.log(pod.name, "WARN", `PaymentGatewayClient - POST /v1/charges order=${order} idempotency-key=${order}: java.net.SocketTimeoutException: Read timed out after 3000ms`);
      journal.log(pod.name, "ERROR", `POST /checkout 504 dur=${9000 + ((t * 31 + index * 17) % 400)}ms order=${order} error=PAYMENT_GATEWAY_TIMEOUT`);
    } else if (isPodServing && failFraction === 0 && (t + index) % 5 === 0) {
      journal.log(pod.name, "INFO", `POST /checkout 201 dur=${Math.round(35 + random() * 40)}ms`);
    }

    const active = Math.min(deployment.poolSize, Math.round(leaked + demand));
    return { ...pod, leaked, connectionHistory: pushSeries(pod.connectionHistory, active) };
  });

  return { deployment: { ...deployment, pods }, failedRps, checkoutFailedRps, gatewayCallsPerSecond };
}

/** Kubelet's restart back-off: 10 s doubling per restart, capped at five minutes. */
function backOffSeconds(restarts: number): number {
  return Math.min(10 * 2 ** (restarts - 1), 300);
}

function throwsOnCheckout(deployment: Deployment, pod: Pod): boolean {
  return revisionOf(deployment, pod.revision).traits.some((trait) => trait.kind === "crashes-while-serving" && trait.failsCheckouts);
}

/** The crash this running pod's build has coming now, if any. */
function crashDue(deployment: Deployment, pod: Pod, t: number): CrashWhileServing | undefined {
  const serving = t - pod.startedAt;
  return revisionOf(deployment, pod.revision).traits.find(
    (trait): trait is CrashWhileServing => trait.kind === "crashes-while-serving" && serving >= trait.afterSeconds + jitter(pod.name, trait.jitterSeconds),
  );
}

/** A stable per-pod offset in [0, spread), so a pod's crash time doesn't change between ticks. */
function jitter(name: string, spread: number): number {
  let hash = 0;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 2654435761) >>> 0;
  return spread > 0 ? hash % spread : 0;
}

function applicationName(deployment: Deployment): string {
  return deployment.name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
    .replace(/Api$/, "Application");
}

export function podName(deploymentName: string, hash: string, counter: number): string {
  const alphabet = "bcdfghjklmnpqrstvwxz2456789";
  let seed = Math.imul(counter + 7919, 2654435761) >>> 0;
  let suffix = "";
  for (let index = 0; index < 5; index += 1) {
    suffix += alphabet[seed % alphabet.length];
    seed = Math.floor(seed / alphabet.length) + index * 131;
  }
  return `${deploymentName}-${hash}-${suffix}`;
}

function pushSeries(series: readonly number[], value: number): readonly number[] {
  return appendCapped(series, value, SERIES_LENGTH);
}

/** Collects the side output of one tick: log lines, k8s events, crash count. */
class Journal {
  crashes = 0;
  private readonly appended = new Map<string, LogEntry[]>();
  private readonly newEvents: ClusterEvent[] = [];
  private readonly state: ClusterState;
  private readonly t: number;

  constructor(state: ClusterState, t: number) {
    this.state = state;
    this.t = t;
  }

  log(source: string, level: LogLevel, text: string) {
    const list = this.appended.get(source) ?? [];
    list.push({ t: this.t, source, level, text });
    this.appended.set(source, list);
  }

  event(type: ClusterEvent["type"], reason: string, object: string, message: string) {
    this.newEvents.push({ t: this.t, type, reason, object, message });
  }

  crash(deployment: Deployment, pod: Pod, database: ClusterState["database"]) {
    this.crashes += pod.restarts === 0 ? 1 : 0;
    this.log(pod.name, "ERROR", "HikariPool-1 - Exception during pool initialization.");
    this.log(pod.name, "FATAL", `org.postgresql.util.PSQLException: FATAL: sorry, too many clients already`);
    this.log(database.name, "FATAL", "sorry, too many clients already");
    this.event("Warning", "BackOff", `pod/${pod.name}`, `Back-off restarting failed container ${deployment.name} in pod ${pod.name}`);
  }

  /** What Postgres says about the hot index each second: slow seq scans, lock waits, a finished rebuild. */
  indexActivity(source: string, index: HotIndex, checkoutQuery: number, random: Random) {
    if (index.rebuild?.isLocking) {
      if (this.t % 3 === 0) {
        this.log(source, "INFO", `LOG:  process ${51_200 + Math.floor(random() * 700)} still waiting for RowExclusiveLock on relation 16421 of database 16384 after ${(1000 + random() * 400).toFixed(3)} ms`);
      }
    } else if (!index.isValid && this.t % 2 === 0) {
      this.log(source, "INFO", `LOG:  duration: ${(checkoutQuery * 1000 * (0.85 + random() * 0.3)).toFixed(3)} ms  execute <unnamed>: ${index.query}`);
    }
    if (index.rebuild && index.rebuild.secondsLeft <= 1) {
      this.log(source, "INFO", `LOG:  index "${index.name}" rebuilt; statement: REINDEX INDEX ${index.rebuild.isLocking ? "" : "CONCURRENTLY "}${index.name}`);
    }
  }

  died(deployment: Deployment, pod: Pod, crash: CrashWhileServing) {
    this.log(pod.name, crash.termination.reason === "OOMKilled" ? "WARN" : "FATAL", crash.lastWords);
    this.event(
      "Warning",
      "BackOff",
      `pod/${pod.name}`,
      `Back-off restarting failed container ${deployment.name} in pod ${pod.name}${crash.termination.reason === "OOMKilled" ? " (OOMKilled)" : ""}`,
    );
  }

  logs(): Record<string, readonly LogEntry[]> {
    const merged: Record<string, readonly LogEntry[]> = { ...this.state.logs };
    for (const [source, entries] of this.appended) {
      const next = [...(merged[source] ?? []), ...entries];
      merged[source] = next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
    }
    return merged;
  }

  events(): readonly ClusterEvent[] {
    const next = [...this.state.events, ...this.newEvents];
    return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
  }
}
