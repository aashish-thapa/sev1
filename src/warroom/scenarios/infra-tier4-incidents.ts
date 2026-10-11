import { seededRandom } from "../../domain/random.ts";
import type { CommsMessage, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import {
  isLive,
  isServing,
  revisionOf,
  templateHash,
  type ClusterState,
  type Database,
  type Deployment,
  type Job,
  type LogEntry,
  type Pod,
  type PodPhase,
  type Revision,
  type Termination,
} from "../sim/model.ts";

/**
 * Tier 4 infrastructure incidents: the usual fix (roll back, restart, scale, add disk) does nothing.
 * Four mechanics the simulator already has, each over data rows that change the story:
 * an index a failed build left INVALID, a connection leak or crash that predates the newest
 * revision, and a second workload holding the connections the paged service needs to start.
 */

const WARM_UP_SECONDS = 30;
/** One pod's ceiling: three carry 300 rps with headroom, fewer shed the overflow. */
const POD_CAPACITY_RPS = 130;
const MINUTE = 60;
const HOUR = 3600;

type PodSeed = {
  readonly leaked?: number;
  readonly phase?: PodPhase;
  readonly phaseLeft?: number;
  readonly restarts?: number;
  /** Seconds before the warm-up the pod (re)started. */
  readonly startedAgo?: number;
  readonly lastTermination?: Termination;
};

type DeploymentSeed = {
  readonly name: string;
  readonly poolSize: number;
  readonly revision: number;
  readonly revisions: readonly Revision[];
  readonly pods: readonly PodSeed[];
};

type ClusterSeed = {
  readonly seed: string;
  readonly front: DeploymentSeed;
  readonly others?: readonly DeploymentSeed[];
  readonly database: Database;
  readonly requestsPerSecond?: number;
  readonly logs?: Readonly<Record<string, readonly LogEntry[]>>;
  readonly jobs?: readonly Job[];
};

function podsOf(seed: DeploymentSeed): Pod[] {
  const hash = templateHash(seed.name, seed.revision, 0);
  return seed.pods.map((pod, index) => ({
    name: podName(seed.name, hash, index + 1),
    templateHash: hash,
    revision: seed.revision,
    phase: pod.phase ?? "Running",
    startedAt: -(pod.startedAgo ?? 1_200) - WARM_UP_SECONDS - index * 35,
    phaseLeft: pod.phaseLeft ?? 0,
    leaked: pod.leaked ?? 0,
    restarts: pod.restarts ?? 0,
    connectionHistory: [],
    ...(pod.lastTermination ? { lastTermination: pod.lastTermination } : {}),
  }));
}

function deploymentOf(seed: DeploymentSeed, isFront: boolean): Deployment {
  return {
    name: seed.name,
    replicas: seed.pods.length,
    poolSize: seed.poolSize,
    ...(isFront ? { podCapacityRps: POD_CAPACITY_RPS } : {}),
    revision: seed.revision,
    generation: 0,
    revisions: seed.revisions,
    pods: podsOf(seed),
  };
}

/** Builds the cluster and runs the outage up to the page, so logs and graphs already have history. */
function buildCluster(seed: ClusterSeed): ClusterState {
  const deployments = [deploymentOf(seed.front, true), ...(seed.others ?? []).map((other) => deploymentOf(other, false))];
  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments,
    database: seed.database,
    traffic: { requestsPerSecond: seed.requestsPerSecond ?? 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 },
    logs: seed.logs ?? {},
    events: [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: deployments.reduce((sum, deployment) => sum + deployment.pods.length, 0),
    ...(seed.jobs ? { jobs: seed.jobs } : {}),
  };
  const random = seededRandom(`${seed.seed}:warm-up`);
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

/** True once no live pod of any deployment, nor the deployment itself, runs a build with a defect. */
function isOnCleanBuild(state: ClusterState): boolean {
  return state.deployments.every(
    (deployment) =>
      deployment.pods.filter(isLive).every((pod) => revisionOf(deployment, pod.revision).traits.length === 0) &&
      revisionOf(deployment, deployment.revision).traits.length === 0,
  );
}

const ORDERS_DB: Database = { name: "orders-db", host: "orders-db.internal", maxConnections: 100, reservedConnections: 3 };

/** The story every row tells, whatever its mechanic. */
type Story = {
  readonly id: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly service: string;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly opensAtSecondOfDay: number;
  readonly lostCheckoutsPerPoint: number;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly suggestions: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function scenarioOf(story: Story, mechanics: Pick<Scenario, "initialState" | "isRootCauseFixed"> & Partial<Pick<Scenario, "objectives">>): Scenario {
  return {
    id: story.id,
    tier: 4,
    title: story.title,
    severity: story.severity,
    service: story.service,
    briefing: story.briefing,
    roles: ["infrastructure"],
    roleBriefings: { infrastructure: story.roleBriefing },
    opensAtSecondOfDay: story.opensAtSecondOfDay,
    seed: story.id,
    lostCheckoutsPerPoint: story.lostCheckoutsPerPoint,
    externals: [],
    comms: story.comms,
    hints: story.hints,
    suggestions: { infrastructure: story.suggestions },
    solution: { infrastructure: story.solution },
    postmortem: story.postmortem,
    ...mechanics,
  };
}

// ─── Mechanic 1: an index a failed build left INVALID. Rolling back the app changes nothing. ───

type IndexRow = Story & {
  readonly revision: number;
  readonly revisions: readonly Revision[];
  readonly index: { readonly name: string; readonly definition: string; readonly query: string; readonly cacheEviction: number };
  readonly job: Job;
  readonly jobLog: readonly { readonly t: number; readonly level: LogEntry["level"]; readonly text: string }[];
};

function invalidIndexIncident(row: IndexRow): Scenario {
  return scenarioOf(row, {
    initialState: () =>
      buildCluster({
        seed: row.id,
        front: { name: row.service, poolSize: 20, revision: row.revision, revisions: row.revisions, pods: [{}, {}, {}] },
        database: { ...ORDERS_DB, hotIndex: { ...row.index, isValid: false, rebuild: null } },
        logs: { [row.job.name]: row.jobLog.map((line) => ({ ...line, source: row.job.name })) },
        jobs: [row.job],
      }),
    isRootCauseFixed: (state) => state.database.hotIndex?.isValid ?? true,
  });
}

// ─── Mechanic 2 and 3: the defect predates the newest revision, so a plain undo lands on it again. ───

type HiddenDefectRow = Story & {
  readonly poolSize: number;
  readonly requestsPerSecond?: number;
  readonly revision: number;
  readonly revisions: readonly Revision[];
  readonly pods: readonly PodSeed[];
};

function hiddenDefectIncident(row: HiddenDefectRow): Scenario {
  return scenarioOf(row, {
    initialState: () =>
      buildCluster({
        seed: row.id,
        front: { name: row.service, poolSize: row.poolSize, revision: row.revision, revisions: row.revisions, pods: row.pods },
        database: ORDERS_DB,
        ...(row.requestsPerSecond ? { requestsPerSecond: row.requestsPerSecond } : {}),
      }),
    isRootCauseFixed: isOnCleanBuild,
  });
}

const leak = (dependency: string, leaksPerSecondAtBaseline: number): Revision["traits"][number] => ({
  kind: "leaks-connection-on-dependency-timeout",
  dependency,
  leaksPerSecondAtBaseline,
  perPodBaselineRps: 100,
});

// ─── Mechanic 4: another workload holds the connections the paged service needs to start. ───

type HogRow = Story & {
  readonly frontRevision: Revision;
  /** Pods the front service has Running; the rest crash-loop on "too many clients". */
  readonly runningFrontPods: number;
  readonly hog: { readonly name: string; readonly replicas: number; readonly poolSize: number; readonly revision: Revision; readonly logs: readonly string[] };
};

const FRONT_REPLICAS = 3;
const FRONT_POOL = 20;

/** Pool slots every deployment would hold at its desired replicas, against what orders-db allows. */
function fitsMaxConnections(state: ClusterState): boolean {
  const wanted = state.deployments.reduce((sum, deployment) => sum + deployment.replicas * deployment.poolSize, 0);
  return wanted <= state.database.maxConnections - state.database.reservedConnections;
}

/** Name of the front service's first crash-looping pod, for a worked solution's `kubectl logs`. */
function crashLoopingPod(row: HogRow): string {
  return podName(row.service, templateHash(row.service, row.frontRevision.number, 0), row.runningFrontPods + 1);
}

function hogIncident(row: HogRow): Scenario {
  const frontPods: PodSeed[] = Array.from({ length: FRONT_REPLICAS }, (_, index) =>
    index < row.runningFrontPods
      ? { startedAgo: 9 * HOUR }
      : { phase: "CrashLoopBackOff", phaseLeft: 2 + index * 3, restarts: 1, startedAgo: 40, lastTermination: { reason: "Error", exitCode: 1 } },
  );
  const objectives = (state: ClusterState): readonly Objective[] => {
    const front = state.deployments.find((deployment) => deployment.name === row.service);
    const ready = front?.pods.filter(isServing).length ?? 0;
    return [{ role: "infrastructure", label: `${row.service} back to ${FRONT_REPLICAS}/${FRONT_REPLICAS} ready`, isMet: ready >= FRONT_REPLICAS }];
  };
  return scenarioOf(row, {
    initialState: () =>
      buildCluster({
        seed: row.id,
        front: { name: row.service, poolSize: FRONT_POOL, revision: row.frontRevision.number, revisions: [row.frontRevision], pods: frontPods },
        others: [
          {
            name: row.hog.name,
            poolSize: row.hog.poolSize,
            revision: row.hog.revision.number,
            revisions: [row.hog.revision],
            pods: Array.from({ length: row.hog.replicas }, () => ({ startedAgo: 50 * MINUTE })),
          },
        ],
        database: ORDERS_DB,
        logs: Object.fromEntries(
          podsOf({ name: row.hog.name, poolSize: row.hog.poolSize, revision: row.hog.revision.number, revisions: [row.hog.revision], pods: Array.from({ length: row.hog.replicas }, () => ({})) }).map(
            (pod, podIndex) => [pod.name, row.hog.logs.map((text, index) => ({ t: -WARM_UP_SECONDS - 600 + index * 120 + podIndex * 7, source: pod.name, level: "INFO" as const, text }))],
          ),
        ),
      }),
    isRootCauseFixed: fitsMaxConnections,
    objectives,
  });
}

// ─── The rows ───

const INDEX_ROWS: readonly IndexRow[] = [
  {
    id: "infra-t4-cart-index-lock-timeout",
    title: "Cart stays slow after the rollback",
    severity: "SEV2",
    service: "cart-api",
    briefing:
      "PagerDuty: cart-api p99 over 2 s and 5xx climbing. The night on-call already rolled cart-api back from v3.8.0 at 07:58 and it got no better. You have kubectl and a psql role on orders-db. Find what the rollback didn’t touch.",
    roleBriefing: "cart-api reads pending orders from orders-db. It was rolled back an hour ago and is still slow; don’t assume the app is the problem.",
    opensAtSecondOfDay: 8 * HOUR + 41 * MINUTE,
    lostCheckoutsPerPoint: 300,
    revision: 15,
    revisions: [
      { number: 12, tag: "v3.7.3", changeCause: "v3.7.3 guest carts expire after 30 days", traits: [] },
      { number: 14, tag: "v3.8.0", changeCause: "v3.8.0 saved-for-later items in the cart drawer (migration 0311)", traits: [] },
      { number: 15, tag: "v3.7.4", changeCause: "v3.7.4 hotfix: cart badge count off by one", traits: [] },
    ],
    index: {
      name: "orders_pending_by_customer_idx",
      definition: "btree (customer_id, created_at DESC) WHERE status = 'pending'::text",
      query: "SELECT id, total_minor FROM orders WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      cacheEviction: 0.1,
    },
    job: { name: "migrate-0311", status: "Complete", finishedAt: -2 * HOUR, durationSeconds: 14 },
    jobLog: [
      { t: -2 * HOUR - 14, level: "INFO", text: "SET lock_timeout = '10s';" },
      { t: -2 * HOUR - 13, level: "INFO", text: "CREATE INDEX CONCURRENTLY orders_pending_by_customer_idx ON orders (customer_id, created_at DESC) WHERE status = 'pending';" },
      { t: -2 * HOUR - 3, level: "WARN", text: "ERROR:  canceling statement due to lock timeout" },
      { t: -2 * HOUR - 2, level: "INFO", text: "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_pending_legacy_idx;" },
      { t: -2 * HOUR, level: "INFO", text: "migration 0311 applied (3 statements, 1 warning)" },
    ],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 re-triggered — cart-api p99 > 2s and 5xx > 5%. Assigned to you." },
      { at: 30, from: "Ivo Petrov · Night on-call", text: "I rolled cart-api back to v3.7.4 before handing over. It helped for about a minute, I think." },
      { at: 120, from: "Hana Sato · Support", text: "Customers say the cart drawer takes ages to open and sometimes shows an error page." },
      { at: 210, from: "PagerDuty", text: "Escalated to SEV1 — add-to-cart success rate below 60%." },
      { at: 300, from: "Elena Ruiz · VP Engineering", text: "Is rolling back further an option? I need a plan before the 09:30 standup." },
    ],
    hints: [
      "The app is already on an older build and nothing improved. What else changed overnight?",
      "Ask Postgres what its busy sessions are running, and how it plans that statement.",
      "A migration can report success with a warning in the middle. Read the whole log.",
    ],
    suggestions: [
      "kubectl rollout history deployment/cart-api",
      "kubectl rollout undo deployment/cart-api",
      'psql -c "select state, count(*) from pg_stat_activity group by state"',
      'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"',
      "kubectl get jobs",
    ],
    solution: [
      { command: "kubectl rollout history deployment/cart-api", why: "Revision 15 is already the older code line. Whatever is slow, the app rollback didn’t reach it." },
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Most sessions are active: orders-db is doing slow work, not sitting on idle connections." },
      { command: "psql -c \"explain select id from orders where customer_id = $1 and status = 'pending'\"", why: "A parallel Seq Scan on orders for a lookup that should take a millisecond." },
      { command: 'psql -c "\\d orders"', why: "orders_pending_by_customer_idx is there but marked INVALID, and the legacy index it replaced is gone." },
      { command: "kubectl logs job/migrate-0311", why: "The CREATE INDEX hit lock_timeout, and the migration dropped the legacy index anyway." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_pending_by_customer_idx"', why: "Builds the index for real without blocking cart writes." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch the build finish, then declare resolved once 5xx drops." },
    ],
    postmortem: {
      question: "Why didn’t rolling back cart-api help?",
      options: [
        "The rollback picked v3.7.4, which carried the same slow code as v3.8.0",
        "Migration 0311’s index failed on lock_timeout and stayed INVALID",
        "orders-db was out of connections because of the night’s rollout",
        "Autovacuum was blocked and orders bloated past shared_buffers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Migration 0311’s CREATE INDEX CONCURRENTLY was cancelled by its own 10 s lock_timeout, leaving orders_pending_by_customer_idx INVALID, then it dropped the legacy index cart-api relied on.",
        why: "Postgres never plans with an invalid index, so every pending-order lookup seq-scanned orders, and the scans slowly pushed the hot set out of shared_buffers. Rolling the app back can’t touch the schema. REINDEX INDEX CONCURRENTLY builds the index properly without locking writes.",
        tell: "Revision 15 was already the older code, yet EXPLAIN showed a Seq Scan, \\d orders marked the index INVALID, and the migration log had a lock timeout followed by a DROP.",
      },
    },
  },
  {
    id: "infra-t4-intake-index-deadlock",
    title: "Order intake slows after the maintenance window",
    severity: "SEV2",
    service: "order-intake",
    briefing:
      "PagerDuty: order-intake 5xx above 5% and rising. orders-db had a Postgres minor upgrade in this morning’s maintenance window, and the DBA team’s index swap ran right after it. You have kubectl and a psql role on orders-db.",
    roleBriefing: "order-intake writes and looks up pending orders. Two things happened to orders-db this morning; only one of them broke it.",
    opensAtSecondOfDay: 6 * HOUR + 12 * MINUTE,
    lostCheckoutsPerPoint: 300,
    revision: 22,
    revisions: [
      { number: 21, tag: "v2.14.0", changeCause: "v2.14.0 split shipments by warehouse", traits: [] },
      { number: 22, tag: "v2.15.0", changeCause: "v2.15.0 kafka producer acks=all for order events", traits: [] },
    ],
    index: {
      name: "orders_status_customer_created_idx",
      definition: "btree (status, customer_id, created_at DESC)",
      query: "SELECT id, payment_intent_id FROM orders WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      cacheEviction: 0.18,
    },
    job: { name: "index-swap-orders", status: "Complete", finishedAt: -40 * MINUTE, durationSeconds: 212 },
    jobLog: [
      { t: -44 * MINUTE, level: "INFO", text: "CREATE INDEX CONCURRENTLY orders_status_customer_created_idx ON orders (status, customer_id, created_at DESC);" },
      { t: -41 * MINUTE, level: "WARN", text: "ERROR:  deadlock detected" },
      { t: -41 * MINUTE, level: "WARN", text: "DETAIL:  Process 48211 waits for ShareLock on virtual transaction 7/183344; blocked by process 51877." },
      { t: -40 * MINUTE, level: "INFO", text: "DROP INDEX CONCURRENTLY IF EXISTS orders_status_customer_idx;" },
      { t: -40 * MINUTE, level: "INFO", text: "index swap finished: orders (1 created, 1 dropped)" },
    ],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — order-intake 5xx > 5% for 5m. Assigned to you." },
      { at: 45, from: "Priya Nair · DBA", text: "The 16.6 minor upgrade finished clean at 05:20. Could the new planner be choosing a bad plan?" },
      { at: 100, from: "Sam Tan · Eng manager", text: "order-intake v2.15.0 went out yesterday. Want to roll it back to be safe?" },
      { at: 200, from: "PagerDuty", text: "Escalated to SEV1 — order success rate below 60%." },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Morning traffic ramps at 07:00. What’s the call?" },
    ],
    hints: [
      "Yesterday’s app deploy ran fine all night. Look at what happened to the database since.",
      "Find the statement every busy session is running, then ask the planner how it runs it.",
      "Index maintenance that fails halfway can still drop what it was replacing.",
    ],
    suggestions: [
      "kubectl rollout undo deployment/order-intake",
      'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"',
      'psql -c "select indexname, indisvalid from pg_indexes"',
      "kubectl get jobs",
      "kubectl logs deployment/order-intake",
    ],
    solution: [
      { command: 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', why: "The pending-order lookup averages hundreds of milliseconds; everything else is fast." },
      { command: "psql -c \"explain select id from orders where customer_id = $1 and status = 'pending'\"", why: "Seq Scan on orders. The planner has no usable index for it, upgrade or not." },
      { command: 'psql -c "select indexname, indisvalid from pg_indexes"', why: "orders_status_customer_created_idx has indisvalid = f." },
      { command: "kubectl logs job/index-swap-orders", why: "The build died on a deadlock and the swap dropped the old index anyway." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_status_customer_created_idx"', why: "Rebuilds the invalid index while order-intake keeps writing." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch it finish, then declare resolved once 5xx drops." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "The 16.6 minor upgrade changed the planner’s cost estimates for orders",
        "The index swap’s new index deadlocked mid-build and stayed INVALID",
        "Kafka acks=all in v2.15.0 held DB connections while waiting on brokers",
        "Postgres statistics were reset by the upgrade, so ANALYZE had to run first",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The DBA team’s index swap ran CREATE INDEX CONCURRENTLY, lost a deadlock against a long checkout transaction, and dropped the old index without checking the new one was valid.",
        why: "A failed concurrent build leaves its index behind as INVALID, and Postgres never uses one. With the old index gone, every pending-order lookup seq-scanned orders and got slower as it evicted the cache. Neither the upgrade nor the app deploy had anything to do with it, so rolling either back changes nothing.",
        tell: "indisvalid = f on the new index, a Seq Scan in EXPLAIN, and “deadlock detected” in the swap job’s log right before its DROP.",
      },
    },
  },
  {
    id: "infra-t4-payments-index-disk-full",
    title: "Payments slow down after the disk grew",
    severity: "SEV2",
    service: "payments-api",
    briefing:
      "PagerDuty: payments-api p99 above 2 s and 5xx climbing. orders-db ran out of disk at 03:50; storage autoscaling added 150 GiB a few minutes later and the disk alarm cleared. Payments have been slowing ever since. You have kubectl and psql.",
    roleBriefing: "The disk is fine now: 41% used. Whatever broke when it filled up didn’t heal when it grew.",
    opensAtSecondOfDay: 7 * HOUR + 3 * MINUTE,
    lostCheckoutsPerPoint: 300,
    revision: 31,
    revisions: [
      { number: 30, tag: "v7.2.0", changeCause: "v7.2.0 retry declined cards once on soft declines", traits: [] },
      { number: 31, tag: "v7.3.0", changeCause: "v7.3.0 3DS2 challenge flow (migration 0057)", traits: [] },
    ],
    index: {
      name: "orders_customer_status_recent_idx",
      definition: "btree (customer_id, status, created_at DESC) INCLUDE (payment_intent_id)",
      query: "SELECT id, payment_intent_id FROM orders WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      cacheEviction: 0.14,
    },
    job: { name: "migrate-0057", status: "Complete", finishedAt: -3 * HOUR, durationSeconds: 388 },
    jobLog: [
      { t: -3 * HOUR - 388, level: "INFO", text: "CREATE INDEX CONCURRENTLY orders_customer_status_recent_idx ON orders (customer_id, status, created_at DESC) INCLUDE (payment_intent_id);" },
      { t: -3 * HOUR - 4, level: "WARN", text: "ERROR:  could not extend file \"base/16384/2615119\": No space left on device" },
      { t: -3 * HOUR - 4, level: "WARN", text: "HINT:  Check free disk space." },
      { t: -3 * HOUR - 1, level: "INFO", text: "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_status_idx;" },
      { t: -3 * HOUR, level: "INFO", text: "migration 0057 applied (2 statements, 1 warning)" },
    ],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — payments-api p99 > 2s and 5xx > 5%. Assigned to you." },
      { at: 40, from: "Tom Becker · Platform", text: "Storage autoscaling went 500 → 650 GiB at 03:54. Disk alarm’s green. Should we restart Postgres to be safe?" },
      { at: 130, from: "Hana Sato · Support", text: "3DS challenges time out and customers end up with a failed payment." },
      { at: 220, from: "PagerDuty", text: "Escalated to SEV1 — payment success rate below 60%." },
      { at: 310, from: "Elena Ruiz · VP Engineering", text: "Do we roll back 3DS2? Finance wants an answer." },
    ],
    hints: [
      "More disk fixed the alarm, not whatever was writing when the disk filled.",
      "Ask Postgres which statement is slow, then how it plans it.",
      "Something that was building at 03:50 never finished.",
    ],
    suggestions: [
      "kubectl rollout undo deployment/payments-api",
      'psql -c "select state, count(*) from pg_stat_activity group by state"',
      'psql -c "\\d orders"',
      "kubectl get jobs",
      'psql -c "select * from pg_stat_progress_create_index"',
    ],
    solution: [
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Active sessions pile up: the database is slow at real work, not out of space or connections." },
      { command: 'psql -c "\\d orders"', why: "orders_customer_status_recent_idx is INVALID and the old orders_customer_status_idx is gone." },
      { command: "kubectl get jobs", why: "migrate-0057 finished around 03:50, right when the disk filled." },
      { command: "kubectl logs job/migrate-0057", why: "The index build failed with No space left on device, and the migration dropped the old index anyway." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_customer_status_recent_idx"', why: "With room on disk now, the index can build properly without locking orders." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch it complete, then declare resolved once 5xx drops." },
    ],
    postmortem: {
      question: "Why did payments stay slow after the disk grew?",
      options: [
        "Postgres needed a restart to see the storage autoscaling had added",
        "The index build died when the disk filled and stayed INVALID",
        "3DS2 in v7.3.0 doubled the queries per payment",
        "WAL replay after the disk-full event was still running",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Migration 0057’s CREATE INDEX CONCURRENTLY ran out of disk, which left the new index INVALID; the migration then dropped the index payments-api had been using.",
        why: "Adding storage lets new writes succeed, but it doesn’t finish a build that already failed. Postgres ignores invalid indexes, so every pending-order lookup seq-scanned orders. REINDEX CONCURRENTLY, now that the disk has room, builds the index without blocking writes.",
        tell: "The migration log’s “No space left on device” on the index build, followed by a DROP, and \\d orders marking the new index INVALID.",
      },
    },
  },
  {
    id: "infra-t4-bff-index-cancelled",
    title: "Checkout BFF slow after nightly maintenance",
    severity: "SEV2",
    service: "checkout-bff",
    briefing:
      "PagerDuty: checkout-bff 5xx above 5%. The day team restarted every checkout-bff pod and flushed its Redis cache; it got worse, not better. You have kubectl and a psql role on orders-db.",
    roleBriefing: "checkout-bff looks up each customer’s pending order on every checkout page view. Restarts and cache flushes are already done.",
    opensAtSecondOfDay: 11 * HOUR + 26 * MINUTE,
    lostCheckoutsPerPoint: 300,
    revision: 9,
    revisions: [
      { number: 8, tag: "v1.19.2", changeCause: "v1.19.2 gift message field", traits: [] },
      { number: 9, tag: "v1.20.0", changeCause: "v1.20.0 GraphQL persisted queries", traits: [] },
    ],
    index: {
      name: "orders_customer_recent_idx",
      definition: "btree (customer_id, created_at DESC) INCLUDE (status, total_minor)",
      query: "SELECT id, status, total_minor FROM orders WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      cacheEviction: 0.22,
    },
    job: { name: "nightly-index-maintenance", status: "Complete", finishedAt: -7 * HOUR, durationSeconds: 1_140 },
    jobLog: [
      { t: -7 * HOUR - 1_140, level: "INFO", text: "CREATE INDEX CONCURRENTLY orders_customer_recent_idx_new ON orders (customer_id, created_at DESC) INCLUDE (status, total_minor);" },
      { t: -7 * HOUR - 6, level: "WARN", text: "ERROR:  canceling statement due to user request" },
      { t: -7 * HOUR - 4, level: "INFO", text: "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_recent_idx;" },
      { t: -7 * HOUR - 1, level: "INFO", text: "ALTER INDEX orders_customer_recent_idx_new RENAME TO orders_customer_recent_idx;" },
      { t: -7 * HOUR, level: "INFO", text: "maintenance done: 1 index rebuilt" },
    ],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-bff 5xx > 5% for 5m. Assigned to you." },
      { at: 35, from: "Lena Ortiz · Day on-call", text: "Already did a rollout restart and flushed bff-redis. Neither helped. Roll back the persisted-queries release?" },
      { at: 90, from: "Raj Mehta · Data", text: "Last night around 04:20 I cancelled a query on orders-db that had been running for 19 minutes. Hope that wasn’t important." },
      { at: 190, from: "PagerDuty", text: "Escalated to SEV1 — checkout success rate below 60%." },
      { at: 280, from: "Elena Ruiz · VP Engineering", text: "Lunch peak starts at noon. Where are we?" },
    ],
    hints: [
      "Restarts and an empty cache made it worse, which says the slowness is behind the app.",
      "Someone cancelled a long query overnight. What was it?",
      "Check whether the index the lookup needs is one Postgres will actually use.",
    ],
    suggestions: [
      "kubectl rollout restart deployment/checkout-bff",
      "kubectl rollout undo deployment/checkout-bff",
      'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"',
      'psql -c "\\d orders"',
      "kubectl get jobs",
    ],
    solution: [
      { command: 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', why: "The pending-order lookup is hundreds of times slower than everything else." },
      { command: 'psql -c "\\d orders"', why: "orders_customer_recent_idx exists but is INVALID." },
      { command: "kubectl logs job/nightly-index-maintenance", why: "The replacement build was cancelled by a user, and the script still dropped the old index and renamed the broken one into its place." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_customer_recent_idx"', why: "Builds the index for real without blocking checkout writes." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch it finish, then declare resolved once 5xx drops." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "Persisted queries in v1.20.0 bypassed bff-redis and hit orders-db directly",
        "A cancelled overnight index build was renamed into place while INVALID",
        "Flushing bff-redis stampeded orders-db with cold-cache reads",
        "The rollout restart opened more connections than orders-db allows",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The nightly maintenance job built a replacement index, a colleague cancelled that long-running statement, and the script dropped the old index and renamed the INVALID one into its place.",
        why: "A cancelled CREATE INDEX CONCURRENTLY leaves an invalid index that Postgres never plans with. Under the old name it looked normal at a glance, but every checkout page view seq-scanned orders. Restarting pods or flushing the cache only adds load; REINDEX CONCURRENTLY rebuilds it.",
        tell: "“canceling statement due to user request” in the maintenance log, followed by DROP and RENAME, and \\d orders showing the index INVALID.",
      },
    },
  },
];

const LEAK_ROWS: readonly HiddenDefectRow[] = [
  {
    id: "infra-t4-wallet-leak-two-back",
    title: "Wallet pool drains after the rollback",
    severity: "SEV2",
    service: "wallet-api",
    briefing:
      "PagerDuty: wallet-api 5xx climbing. v6.2.1 went out at 09:10 and is the obvious suspect. You have kubectl, psql and curl on the prod bastion. Make the fix stick.",
    roleBriefing: "wallet-api stores and charges saved cards through card-vault. Look at more than the newest release before you roll anything back.",
    opensAtSecondOfDay: 9 * HOUR + 40 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 20,
    revision: 42,
    revisions: [
      { number: 40, tag: "v6.1.2", changeCause: "v6.1.2 card art for co-branded cards", traits: [] },
      { number: 41, tag: "v6.2.0", changeCause: "v6.2.0 tokenise cards through card-vault with retries", traits: [leak("card-vault", 0.05)] },
      { number: 42, tag: "v6.2.1", changeCause: "v6.2.1 bump micrometer to 1.13.6", traits: [leak("card-vault", 0.05)] },
    ],
    pods: [{ leaked: 16, startedAgo: 1_700 }, { leaked: 11 }, { leaked: 6 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — wallet-api 5xx > 5% and climbing. Assigned to you." },
      { at: 40, from: "Sam Tan · Eng manager", text: "v6.2.1 is just a metrics bump, but it’s the newest thing. Undo it?" },
      { at: 110, from: "Ana Lima · card-vault team", text: "card-vault p99 is 2.8 s this morning, we’re looking at it. It times out a few percent of calls." },
      { at: 200, from: "PagerDuty", text: "Escalated to SEV1 — saved-card checkout success below 50%." },
      { at: 300, from: "Elena Ruiz · VP Engineering", text: "If a rollback didn’t hold, what will?" },
    ],
    hints: [
      "The pool empties a connection at a time while traffic stays flat. That’s something not being returned.",
      "The newest release changed a metrics library. Which release changed how card-vault is called?",
      "Undo goes back exactly one revision. Check what that revision carries.",
    ],
    suggestions: [
      "kubectl logs deployment/wallet-api",
      "curl -s http://wallet-api:8080/actuator/metrics/hikaricp.connections.active",
      'psql -c "select state, count(*) from pg_stat_activity group by state"',
      "kubectl rollout history deployment/wallet-api",
      "kubectl rollout undo deployment/wallet-api",
      "kubectl rollout restart deployment/wallet-api",
    ],
    solution: [
      { command: "kubectl logs deployment/wallet-api", why: "card-vault timeouts, each followed by the pool shrinking. Hikari ends up active=20, idle=0." },
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Postgres sees those sessions as idle: borrowed by the app and never handed back." },
      { command: "kubectl rollout history deployment/wallet-api", why: "v6.2.0 added the card-vault retry wrapper; v6.2.1 only bumped micrometer on top of it." },
      { command: "kubectl rollout undo deployment/wallet-api --to-revision=40", why: "Back to v6.1.2, the last build without the retry wrapper. A plain undo would land on v6.2.0 and keep leaking." },
      { command: "kubectl rollout status deployment/wallet-api", why: "Wait for every pod to run v6.1.2, then declare resolved." },
    ],
    postmortem: {
      question: "Why would a plain rollback not have held?",
      options: [
        "v6.2.1’s micrometer bump leaked a connection per scrape",
        "The leak came in with v6.2.0, one revision before v6.2.1",
        "card-vault latency exhausted wallet-api’s worker threads",
        "orders-db hit max_connections when card-vault slowed down",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v6.2.0’s card-vault retry wrapper borrowed a connection and threw on the final timeout before returning it; v6.2.1 was built on top of it.",
        why: "kubectl rollout undo goes back exactly one revision, to v6.2.0, which has the same leak, so the pool would drain again within minutes. Rolling back to v6.1.2 removes the wrapper. card-vault’s slowness only set the pace of the leak.",
        tell: "Hikari active=20 while Postgres showed the sessions idle, and the history showed v6.2.1 changing only a metrics library while v6.2.0 changed the card-vault client.",
      },
    },
  },
  {
    id: "infra-t4-basket-leak-after-undo",
    title: "Basket keeps timing out after the night’s undo",
    severity: "SEV2",
    service: "basket-api",
    briefing:
      "PagerDuty: basket-api 5xx above 5% again. The night on-call already ran a rollback at 02:40 and went to bed. It held for a few hours. You have kubectl, psql and curl.",
    roleBriefing: "basket-api creates Klarna pay-later sessions at checkout. Someone already rolled it back once; read what they rolled back to.",
    opensAtSecondOfDay: 7 * HOUR + 18 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 15,
    revision: 33,
    revisions: [
      { number: 30, tag: "v4.9.8", changeCause: "v4.9.8 recompute basket totals on currency switch", traits: [] },
      { number: 32, tag: "v5.0.1", changeCause: "v5.0.1 fix currency rounding in Klarna session", traits: [leak("klarna-bridge", 0.04)] },
      { number: 33, tag: "v5.0.0", changeCause: "v5.0.0 Klarna pay-later sessions with retry", traits: [leak("klarna-bridge", 0.04)] },
    ],
    pods: [{ leaked: 12, startedAgo: 4 * HOUR }, { leaked: 9, startedAgo: 4 * HOUR }, { leaked: 5, startedAgo: 4 * HOUR }, { leaked: 2, startedAgo: 4 * HOUR }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 re-triggered — basket-api 5xx > 5%. Assigned to you." },
      { at: 30, from: "Ivo Petrov · Night on-call (async)", text: "Rolled basket-api back at 02:40, errors dropped to zero. Should be fine now 👍" },
      { at: 100, from: "Mia Chen · Payments partner team", text: "klarna-bridge sees elevated latency from Klarna’s EU endpoint since yesterday." },
      { at: 190, from: "PagerDuty", text: "Escalated to SEV1 — basket checkout success below 50%." },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Second page for the same service in one night. I want this fixed, not reset." },
    ],
    hints: [
      "Errors dropped to zero after the night’s rollback, then crept back. What resets on a fresh pod?",
      "The connections the pool lost are idle in Postgres. Something borrows and never returns them.",
      "Read the revision numbers and tags in order. The night’s rollback landed on a release, not before it.",
    ],
    suggestions: [
      "kubectl rollout history deployment/basket-api",
      "kubectl rollout undo deployment/basket-api",
      "kubectl logs deployment/basket-api",
      "curl -s http://basket-api:8080/actuator/health",
      'psql -c "select pid, application_name, state, query from pg_stat_activity"',
    ],
    solution: [
      { command: "curl -s http://basket-api:8080/actuator/metrics/hikaricp.connections.active", why: "Pods sit near their pool of 15 while traffic is flat." },
      { command: 'psql -c "select pid, application_name, state, query from pg_stat_activity"', why: "basket-api sessions idle for minutes: checked out by the app and never returned." },
      { command: "kubectl rollout history deployment/basket-api", why: "Revision 33 is v5.0.0 re-applied by the night’s undo. v5.0.0 introduced the Klarna retry; v4.9.8 is the build before it." },
      { command: "kubectl rollout undo deployment/basket-api --to-revision=30", why: "Back to v4.9.8. Another plain undo would land on v5.0.1, which has the same leak." },
      { command: "kubectl rollout status deployment/basket-api", why: "Wait for every pod to run v4.9.8, then declare resolved." },
    ],
    postmortem: {
      question: "Why did the night’s rollback only buy a few hours?",
      options: [
        "The 02:40 undo landed on v5.0.0, which introduced the leaking retry",
        "Klarna’s EU endpoint latency kept rising through the night and morning",
        "A pool of 15 per pod was too small for the morning traffic",
        "pg_terminate_backend was never run on the idle sessions",
      ],
      answerIndex: 0,
      explanation: {
        cause: "v5.0.0 added a Klarna session retry that leaked a pooled connection on every klarna-bridge timeout. The 02:40 undo went from v5.0.1 back to v5.0.0, which carries the same code.",
        why: "Fresh pods start with an empty pool, so the undo looked like a fix until the leak refilled it over a few hours. Rolling back to v4.9.8 removes the retry wrapper. Klarna’s latency only set how fast it leaked.",
        tell: "Revision 33 was tagged v5.0.0, the release whose change cause added the retry, and Postgres showed basket-api sessions idle for minutes while Hikari reported the pool full.",
      },
    },
  },
  {
    id: "infra-t4-redeem-leak-config-revision",
    title: "Gift card redemptions stall after a config change",
    severity: "SEV2",
    service: "redeem-api",
    briefing:
      "PagerDuty: redeem-api 5xx rising. The only change today is a config revision at 12:05 that lowered the log level. You have kubectl, psql and curl. Find what actually changed.",
    roleBriefing: "redeem-api applies gift cards and store credit at checkout by charging giftcard-ledger. Read the image tags as well as the change causes.",
    opensAtSecondOfDay: 12 * HOUR + 48 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 20,
    requestsPerSecond: 240,
    revision: 19,
    revisions: [
      { number: 17, tag: "v2.3.0", changeCause: "v2.3.0 partial redemption across two cards", traits: [] },
      { number: 18, tag: "v2.4.0", changeCause: "v2.4.0 async giftcard-ledger client (resilience4j retry)", traits: [leak("giftcard-ledger", 0.06)] },
      { number: 19, tag: "v2.4.0", changeCause: "config: LOG_LEVEL=WARN, JAVA_TOOL_OPTIONS unchanged", traits: [leak("giftcard-ledger", 0.06)] },
    ],
    pods: [{ leaked: 15, startedAgo: 2_400 }, { leaked: 10, startedAgo: 2_400 }, { leaked: 4, startedAgo: 2_400 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — redeem-api 5xx > 5% for 5m. Assigned to you." },
      { at: 45, from: "Jonah Reyes · redeem-api dev", text: "The 12:05 change was only log level. Undo it if you want, but I doubt it." },
      { at: 120, from: "Hana Sato · Support", text: "Gift card customers stuck on “applying your card…”, then an error." },
      { at: 210, from: "PagerDuty", text: "Escalated to SEV1 — gift card redemption success below 50%." },
      { at: 300, from: "Elena Ruiz · VP Engineering", text: "Holiday gift card promo goes live tomorrow. I need to know this won’t come back." },
    ],
    hints: [
      "Every pod’s pool fills a connection at a time. Postgres says those sessions are idle.",
      "Two revisions in the history share an image. Which change actually shipped new code?",
      "A one-step rollback here only changes the log level.",
    ],
    suggestions: [
      "kubectl rollout history deployment/redeem-api",
      "kubectl describe deployment redeem-api",
      "kubectl rollout undo deployment/redeem-api",
      "kubectl logs deployment/redeem-api",
      'psql -c "select state, count(*) from pg_stat_activity group by state"',
    ],
    solution: [
      { command: "kubectl logs deployment/redeem-api", why: "giftcard-ledger timeouts, and Hikari waiting on a pool with no idle connections." },
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Plenty of idle sessions in Postgres while the app says its pool is busy: a leak." },
      { command: "kubectl describe deployment redeem-api", why: "The image is v2.4.0, the same as revision 18. The 12:05 revision changed config only." },
      { command: "kubectl rollout history deployment/redeem-api", why: "v2.4.0 brought the async ledger client with retries; v2.3.0 is the build before it." },
      { command: "kubectl rollout undo deployment/redeem-api --to-revision=17", why: "Back to v2.3.0. A plain undo returns the same v2.4.0 image with the old log level." },
      { command: "kubectl rollout status deployment/redeem-api", why: "Wait for the rollout to finish, then declare resolved." },
    ],
    postmortem: {
      question: "Why didn’t undoing the 12:05 change fix it?",
      options: [
        "LOG_LEVEL=WARN hid the errors but the pods still needed a restart",
        "Revision 18 runs the same v2.4.0 image, with the leaking client",
        "giftcard-ledger throttled redeem-api after the config change",
        "orders-db ran out of connections after the noon traffic peak",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v2.4.0’s async giftcard-ledger client leaked a pooled connection each time a retry exhausted. The 12:05 revision only changed config on the same image.",
        why: "A plain undo goes to revision 18: the same v2.4.0 image with the previous log level, so the leak stays and fresh pods only reset the count. Rolling back to v2.3.0 removes the client. The image tag, not the change cause, says what code is running.",
        tell: "Revisions 18 and 19 shared the image v2.4.0, Hikari reported idle=0 while Postgres showed those sessions idle, and each pool drained in steps matching giftcard-ledger timeouts.",
      },
    },
  },
  {
    id: "infra-t4-router-leak-three-deep",
    title: "Order router leaks through three releases",
    severity: "SEV2",
    service: "order-router",
    briefing:
      "PagerDuty: order-router 5xx above 5%. Three releases went out since yesterday afternoon. You have kubectl, psql and curl. Pick the rollback that actually ends this.",
    roleBriefing: "order-router authorises payments through adyen-proxy before routing orders to warehouses. Count how far back the change goes.",
    opensAtSecondOfDay: 15 * HOUR + 5 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 24,
    revision: 53,
    revisions: [
      { number: 50, tag: "v9.0.3", changeCause: "v9.0.3 route oversize items to Leeds", traits: [] },
      { number: 51, tag: "v9.1.0", changeCause: "v9.1.0 adyen-proxy client: circuit breaker + retry", traits: [leak("adyen-proxy", 0.05)] },
      { number: 52, tag: "v9.1.1", changeCause: "v9.1.1 fix NPE in split-shipment routing", traits: [leak("adyen-proxy", 0.05)] },
      { number: 53, tag: "v9.1.2", changeCause: "v9.1.2 copy change in order confirmation", traits: [leak("adyen-proxy", 0.05)] },
    ],
    pods: [{ leaked: 20, startedAgo: 3_000 }, { leaked: 13 }, { leaked: 9 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — order-router 5xx > 5% for 5m. Assigned to you." },
      { at: 50, from: "Sam Tan · Eng manager", text: "v9.1.2 was a copy change, it can’t be that. v9.1.1 maybe?" },
      { at: 115, from: "Carlos Diaz · Warehouse ops", text: "Leeds is getting maybe half the orders it should." },
      { at: 200, from: "PagerDuty", text: "Escalated to SEV1 — order routing success below 50%." },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Whatever you pick, I don’t want to be rolling back again at 5pm." },
    ],
    hints: [
      "One pod is already failing everything while traffic is flat. What is it running out of?",
      "Find the release that changed how payments are authorised, not the newest one.",
      "Every release since that one carries the same client.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl logs deployment/order-router",
      "kubectl rollout history deployment/order-router",
      "kubectl rollout undo deployment/order-router",
      'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"',
    ],
    solution: [
      { command: "kubectl logs deployment/order-router", why: "adyen-proxy authorisation timeouts and a Hikari pool with no idle connections." },
      { command: "curl -s http://order-router:8080/actuator/health", why: "Some pods report the db component DOWN: they can’t get a connection from their own pool." },
      { command: "kubectl rollout history deployment/order-router", why: "v9.1.0 added the adyen-proxy retry; v9.1.1 and v9.1.2 were built on top of it." },
      { command: "kubectl rollout undo deployment/order-router --to-revision=50", why: "Back to v9.0.3, before the retry client. Undoing one or two releases would keep the leak." },
      { command: "kubectl rollout status deployment/order-router", why: "Wait for every pod to run v9.0.3, then declare resolved." },
    ],
    postmortem: {
      question: "Which revision had to go?",
      options: [
        "v9.1.2, the newest release, because it went out right before the page",
        "v9.1.0, whose adyen-proxy retry leaked into every later build",
        "v9.1.1, because the split-shipment fix touched the order write path",
        "None: adyen-proxy latency was the cause and no rollback could help",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v9.1.0’s adyen-proxy circuit breaker and retry leaked a pooled connection whenever an authorisation timed out, and v9.1.1 and v9.1.2 were built on top of it.",
        why: "Rolling back one or two releases keeps the same client, and fresh pods only reset the leak for a while. Rolling back to v9.0.3 removes it. adyen-proxy timeouts only set the pace.",
        tell: "The pool drained in steps that matched adyen-proxy timeouts, /actuator/health reported the db DOWN on full pools, and the history showed the retry client arriving in v9.1.0.",
      },
    },
  },
];

const CRASH_ROWS: readonly HiddenDefectRow[] = [
  {
    id: "infra-t4-pricing-heap-exit",
    title: "Pricing pods exit after the heap fix",
    severity: "SEV2",
    service: "pricing-api",
    briefing:
      "PagerDuty: pricing-api restarting and checkout 5xx above 5%. A teammate shipped v3.12.1 an hour ago “to stop the GC thrash”. Since then pods die outright. You have kubectl on the prod bastion.",
    roleBriefing: "pricing-api prices baskets at checkout. Two releases went out today; read what each did before rolling back.",
    opensAtSecondOfDay: 14 * HOUR + 9 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 20,
    revision: 62,
    revisions: [
      { number: 60, tag: "v3.11.0", changeCause: "v3.11.0 price rounding per currency", traits: [] },
      {
        number: 61,
        tag: "v3.12.0",
        changeCause: "v3.12.0 load all promo rules into a Caffeine cache at startup",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "Error", exitCode: 3 },
            afterSeconds: 80,
            jitterSeconds: 60,
            lastWords: "Terminating due to java.lang.OutOfMemoryError: Java heap space",
            failsCheckouts: false,
          },
        ],
      },
      {
        number: 62,
        tag: "v3.12.1",
        changeCause: "v3.12.1 add -XX:+ExitOnOutOfMemoryError so pods restart instead of thrashing",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "Error", exitCode: 3 },
            afterSeconds: 80,
            jitterSeconds: 60,
            lastWords: "Terminating due to java.lang.OutOfMemoryError: Java heap space",
            failsCheckouts: false,
          },
        ],
      },
    ],
    pods: [{ startedAgo: 30 }, { startedAgo: 20 }, { startedAgo: 10 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — pricing-api restarts and checkout 5xx > 5%. Assigned to you." },
      { at: 40, from: "Kai Wong · pricing-api dev", text: "v3.12.1 only adds a JVM flag. Roll it back if you like, it was thrashing before anyway." },
      { at: 120, from: "Hana Sato · Support", text: "Basket totals fail to load every minute or so, then work again." },
      { at: 220, from: "Sam Tan · Eng manager", text: "Can we just give the pods more memory?" },
      { at: 300, from: "Elena Ruiz · VP Engineering", text: "Flapping checkout during the flash sale. What’s the plan?" },
    ],
    hints: [
      "The pods don’t get OOMKilled by the kernel; the JVM exits on its own. Why?",
      "The newest release only changed what happens when the heap runs out. Which one filled it?",
      "One step back is still a build that runs out of heap.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl describe pods",
      "kubectl rollout history deployment/pricing-api",
      "kubectl rollout undo deployment/pricing-api",
      "kubectl rollout restart deployment/pricing-api",
    ],
    solution: [
      { command: "kubectl get pods", why: "Restarts climb one pod at a time; each lasts a minute or two." },
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: Error, Exit Code 3. The JVM chose to exit, the kernel didn’t kill it." },
      { command: "kubectl logs deployment/pricing-api", why: "“Terminating due to java.lang.OutOfMemoryError: Java heap space”: the heap fills, and v3.12.1’s flag makes it exit." },
      { command: "kubectl rollout history deployment/pricing-api", why: "v3.12.0 loads every promo rule into memory; v3.12.1 only added the exit flag on top." },
      { command: "kubectl rollout undo deployment/pricing-api --to-revision=60", why: "Back to v3.11.0, before the cache. A plain undo would bring back v3.12.0’s thrashing." },
      { command: "kubectl rollout status deployment/pricing-api", why: "Wait for the rollout, then declare resolved." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "-XX:+ExitOnOutOfMemoryError in v3.12.1 killed healthy pods",
        "v3.12.0’s unbounded promo-rule cache filled the heap",
        "The pods’ 1Gi memory limit was too small for pricing traffic",
        "The kernel OOM killer picked pricing-api under node pressure",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v3.12.0 loaded every promo rule into an unbounded in-heap cache, which filled the heap after a minute or two of traffic.",
        why: "v3.12.1’s ExitOnOutOfMemoryError only turned the GC thrash into a clean exit with code 3. Undoing it brings the thrash back, and more memory only delays it. Rolling back to v3.11.0 removes the cache.",
        tell: "Exit Code 3 with Reason: Error (not OOMKilled / 137), the JVM’s “Terminating due to java.lang.OutOfMemoryError: Java heap space”, and the history showing v3.12.1 as only a JVM flag on top of v3.12.0.",
      },
    },
  },
  {
    id: "infra-t4-payments-edge-segfault",
    title: "Payments edge segfaults on every charge",
    severity: "SEV1",
    service: "payments-edge",
    briefing:
      "PagerDuty: payments-edge crash-looping and card checkout failing. v4.5.1 went out at 16:02 with a timeout tweak; the crashes started around then. You have kubectl on the prod bastion.",
    roleBriefing: "payments-edge holds the TLS connections to the card acquirer. A native library changed recently; not necessarily in the newest release.",
    opensAtSecondOfDay: 16 * HOUR + 21 * MINUTE,
    lostCheckoutsPerPoint: 260,
    poolSize: 20,
    revision: 72,
    revisions: [
      { number: 70, tag: "v4.4.2", changeCause: "v4.4.2 acquirer response codes mapped to decline reasons", traits: [] },
      {
        number: 71,
        tag: "v4.5.0",
        changeCause: "v4.5.0 netty-tcnative-boringssl-static 2.0.69 → 2.0.70",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "Error", exitCode: 134 },
            afterSeconds: 45,
            jitterSeconds: 40,
            lastWords: "#  SIGSEGV (0xb) at pc=0x00007f3c2a1b4e10, pid=1, tid=47",
            failsCheckouts: true,
          },
        ],
      },
      {
        number: 72,
        tag: "v4.5.1",
        changeCause: "v4.5.1 raise acquirer connect timeout to 4s",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "Error", exitCode: 134 },
            afterSeconds: 45,
            jitterSeconds: 40,
            lastWords: "#  SIGSEGV (0xb) at pc=0x00007f3c2a1b4e10, pid=1, tid=47",
            failsCheckouts: true,
          },
        ],
      },
    ],
    pods: [{ startedAgo: 20 }, { startedAgo: 12 }, { startedAgo: 4 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — payments-edge CrashLoopBackOff, card checkout failing. Assigned to you." },
      { at: 35, from: "Nora Kim · payments-edge dev", text: "v4.5.1 is literally one timeout value. If you roll back, that’s fine by me." },
      { at: 100, from: "Acquirer status page", text: "All systems operational." },
      { at: 180, from: "Hana Sato · Support", text: "Every card payment fails; PayPal still works." },
      { at: 260, from: "Elena Ruiz · VP Engineering", text: "We’re losing every card sale. What are you rolling back to?" },
    ],
    hints: [
      "Exit code 134 is an abort, not a memory limit. Look at the last thing the process printed.",
      "The crash is in native code. Which release changed a native library?",
      "The newest release sits on top of that change.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl describe pods",
      "kubectl rollout history deployment/payments-edge",
      "kubectl rollout undo deployment/payments-edge",
      "kubectl scale deployment/payments-edge --replicas=6",
    ],
    solution: [
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: Error, Exit Code 134: the JVM aborted on a fatal signal." },
      { command: "kubectl logs deployment/payments-edge", why: "A SIGSEGV in native code, the JVM’s fatal error header, right as charges reach the acquirer." },
      { command: "kubectl rollout history deployment/payments-edge", why: "v4.5.0 bumped netty-tcnative, the native TLS library; v4.5.1 only changed a timeout on top." },
      { command: "kubectl rollout undo deployment/payments-edge --to-revision=70", why: "Back to v4.4.2 and the old tcnative. A plain undo lands on v4.5.0, which still segfaults." },
      { command: "kubectl rollout status deployment/payments-edge", why: "Wait for the rollout, then declare resolved once card checkouts succeed." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "v4.5.1’s 4 s connect timeout overloaded the acquirer’s TLS endpoint",
        "v4.5.0’s netty-tcnative bump crashed in native TLS code",
        "The pods’ memory limit was hit and the kernel killed them",
        "The acquirer rotated its certificate and broke the handshake",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v4.5.0 upgraded netty-tcnative-boringssl-static, and the new native build segfaulted on the acquirer’s TLS sessions.",
        why: "A SIGSEGV in native code takes the whole JVM down with exit code 134, and every card charge on that build fails first. v4.5.1 was built on top, so a plain undo keeps the broken library. Rolling back to v4.4.2 restores the old one.",
        tell: "Exit Code 134 with a JVM fatal-error SIGSEGV line, and the history showing v4.5.0 as the only release that changed a native library.",
      },
    },
  },
  {
    id: "infra-t4-quote-oom-after-heap-raise",
    title: "Quotes OOMKilled after the memory bump",
    severity: "SEV2",
    service: "quote-api",
    briefing:
      "PagerDuty: quote-api pods OOMKilled and checkout 5xx above 5%. This morning someone raised the JVM heap to stop the restarts; they got worse. You have kubectl on the prod bastion.",
    roleBriefing: "quote-api returns shipping and tax quotes for every checkout. Someone already tried the usual memory fix.",
    opensAtSecondOfDay: 10 * HOUR + 52 * MINUTE,
    lostCheckoutsPerPoint: 150,
    poolSize: 20,
    revision: 92,
    revisions: [
      { number: 90, tag: "v1.30.0", changeCause: "v1.30.0 tax holidays for US states", traits: [] },
      {
        number: 91,
        tag: "v1.31.0",
        changeCause: "v1.31.0 preload zone rates into an off-heap table for faster quotes",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "OOMKilled", exitCode: 137 },
            afterSeconds: 90,
            jitterSeconds: 70,
            lastWords: "ZoneRateTable - preloaded 2,140,551 zone-rate rows off-heap (rss=1003Mi, limit=1Gi)",
            failsCheckouts: false,
          },
        ],
      },
      {
        number: 92,
        tag: "v1.31.1",
        changeCause: "v1.31.1 JAVA_TOOL_OPTIONS -Xmx768m → -Xmx900m",
        traits: [
          {
            kind: "crashes-while-serving",
            termination: { reason: "OOMKilled", exitCode: 137 },
            afterSeconds: 60,
            jitterSeconds: 50,
            lastWords: "ZoneRateTable - preloaded 2,140,551 zone-rate rows off-heap (rss=1019Mi, limit=1Gi)",
            failsCheckouts: false,
          },
        ],
      },
    ],
    pods: [{ startedAgo: 40 }, { startedAgo: 25 }, { startedAgo: 10 }],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — quote-api OOMKilled, checkout 5xx > 5%. Assigned to you." },
      { at: 45, from: "Omar Haddad · quote-api dev", text: "I bumped -Xmx at 09:30 because pods were getting OOMKilled. Maybe it needs to go higher?" },
      { at: 130, from: "Hana Sato · Support", text: "Customers see “we couldn’t calculate shipping” at checkout, on and off." },
      { at: 220, from: "Sam Tan · Eng manager", text: "Should we undo the heap change?" },
      { at: 300, from: "Elena Ruiz · VP Engineering", text: "Is this getting better or worse?" },
    ],
    hints: [
      "The kernel kills the container at its limit. What lives in the container’s memory besides the heap?",
      "A bigger heap left less room for something else. Which release brought that something else?",
      "Undoing the heap change takes you back to the release that started the kills.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl describe pods",
      "kubectl top pods",
      "kubectl rollout history deployment/quote-api",
      "kubectl rollout undo deployment/quote-api",
    ],
    solution: [
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: OOMKilled, Exit Code 137 against a 1Gi limit." },
      { command: "kubectl logs deployment/quote-api", why: "Just before each kill, the off-heap zone-rate table pushes the container’s RSS to its limit." },
      { command: "kubectl rollout history deployment/quote-api", why: "v1.31.0 added the off-heap table; v1.31.1 only raised -Xmx, which leaves less room for it." },
      { command: "kubectl rollout undo deployment/quote-api --to-revision=90", why: "Back to v1.30.0, before the off-heap table. A plain undo lands on v1.31.0, which was already being killed." },
      { command: "kubectl rollout status deployment/quote-api", why: "Wait for the rollout, then declare resolved." },
    ],
    postmortem: {
      question: "Why did raising the heap make it worse?",
      options: [
        "-Xmx900m let the heap itself grow past the container’s 1Gi limit",
        "v1.31.0’s off-heap table filled the container, leaving no room",
        "The kubelet lowered the pods’ memory limit after the change",
        "Quote traffic doubled at the same time as the heap change",
      ],
      answerIndex: 1,
      explanation: {
        cause: "v1.31.0 preloaded two million zone-rate rows into off-heap memory, pushing the container’s total RSS to its 1Gi limit.",
        why: "-Xmx caps only the heap. The kernel counts heap plus off-heap plus metaspace against the container limit, so raising -Xmx squeezed the off-heap table and the kills came sooner. Undoing v1.31.1 returns to v1.31.0, which was already being killed. Rolling back to v1.30.0 removes the table.",
        tell: "OOMKilled with exit code 137 (the kernel, not the JVM), RSS near the limit in the last log line, and the history showing the off-heap preload arriving in v1.31.0.",
      },
    },
  },
];

const HOG_ROWS: readonly HogRow[] = [
  {
    id: "infra-t4-report-export-hog",
    title: "Orders API can’t get back to three pods",
    severity: "SEV2",
    service: "orders-api",
    briefing:
      "PagerDuty: orders-api 5xx above 5%. One of its three pods has been crash-looping since a node was recycled at 06:40. Deleting it and restarting the deployment didn’t help. You have kubectl and psql.",
    roleBriefing: "orders-api serves checkout’s order writes from three pods with pools of 20 on orders-db. It ran fine on three until this morning.",
    opensAtSecondOfDay: 7 * HOUR + 2 * MINUTE,
    lostCheckoutsPerPoint: 250,
    frontRevision: { number: 64, tag: "v8.3.2", changeCause: "v8.3.2 idempotency keys on order create", traits: [] },
    runningFrontPods: 2,
    hog: {
      name: "report-exporter",
      replicas: 2,
      poolSize: 25,
      revision: { number: 12, tag: "v1.6.0", changeCause: "v1.6.0 month-end finance export to S3", traits: [] },
      logs: [
        "Month-end export started: orders 2026-09 (scaled to 2 replicas for speed by finance-oncall)",
        "exported 1,204,331 / 4,118,902 rows to s3://marlow-finance/exports/2026-09/",
        "exported 2,388,170 / 4,118,902 rows to s3://marlow-finance/exports/2026-09/",
      ],
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — orders-api 5xx > 5% for 5m. Assigned to you." },
      { at: 30, from: "Lena Ortiz · Day on-call", text: "Deleted the crash-looping pod twice and did a rollout restart. The new pod crashes the same way." },
      { at: 100, from: "Felix Brandt · Finance", text: "Heads up, we scaled the month-end export up at 06:45 so it’s done before the CFO review." },
      { at: 200, from: "Sam Tan · Eng manager", text: "Scale orders-api to five pods so the healthy ones carry it?" },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Two pods can’t carry the morning peak. What’s blocking the third?" },
    ],
    hints: [
      "The crash-looping pod isn’t broken code; its siblings on the same build are fine. Read why it dies.",
      "Postgres can tell you who holds its connections, by application.",
      "Something besides orders-api started holding connections while the node was being recycled.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl get events",
      "kubectl rollout restart deployment/orders-api",
      "kubectl scale deployment/orders-api --replicas=5",
      'psql -c "show max_connections"',
      'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"',
    ],
    solution: [
      { command: "kubectl get pods", why: "Two orders-api pods Running, the third in CrashLoopBackOff, and report-exporter pods alongside." },
      { command: "kubectl logs %CRASHING%", why: "“FATAL: sorry, too many clients already”: the pod can’t open its pool, it isn’t broken." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "report-exporter holds 50 connections, orders-api 40." },
      { command: 'psql -c "show max_connections"', why: "100, three reserved: 97 for apps. A third orders-api pod needs 20 more than is left." },
      { command: "kubectl scale deployment/report-exporter --replicas=0", why: "Pauses the export and frees its 50 connections; it can resume tonight on one replica." },
      { command: "kubectl get pods", why: "The third orders-api pod starts after its back-off; declare resolved once 5xx is gone." },
    ],
    postmortem: {
      question: "Why couldn’t the third orders-api pod start?",
      options: [
        "The recycled node left it with a bad image cache",
        "report-exporter took the connections it needed",
        "orders-api v8.3.2 crashes on start under load",
        "The pod’s readiness probe timed out on startup",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Finance scaled report-exporter to two replicas with pools of 25 while an orders-api pod was being rescheduled, and the export took the connections that pod had held.",
        why: "orders-db allows 97 app connections. 50 for the export plus 40 for two orders-api pods left 7, and the third pod needs 20 to start, so it hit “too many clients” and crash-looped. Deleting, restarting or adding orders-api pods only adds more crash loops; scaling the export down frees the room.",
        tell: "The crashing pod’s “sorry, too many clients already”, and pg_stat_activity by application showing report-exporter holding 50.",
      },
    },
  },
  {
    id: "infra-t4-search-backfill-hog",
    title: "Storefront down to one pod during a backfill",
    severity: "SEV1",
    service: "storefront-api",
    briefing:
      "PagerDuty: storefront-api shedding traffic; checkout 5xx over 50%. Two of its three pods crash-loop. The search team started a reindex backfill at 21:00. You have kubectl and psql.",
    roleBriefing: "storefront-api serves product and checkout pages. A pod restart this evening should have been routine.",
    opensAtSecondOfDay: 21 * HOUR + 34 * MINUTE,
    lostCheckoutsPerPoint: 900,
    frontRevision: { number: 118, tag: "v12.4.0", changeCause: "v12.4.0 product badges from merchandising API", traits: [] },
    runningFrontPods: 1,
    hog: {
      name: "search-indexer",
      replicas: 3,
      poolSize: 20,
      revision: { number: 27, tag: "v3.2.0", changeCause: "v3.2.0 full reindex with synonyms", traits: [] },
      logs: [
        "backfill: reindexing products from orders-db (batch 5000, 3 workers)",
        "backfill: 412,000 / 1,930,500 products indexed",
        "backfill: 803,500 / 1,930,500 products indexed",
      ],
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — storefront-api upstream overflow, checkout 5xx > 50%. Assigned to you." },
      { at: 35, from: "Ade Okafor · Search", text: "Backfill’s about 40% done. We scaled the indexer to three at 21:00 to finish tonight." },
      { at: 90, from: "Sam Tan · Eng manager", text: "Roll back storefront? v12.4.0 went out this afternoon." },
      { at: 170, from: "Hana Sato · Support", text: "Customers getting “upstream overflow” pages on product and checkout." },
      { at: 260, from: "Elena Ruiz · VP Engineering", text: "We’re down to one pod during the evening peak. Fix first, explain later." },
    ],
    hints: [
      "The one healthy pod is overloaded, and the others can’t start. What do they fail on?",
      "Count the database connections by who holds them.",
      "Not everything that holds connections has to keep running right now.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl get deployments",
      "kubectl rollout undo deployment/storefront-api",
      "kubectl rollout restart deployment/storefront-api",
      'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"',
    ],
    solution: [
      { command: "kubectl get deployments", why: "storefront-api 1/3 ready; search-indexer 3/3 running beside it." },
      { command: "kubectl logs %CRASHING%", why: "The storefront pods die on “sorry, too many clients already”, not on a bug." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "search-indexer holds 60 connections; storefront-api only 20." },
      { command: "kubectl scale deployment/search-indexer --replicas=1", why: "One indexer keeps the backfill going slowly and frees 40 connections for storefront." },
      { command: "kubectl get pods", why: "storefront pods start after their back-off; declare resolved when overflow stops." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "storefront-api v12.4.0 crashed on start calling the merchandising API",
        "search-indexer at three replicas took storefront’s connections",
        "The evening peak exceeded what three storefront pods can serve",
        "orders-db failed over and dropped storefront’s connections",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The search team scaled search-indexer to three replicas with pools of 20; when storefront pods restarted, there were no connections left for them.",
        why: "orders-db allows 97 app connections. With 60 held by the indexer and 20 by the one storefront pod, the others hit “too many clients” on start and crash-looped, so one pod took all the traffic and shed most of it. Rolling back or restarting storefront doesn’t free connections; scaling the indexer down does.",
        tell: "Crash-looping storefront pods logging “sorry, too many clients already”, and pg_stat_activity showing search-indexer holding 60.",
      },
    },
  },
  {
    id: "infra-t4-reconciler-pool-hog",
    title: "Order capture stuck at two pods",
    severity: "SEV2",
    service: "order-capture",
    briefing:
      "PagerDuty: order-capture 5xx above 5% and p99 climbing. One pod crash-loops after a spot node was reclaimed. A rollout restart and a rollback to yesterday’s build both left it crash-looping. You have kubectl and psql.",
    roleBriefing: "order-capture takes checkout orders on three pods with pools of 20. Nothing about its own build changed today.",
    opensAtSecondOfDay: 13 * HOUR + 47 * MINUTE,
    lostCheckoutsPerPoint: 250,
    frontRevision: { number: 36, tag: "v5.8.1", changeCause: "v5.8.1 reject orders with an empty basket earlier", traits: [] },
    runningFrontPods: 2,
    hog: {
      name: "ledger-reconciler",
      replicas: 1,
      poolSize: 45,
      revision: { number: 9, tag: "v2.1.0", changeCause: "v2.1.0 config: HIKARI_MAXIMUM_POOL_SIZE 10 → 45 for faster reconciliation", traits: [] },
      logs: [
        "reconcile: comparing gateway settlements with orders for 2026-10-09 (pool=45)",
        "reconcile: 184,220 / 610,004 settlements matched",
        "reconcile: 371,950 / 610,004 settlements matched",
      ],
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — order-capture 5xx > 5% for 5m. Assigned to you." },
      { at: 30, from: "Lena Ortiz · Day on-call", text: "Restarted order-capture and rolled it back to yesterday. The third pod still won’t come up." },
      { at: 110, from: "Greta Lund · Finance eng", text: "We bumped the reconciler’s pool this morning so the books close before 15:00." },
      { at: 200, from: "Sam Tan · Eng manager", text: "Could we give order-capture a fourth pod to cover?" },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Checkout is limping. What is that pod waiting for?" },
    ],
    hints: [
      "The crashing pod runs the same build as its healthy siblings. Read how it dies.",
      "Ask Postgres who holds its connections, by application.",
      "A config change elsewhere can use up a limit everyone shares.",
    ],
    suggestions: [
      "kubectl get pods",
      "kubectl describe pods",
      "kubectl scale deployment/order-capture --replicas=4",
      "kubectl rollout restart deployment/order-capture",
      'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"',
    ],
    solution: [
      { command: "kubectl get pods", why: "Two order-capture pods Running, one in CrashLoopBackOff, and a ledger-reconciler pod." },
      { command: "kubectl logs %CRASHING%", why: "“sorry, too many clients already” on pool start-up." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "ledger-reconciler alone holds 45 connections, more than two order-capture pods." },
      { command: "kubectl rollout history deployment/ledger-reconciler", why: "Today’s config raised its pool from 10 to 45." },
      { command: "kubectl scale deployment/ledger-reconciler --replicas=0", why: "Pauses reconciliation and frees 45 connections until its pool goes back to 10." },
      { command: "kubectl get pods", why: "The third order-capture pod starts after its back-off; declare resolved once 5xx clears." },
    ],
    postmortem: {
      question: "What was the root cause?",
      options: [
        "The reclaimed spot node left order-capture without a schedulable slot",
        "ledger-reconciler’s pool of 45 took the connections the pod needed",
        "Yesterday’s order-capture build couldn’t start under load",
        "A pool of 20 per order-capture pod was too large for orders-db",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Finance raised ledger-reconciler’s Hikari pool from 10 to 45 this morning; when a spot reclaim rescheduled an order-capture pod, those connections were gone.",
        why: "orders-db allows 97 app connections. 45 for the reconciler plus 40 for two order-capture pods left 12, and a third pod needs 20, so it failed with “too many clients” and crash-looped. Restarting, rolling back or adding order-capture pods can’t make room; pausing the reconciler can.",
        tell: "The crash-looping pod’s “sorry, too many clients already”, and pg_stat_activity by application showing one reconciler pod holding 45.",
      },
    },
  },
];

/** A hog row's solution names its crash-looping pod; the name is deterministic, so it's filled in here. */
function withCrashingPod(row: HogRow): HogRow {
  const pod = crashLoopingPod(row);
  return { ...row, solution: row.solution.map((move) => ({ ...move, command: move.command.replace("%CRASHING%", pod) })) };
}

export const INFRA_TIER4_INCIDENTS: readonly Scenario[] = [
  ...INDEX_ROWS.map(invalidIndexIncident),
  ...LEAK_ROWS.map(hiddenDefectIncident),
  ...CRASH_ROWS.map(hiddenDefectIncident),
  ...HOG_ROWS.map(withCrashingPod).map(hogIncident),
];
