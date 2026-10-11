import { seededRandom } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import { templateHash, type ClusterEvent, type ClusterState, type ConnectionLeak, type CrashWhileServing, type Deployment, type HotIndex, type Job, type LogEntry, type Pod } from "../sim/model.ts";
import { isOnCleanBuild } from "./checkout-cluster.ts";

const WARM_UP_SECONDS = 30;
const HOUR = 3600;
const MINUTE = 60;

type ClusterSetup = {
  readonly seed: string;
  readonly deployment: string;
  readonly database: string;
  readonly maxConnections?: number;
  readonly hotIndex?: HotIndex;
  readonly revisions: Deployment["revisions"];
  readonly revision: number;
  readonly replicas?: number;
  readonly poolSize?: number;
  readonly podCapacityRps?: number;
  /** Connections each running pod has already stranded when the warm-up starts, pod by pod. */
  readonly leaked?: readonly number[];
  readonly podsStartedAgo?: number;
  readonly jobs?: readonly Job[];
  readonly logs?: Readonly<Record<string, readonly LogEntry[]>>;
  readonly events?: readonly ClusterEvent[];
};

/**
 * One Spring service on its own Postgres, 300 rps with 40% of it checkouts. Unlike `checkoutCluster`,
 * the service, database, pool, replica count and connection ceiling are the incident's to set.
 * Runs the outage up to the page, then zeroes the damage counters so scoring starts there.
 */
function serviceCluster(setup: ClusterSetup): ClusterState {
  const replicas = setup.replicas ?? 3;
  const hash = templateHash(setup.deployment, setup.revision, 0);
  const startedAgo = setup.podsStartedAgo ?? 1_200;
  const pods: Pod[] = Array.from({ length: replicas }, (_, index) => ({
    name: podName(setup.deployment, hash, index + 1),
    templateHash: hash,
    revision: setup.revision,
    phase: "Running",
    startedAt: -startedAgo - index * 35,
    phaseLeft: 0,
    leaked: setup.leaked?.[index] ?? 0,
    restarts: 0,
    connectionHistory: [],
  }));

  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [
      {
        name: setup.deployment,
        replicas,
        poolSize: setup.poolSize ?? 20,
        podCapacityRps: setup.podCapacityRps ?? 130,
        revision: setup.revision,
        generation: 0,
        revisions: setup.revisions,
        pods,
      },
    ],
    database: {
      name: setup.database,
      host: `${setup.database}.internal`,
      maxConnections: setup.maxConnections ?? 100,
      reservedConnections: 3,
      ...(setup.hotIndex ? { hotIndex: setup.hotIndex } : {}),
    },
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
    ...(setup.jobs ? { jobs: setup.jobs } : {}),
  };
  const random = seededRandom(`${setup.seed}:warm-up`);
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

function leak(dependency: string, leaksPerSecond: number, perPodRps: number): ConnectionLeak {
  return { kind: "leaks-connection-on-dependency-timeout", dependency, leaksPerSecondAtBaseline: leaksPerSecond, perPodBaselineRps: perPodRps };
}

function oomKilled(afterSeconds: number, jitterSeconds: number, lastWords: string): CrashWhileServing {
  return { kind: "crashes-while-serving", termination: { reason: "OOMKilled", exitCode: 137 }, afterSeconds, jitterSeconds, lastWords, failsCheckouts: false };
}

function log(source: string, t: number, level: LogEntry["level"], text: string): LogEntry {
  return { t, source, level, text };
}

const isIndexValid = (state: ClusterState) => state.database.hotIndex?.isValid ?? true;

const STATE_BY_STATE = 'psql -c "select state, count(*) from pg_stat_activity group by state"';
const SESSIONS_BY_APP = 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"';

// ── 1 · a hotfix built on the leaking build ─────────────────────────────────────────────

const hotfixKeepsLeaking: Scenario = {
  id: "infra-t3-hotfix-keeps-leaking",
  tier: 3,
  title: "Payments still time out after the hotfix",
  severity: "SEV2",
  service: "payments-api",
  briefing:
    "payments-api 5xx is climbing again. This morning’s connection timeouts got a hotfix, v3.9.1, at 14:05, and it hasn’t helped. You have kubectl on the prod bastion and a psql role on payments-db. Get payments back without guessing twice.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The payments lead wants the hotfix rolled back. Before you do, check what the build under it contains." },
  opensAtSecondOfDay: 14 * HOUR + 26 * MINUTE,
  seed: "infra-t3-hotfix-keeps-leaking",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-hotfix-keeps-leaking",
      deployment: "payments-api",
      database: "payments-db",
      revisions: [
        { number: 14, tag: "v3.8.2", changeCause: "v3.8.2 settle refunds in nightly batches", traits: [] },
        { number: 15, tag: "v3.9.0", changeCause: "v3.9.0 async capture for split-tender orders", traits: [leak("charge-relay", 0.06, 100)] },
        {
          number: 16,
          tag: "v3.9.1",
          changeCause: "v3.9.1 hotfix: Hikari leakDetectionThreshold=60000, charge-relay timeout 3s",
          traits: [leak("charge-relay", 0.07, 100)],
        },
      ],
      revision: 16,
      leaked: [19, 14, 8],
      podsStartedAgo: 1_260,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [
    {
      id: "charge-relay",
      status: "degraded",
      facts: [
        { key: "p99 from payments-api", value: "2.7 s (normal: 210 ms)" },
        { key: "Calls timing out", value: "≈3% of split-tender captures" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 re-triggered — payments-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Tomás Herrera · Payments lead", text: "The hotfix didn’t do it. Just undo it and we’re back where we were this morning, right?" },
    { at: 115, from: "Aiko Brandt · Support", text: "Gift card plus card orders fail the most. Plain card orders mostly go through." },
    { at: 200, from: "PagerDuty", text: "Escalated to SEV1 — payment success rate below 60%." },
    { at: 290, from: "Ravi Menon · Director of Engineering", text: "Finance closes the day at 15:00. I need a straight answer on whether this is fixed." },
  ],
  hints: [
    "Where we were this morning was already broken. Which build was running then?",
    "Read the change causes in order: the hotfix only tuned something it inherited.",
    "Going back one step lands on the build that started the leak. Go back further.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl logs deployment/payments-api", STATE_BY_STATE, "kubectl rollout history deployment/payments-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/payments-api", why: "charge-relay timeouts, then Hikari reporting active=20, idle=0: the pool is drained." },
      { command: STATE_BY_STATE, why: "Postgres sees those sessions as idle: borrowed and never returned. A leak, not load." },
      { command: "kubectl rollout history deployment/payments-api", why: "v3.9.0 added split-tender capture; v3.9.1 only tuned the timeout and leak detection on top of it." },
      { command: "kubectl rollout undo deployment/payments-api --to-revision=14", why: "Skip both builds that carry the capture path. A plain undo would land on v3.9.0, which leaks too." },
      { command: "kubectl rollout status deployment/payments-api", why: "Wait until every pod runs v3.8.2, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did payments keep timing out after the hotfix?",
    options: [
      "charge-relay latency pushed payments-db past max_connections",
      "v3.9.0’s split-tender capture leaked; v3.9.1 kept it",
      "The 60 s leak detection threshold closed connections still in use",
      "A pool of 20 per pod was too small for split-tender traffic",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v3.9.0’s async split-tender capture never returned its pooled connection when a charge-relay call timed out, and the v3.9.1 hotfix was built on top of it.",
      why: "Every timed-out capture stranded one connection until each pod’s 20 were pinned. The hotfix shortened a timeout and turned on leak detection, which only reports leaks. Undoing it one step put the pods on v3.9.0, which leaks the same way; only v3.8.2 predates the capture path.",
      tell: "Postgres showed the stuck sessions as idle while Hikari reported them active, and the rollout history showed v3.9.1 changing settings around a feature v3.9.0 introduced.",
    },
  },
  lostCheckoutsPerPoint: 400,
};

// ── 2 · a heap bump that makes the OOMKills come faster ─────────────────────────────────

const xmxBumpOom: Scenario = {
  id: "infra-t3-xmx-bump-oom",
  tier: 3,
  title: "Pricing pods die faster after the memory fix",
  severity: "SEV2",
  service: "pricing-api",
  briefing:
    "pricing-api has been restarting all morning, and the 11:20 fix that raised its heap made it worse. Checkout can’t price a basket while a pod is down. You have kubectl on the prod bastion.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Two builds went out today. Find which one started the restarts before you roll anything back." },
  opensAtSecondOfDay: 11 * HOUR + 34 * MINUTE,
  seed: "infra-t3-xmx-bump-oom",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-xmx-bump-oom",
      deployment: "pricing-api",
      database: "pricing-db",
      revisions: [
        { number: 30, tag: "v2.14.3", changeCause: "v2.14.3 round VAT per line, not per basket", traits: [] },
        {
          number: 31,
          tag: "v2.15.0",
          changeCause: "v2.15.0 cache promo prices per SKU in memory",
          traits: [oomKilled(110, 70, "[gc] GC(1184) Pause Young (Normal) (G1 Evacuation Pause) 742M->739M(768M) 61.402ms")],
        },
        {
          number: 32,
          tag: "v2.15.1",
          changeCause: "v2.15.1 raise -Xmx768m to -Xmx1000m (OOMKilled fix)",
          traits: [oomKilled(45, 40, "[gc] GC(612) Pause Young (Normal) (G1 Evacuation Pause) 981M->978M(1000M) 44.120ms")],
        },
      ],
      revision: 32,
      podsStartedAgo: 30,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — pricing-api 5xx > 5% (flapping). Assigned to you." },
    { at: 50, from: "Noor Haddad · Pricing team", text: "The heap bump was supposed to stop the OOMKills. Roll it back and we’ll look again after lunch." },
    { at: 130, from: "Aiko Brandt · Support", text: "Baskets show “price unavailable” for a few seconds, then work on refresh." },
    { at: 230, from: "Ravi Menon · Director of Engineering", text: "This has flapped since 10:00. I want it to stop, not to flap less." },
  ],
  hints: [
    "The restarts began before the heap change. What went out first today?",
    "A bigger heap inside the same memory limit leaves less room for everything that isn’t heap.",
    "Undoing the last build only takes you back to the first one that ran out of memory.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl logs deployment/pricing-api", "kubectl rollout history deployment/pricing-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Restarts climb pod by pod, so pricing fails in waves." },
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: OOMKilled, Exit Code 137 against a 1Gi limit." },
      { command: "kubectl rollout history deployment/pricing-api", why: "v2.15.0 added the in-memory promo cache; v2.15.1 only raised the heap ceiling under the same limit." },
      { command: "kubectl rollout undo deployment/pricing-api --to-revision=30", why: "Go back past the cache. A plain undo lands on v2.15.0, which runs out of memory too, just more slowly." },
      { command: "kubectl rollout status deployment/pricing-api", why: "Wait for every pod to run v2.14.3, then declare and watch the restarts stop." },
    ],
  },
  postmortem: {
    question: "Why did pricing-api keep getting OOMKilled?",
    options: [
      "The 1Gi limit was too small for pricing-api’s normal working set",
      "v2.15.0’s unbounded promo cache; the heap bump only sped it up",
      "pricing-db slowed down and requests piled up in pod memory",
      "The readiness probe failed during long GC pauses and killed pods",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v2.15.0 cached promo prices per SKU with no size limit, so each pod’s memory grew until the kernel killed it at the 1Gi limit.",
      why: "v2.15.1 raised the heap from 768m to 1000m inside the same 1Gi limit. The cache still grew, and now heap plus metaspace and thread stacks crossed the limit sooner, so pods died faster. Undoing one step returned to v2.15.0; only v2.14.3 has no cache.",
      tell: "describe showed OOMKilled with exit code 137 and no Java OutOfMemoryError in the logs: the kernel killed the container, not the JVM. The heap was full in both builds’ last GC lines.",
    },
  },
  lostCheckoutsPerPoint: 200,
};

// ── 3 · metaspace crash on top of an older leak ─────────────────────────────────────────

const metaspaceOverLeak: Scenario = {
  id: "infra-t3-metaspace-undo-leaks",
  tier: 3,
  title: "Invoice payments crash, then stall",
  severity: "SEV2",
  service: "invoice-api",
  briefing:
    "invoice-api pods exit every couple of minutes since v8.6.0 went out, and B2B customers paying invoices by card see errors. You have kubectl on the prod bastion and a psql role on invoices-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The crash is loud. Check whether it’s the only thing wrong before you pick a build to go back to." },
  opensAtSecondOfDay: 9 * HOUR + 47 * MINUTE,
  seed: "infra-t3-metaspace-undo-leaks",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-metaspace-undo-leaks",
      deployment: "invoice-api",
      database: "invoices-db",
      revisions: [
        { number: 50, tag: "v8.4.0", changeCause: "v8.4.0 net-30 terms for B2B accounts", traits: [] },
        { number: 51, tag: "v8.5.0", changeCause: "v8.5.0 charge saved cards on invoice due date", traits: [leak("card-gateway", 0.06, 100)] },
        {
          number: 52,
          tag: "v8.6.0",
          changeCause: "v8.6.0 per-tenant invoice templates (Groovy)",
          traits: [
            leak("card-gateway", 0.06, 100),
            {
              kind: "crashes-while-serving",
              termination: { reason: "Error", exitCode: 3 },
              afterSeconds: 90,
              jitterSeconds: 60,
              lastWords: "Terminating due to java.lang.OutOfMemoryError: Metaspace",
              failsCheckouts: false,
            },
          ],
        },
      ],
      revision: 52,
      leaked: [11, 7, 4],
      podsStartedAgo: 40,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [
    { id: "card-gateway", status: "degraded", facts: [{ key: "p99 from invoice-api", value: "2.8 s (normal: 240 ms)" }, { key: "Calls timing out", value: "≈4%" }] },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — invoice-api 5xx > 5% (flapping). Assigned to you." },
    { at: 45, from: "Lucía Ferraro · Billing team", text: "Templates went out at 09:30, that’s the crash. Roll it back and we’ll fix the class loading." },
    { at: 140, from: "Aiko Brandt · Support", text: "Two wholesale customers say their card payment spun and then failed, even between the restarts." },
    { at: 250, from: "Ravi Menon · Director of Engineering", text: "Month-end invoices are due today. Make sure whatever you roll back to actually holds." },
  ],
  hints: [
    "Two things are wrong here. Only one of them restarts pods.",
    "Some failures happen while every pod is up. Look at what the pool is doing between crashes.",
    "The build before the templates added card charging. Was it healthy?",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl logs deployment/invoice-api", STATE_BY_STATE, "kubectl rollout history deployment/invoice-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl describe pods", why: "Pods exit with code 3: the JVM terminated itself on OutOfMemoryError: Metaspace, not the kernel." },
      { command: "kubectl logs deployment/invoice-api", why: "Between the crashes, card-gateway charges time out and the pool fills up." },
      { command: STATE_BY_STATE, why: "Idle sessions piling up while traffic is flat: connections borrowed and never returned." },
      { command: "kubectl rollout history deployment/invoice-api", why: "v8.5.0 added card charging, and v8.6.0 was built on it. The leak predates the templates." },
      { command: "kubectl rollout undo deployment/invoice-api --to-revision=50", why: "Go back past both. A plain undo stops the crashes but lands on v8.5.0’s leak." },
      { command: "kubectl rollout status deployment/invoice-api", why: "Wait for v8.4.0 on every pod, then declare." },
    ],
  },
  postmortem: {
    question: "Which build had to go?",
    options: [
      "Only v8.6.0: its Groovy templates filled metaspace",
      "v8.6.0 and the leaking v8.5.0 under it",
      "Neither: card-gateway latency was the whole outage",
      "Only v8.5.0: the crashes were the pool running out",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v8.6.0 compiled a new Groovy class per tenant template and filled metaspace, and it sat on v8.5.0, whose card charging stranded a pooled connection on every card-gateway timeout.",
      why: "The metaspace crash restarted pods often enough to hide the leak: a pod rarely lived long enough to drain its pool. Rolling back one build stopped the crashes and let the leak run to the end. Only v8.4.0 had neither.",
      tell: "Exit code 3 with “Terminating due to java.lang.OutOfMemoryError: Metaspace” explained the restarts, but card-gateway timeouts and idle sessions were climbing in pods that hadn’t crashed yet.",
    },
  },
  lostCheckoutsPerPoint: 150,
};

// ── 4 · undo lands on the build that threw on checkout ──────────────────────────────────

const undoIntoCrash: Scenario = {
  id: "infra-t3-undo-into-serializer-bug",
  tier: 3,
  title: "Express checkout drains its pool",
  severity: "SEV2",
  service: "express-checkout-api",
  briefing:
    "express-checkout-api is failing one-tap payments more every minute. v11.3.1 went out at 16:10 to fix yesterday’s upgrade. You have kubectl on the prod bastion and a psql role on express-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Read the rollout history before you roll back: the build before this one wasn’t a good one either." },
  opensAtSecondOfDay: 16 * HOUR + 38 * MINUTE,
  seed: "infra-t3-undo-into-serializer-bug",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-undo-into-serializer-bug",
      deployment: "express-checkout-api",
      database: "express-db",
      revisions: [
        { number: 60, tag: "v11.2.0", changeCause: "v11.2.0 one-tap reorder from order history", traits: [] },
        {
          number: 61,
          tag: "v11.3.0",
          changeCause: "v11.3.0 Spring Boot 3.4 upgrade",
          traits: [
            {
              kind: "crashes-while-serving",
              termination: { reason: "Error", exitCode: 1 },
              afterSeconds: 1_000_000,
              jitterSeconds: 0,
              lastWords:
                'com.fasterxml.jackson.databind.exc.InvalidDefinitionException: Java 8 date/time type `java.time.Instant` not supported by default: add Module "com.fasterxml.jackson.datatype:jackson-datatype-jsr310" to enable handling',
              failsCheckouts: true,
            },
          ],
        },
        { number: 62, tag: "v11.3.1", changeCause: "v11.3.1 register JavaTimeModule; psp-router client 2.0", traits: [leak("psp-router", 0.07, 100)] },
      ],
      revision: 62,
      leaked: [19, 13, 9],
      podsStartedAgo: 1_500,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "psp-router", status: "degraded", facts: [{ key: "p99", value: "2.6 s (normal: 160 ms)" }, { key: "Calls timing out", value: "≈3%" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — express-checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 35, from: "Femi Adeyemi · Checkout team", text: "v11.3.1 fixed the Instant serialization crash from yesterday. If it’s misbehaving, roll it back." },
    { at: 120, from: "Aiko Brandt · Support", text: "One-tap reorders spin and fail. Paying from the cart page is a bit better." },
    { at: 210, from: "PagerDuty", text: "Escalated to SEV1 — express checkout success rate below 55%." },
    { at: 300, from: "Ravi Menon · Director of Engineering", text: "The evening push notification goes out at 17:00. Don’t send people into a broken checkout." },
  ],
  hints: [
    "Yesterday’s build was rolled forward for a reason. What was wrong with it?",
    "The fix build changed two things. Only one of them was the fix.",
    "There is a build that has neither the upgrade’s bug nor the new payment client.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl logs deployment/express-checkout-api", STATE_BY_STATE, "kubectl rollout history deployment/express-checkout-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/express-checkout-api", why: "psp-router charge timeouts, then Hikari with every connection active and none idle." },
      { command: STATE_BY_STATE, why: "Postgres calls the stuck sessions idle: the app borrowed them and never gave them back." },
      { command: "kubectl rollout history deployment/express-checkout-api", why: "v11.3.1 also swapped in psp-router client 2.0. v11.3.0 is the upgrade that threw on every checkout." },
      { command: "kubectl rollout undo deployment/express-checkout-api --to-revision=60", why: "Back to v11.2.0. A plain undo would put every pod on v11.3.0, which fails every checkout it serves." },
      { command: "kubectl rollout status deployment/express-checkout-api", why: "Wait for v11.2.0 on every pod, then declare." },
    ],
  },
  postmortem: {
    question: "What drained express-checkout-api’s pool?",
    options: [
      "Spring Boot 3.4 changed Hikari’s default pool size to 10",
      "v11.3.1’s psp-router client 2.0 leaked on timeouts",
      "The Instant serialization bug left transactions open",
      "psp-router latency on its own exhausted express-db",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v11.3.1 shipped psp-router client 2.0 alongside the JavaTimeModule fix, and the new client never returned its pooled connection when a charge timed out.",
      why: "Each timeout stranded a connection until the pool of 20 was gone. The obvious rollback went one step back to v11.3.0, whose Jackson upgrade threw InvalidDefinitionException on every checkout. v11.2.0 predates both.",
      tell: "Idle sessions in pg_stat_activity against a pool Hikari called fully active, timeouts naming psp-router, and a change cause that bundled a client upgrade into a one-line fix.",
    },
  },
  lostCheckoutsPerPoint: 450,
};

// ── 5–7, 14 · a rollout that needs one more seat than the database has ────────────────────

const surgeBlockedFourPods: Scenario = {
  id: "infra-t3-surge-blocked-four-pods",
  tier: 3,
  title: "Checkout leaks on four pods",
  severity: "SEV2",
  service: "checkout-api",
  briefing:
    "checkout-api 5xx is climbing since v4.21.0 went out. It runs four pods with pools of 20 on orders-db, which is capped at 100 connections. You have kubectl on the prod bastion and a psql role on orders-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Before you roll anything, count the connections a rollout needs and the ones orders-db has left." },
  opensAtSecondOfDay: 12 * HOUR + 8 * MINUTE,
  seed: "infra-t3-surge-blocked-four-pods",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-surge-blocked-four-pods",
      deployment: "checkout-api",
      database: "orders-db",
      revisions: [
        { number: 20, tag: "v4.20.1", changeCause: "v4.20.1 store-pickup time slots", traits: [] },
        { number: 21, tag: "v4.21.0", changeCause: "v4.21.0 parallel payment-gateway calls for split shipments", traits: [leak("payment-gateway", 0.06, 75)] },
      ],
      revision: 21,
      replicas: 4,
      leaked: [20, 16, 11, 6],
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "payment-gateway", status: "degraded", facts: [{ key: "p99", value: "2.9 s (normal: 180 ms)" }, { key: "Calls timing out", value: "≈3%" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 50, from: "Greta Lindqvist · DBA", text: "orders-db is sitting at 80 of 100 connections, all from checkout-api. Don’t add anything that opens more." },
    { at: 125, from: "Owen Price · Checkout team", text: "Split shipments shipped this morning. Roll it back, it’s the only change." },
    { at: 215, from: "PagerDuty", text: "Escalated to SEV1 — checkout success rate below 60%." },
    { at: 300, from: "Ravi Menon · Director of Engineering", text: "Is the rollback done? Why is it still running v4.21.0?" },
  ],
  hints: [
    "A rolling update starts a new pod before it stops an old one. What does that new pod need?",
    "Compare four full pools plus one more with what orders-db allows.",
    "Make room first, then change the build.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl logs deployment/checkout-api", 'psql -c "show max_connections"', SESSIONS_BY_APP, "kubectl rollout history deployment/checkout-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/checkout-api", why: "payment-gateway timeouts and an empty Hikari pool on the newest build." },
      { command: 'psql -c "show max_connections"', why: "100, three of them reserved for superusers: 97 for the app." },
      { command: SESSIONS_BY_APP, why: "checkout-api holds 80. A surge pod would ask for 20 more, and Postgres would refuse it." },
      { command: "kubectl scale deployment/checkout-api --replicas=3", why: "Three pods carry the traffic and free a pool, so the rollout has room for its surge pod." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Roll back to v4.20.1. Without the room above, the new pod would crash-loop on “too many clients” and the rollout would stall." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for three pods on v4.20.1, then declare. Scale back to four once the pools stay flat." },
    ],
  },
  postmortem: {
    question: "Why does a plain rollback stall here?",
    options: [
      "The rollback image wasn’t cached on the nodes",
      "The surge pod needs a pool orders-db can’t give",
      "maxUnavailable 0 forbids rolling back four pods at once",
      "The readiness probe fails on any pod with a leak",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v4.21.0 leaked a connection per payment-gateway timeout; rolling it back needed a fifth pool of 20 on top of the 80 checkout-api already held, and orders-db allows 97.",
      why: "RollingUpdate with maxSurge 1 and maxUnavailable 0 starts the new pod first. Its pool initialization hit FATAL: sorry, too many clients already, so it crash-looped, no old pod was ever stopped, and the leak kept running. Scaling to three first freed a pool and let the rollout through.",
      tell: "show max_connections said 100, pg_stat_activity counted 80 sessions from checkout-api, and the surge pod died on “sorry, too many clients already”.",
    },
  },
  lostCheckoutsPerPoint: 500,
};

const walletRestartStalls: Scenario = {
  id: "infra-t3-wallet-restart-stalls",
  tier: 3,
  title: "Wallet payments fail after token refresh",
  severity: "SEV2",
  service: "wallet-api",
  briefing:
    "Apple Pay and Google Pay are failing at checkout. wallet-api runs three pods with pools of 25 on wallet-db, capped at 100 connections. You have kubectl on the prod bastion and a psql role on wallet-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "A restart is the team’s usual answer to a full pool. Check whether this database has room for one." },
  opensAtSecondOfDay: 19 * HOUR + 12 * MINUTE,
  seed: "infra-t3-wallet-restart-stalls",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-wallet-restart-stalls",
      deployment: "wallet-api",
      database: "wallet-db",
      revisions: [
        { number: 33, tag: "v1.18.4", changeCause: "v1.18.4 Google Pay token format v2", traits: [] },
        { number: 34, tag: "v1.19.0", changeCause: "v1.19.0 re-tokenize expired wallet cards at charge time", traits: [leak("wallet-gateway", 0.08, 100)] },
      ],
      revision: 34,
      poolSize: 25,
      podCapacityRps: 160,
      leaked: [25, 19, 12],
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "wallet-gateway", status: "degraded", facts: [{ key: "p99", value: "3.1 s (normal: 300 ms)" }, { key: "Re-tokenize calls timing out", value: "≈5%" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — wallet-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Kenji Watanabe · Wallet team", text: "Last time the pool filled we did a rolling restart and it cleared. Can you kick it?" },
    { at: 130, from: "Aiko Brandt · Support", text: "Apple Pay sheet spins and then says “Payment not completed”." },
    { at: 220, from: "PagerDuty", text: "Escalated to SEV1 — wallet payment success rate below 60%." },
    { at: 310, from: "Ravi Menon · Director of Engineering", text: "Evening peak starts at 19:30. Where are we?" },
  ],
  hints: [
    "Three pools of 25 is already a lot for a database capped at 100.",
    "A restart and a rollback both start a fresh pod before they stop an old one.",
    "Restarting clears the pool for a while. The build still leaks.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl logs deployment/wallet-api", 'psql -c "show max_connections"', "kubectl rollout history deployment/wallet-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/wallet-api", why: "wallet-gateway timeouts, then a Hikari pool with every connection active." },
      { command: "kubectl describe pods", why: "SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE is 25 per pod." },
      { command: 'psql -c "show max_connections"', why: "100 with 3 reserved: 75 in use leaves no room for a fourth pool." },
      { command: "kubectl rollout history deployment/wallet-api", why: "v1.19.0 added re-tokenizing at charge time." },
      { command: "kubectl scale deployment/wallet-api --replicas=2", why: "Two pods carry the load and free 25 connections for the rollout’s surge pod." },
      { command: "kubectl rollout undo deployment/wallet-api", why: "Roll back to v1.18.4 now that a new pod can open its pool." },
      { command: "kubectl rollout status deployment/wallet-api", why: "Wait for two pods on v1.18.4, then declare. Scale back to three later." },
    ],
  },
  postmortem: {
    question: "Why did the rolling restart make things worse?",
    options: [
      "The restart dropped the in-flight wallet tokens",
      "Its surge pod couldn’t get 25 connections from wallet-db",
      "Restarting all three pods at once took wallet-api offline",
      "wallet-gateway rate-limited the reconnecting pods",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v1.19.0 leaked a connection on every wallet-gateway timeout, and wallet-db had no room for the extra pool any rollout needs.",
      why: "Three pools of 25 held 75 of wallet-db’s 97 usable connections. A restart or rollback starts a fourth pod first; its pool asked for 25 more, Postgres answered FATAL: sorry, too many clients already, and the rollout stalled with the leaking pods still serving. Scaling to two first made room for the rollback.",
      tell: "The surge pod crash-looped on “too many clients” while pg_stat_activity counted 75 sessions from wallet-api against a cap of 100.",
    },
  },
  lostCheckoutsPerPoint: 300,
};

const bnplFiveSmallPools: Scenario = {
  id: "infra-t3-bnpl-five-small-pools",
  tier: 3,
  title: "Pay-later checkout keeps stalling",
  severity: "SEV2",
  service: "bnpl-api",
  briefing:
    "Customers paying in instalments get errors since v0.32.0. bnpl-api runs five small pods with pools of 15 on bnpl-db, which is capped at 90 connections. You have kubectl on the prod bastion and a psql role on bnpl-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The bad build is easy to find. Getting off it on a database this full is the hard part." },
  opensAtSecondOfDay: 13 * HOUR + 3 * MINUTE,
  seed: "infra-t3-bnpl-five-small-pools",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-bnpl-five-small-pools",
      deployment: "bnpl-api",
      database: "bnpl-db",
      maxConnections: 90,
      revisions: [
        { number: 7, tag: "v0.31.2", changeCause: "v0.31.2 show the instalment schedule before paying", traits: [] },
        { number: 8, tag: "v0.32.0", changeCause: "v0.32.0 retry instalment charges on bnpl-provider 5xx", traits: [leak("bnpl-provider", 0.05, 60)] },
      ],
      revision: 8,
      replicas: 5,
      poolSize: 15,
      podCapacityRps: 80,
      leaked: [15, 13, 9, 6, 3],
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "bnpl-provider", status: "degraded", facts: [{ key: "Status page", value: "Investigating elevated error rates" }, { key: "p99", value: "2.8 s" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — bnpl-api 5xx > 5% for 5m. Assigned to you." },
    { at: 55, from: "Hana Novak · BNPL team", text: "We added retries for the provider’s 5xx this morning. Roll back please." },
    { at: 140, from: "Greta Lindqvist · DBA", text: "bnpl-db is a small instance: 90 connections. bnpl-api has 75 of them." },
    { at: 240, from: "Ravi Menon · Director of Engineering", text: "Pay-later is a third of basket value on sale days. Today is a sale day." },
  ],
  hints: [
    "Five pools of 15 plus one more: does that fit under the cap?",
    "A pod that can’t open its pool exits before it ever serves.",
    "Four pods carry this traffic fine.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/bnpl-api", 'psql -c "show max_connections"', SESSIONS_BY_APP, "kubectl rollout history deployment/bnpl-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/bnpl-api", why: "bnpl-provider charge timeouts, and pods whose 15 connections are all checked out." },
      { command: SESSIONS_BY_APP, why: "bnpl-api holds 75 sessions." },
      { command: 'psql -c "show max_connections"', why: "90, so 87 usable. A sixth pool of 15 makes 90: the surge pod would be refused." },
      { command: "kubectl scale deployment/bnpl-api --replicas=4", why: "Four pods carry 300 rps and leave room for one surge pod." },
      { command: "kubectl rollout undo deployment/bnpl-api", why: "Back to v0.31.2. Without the room, the new pod would crash-loop and the rollout would stall." },
      { command: "kubectl rollout status deployment/bnpl-api", why: "Wait for four pods on v0.31.2, then declare." },
    ],
  },
  postmortem: {
    question: "What had to happen before the rollback could work?",
    options: [
      "bnpl-provider had to recover from its own outage first",
      "Free one pool so the surge pod could connect",
      "Kill the idle sessions so the pools were empty",
      "Raise max_connections on bnpl-db to 200",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v0.32.0’s retries stranded a pooled connection on every bnpl-provider timeout, and bnpl-db had no room for the extra pool a rolling update needs.",
      why: "Five pools of 15 held 75 of 87 usable connections. The rollback’s surge pod asked for 15 more and got FATAL: sorry, too many clients already, so it crash-looped and no old pod was retired. Dropping to four pods freed a pool; raising max_connections needs a Postgres restart, and killing sessions doesn’t empty a leaked pool.",
      tell: "Six pools of 15 is 90, above the 87 the app may use, and the surge pod’s last words were “too many clients already”.",
    },
  },
  lostCheckoutsPerPoint: 150,
};

const subscriptionsSixPods: Scenario = {
  id: "infra-t3-subscriptions-six-pods",
  tier: 3,
  title: "Subscription renewals start failing",
  severity: "SEV2",
  service: "subscriptions-api",
  briefing:
    "Renewal charges and new subscriptions fail since v5.1.0’s smart retries went out. subscriptions-api runs six pods with pools of 15 on billing-db, capped at 100. You have kubectl on the prod bastion and a psql role on billing-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Someone will ask you to restart it. Work out what a restart needs from billing-db first." },
  opensAtSecondOfDay: 6 * HOUR + 2 * MINUTE,
  seed: "infra-t3-subscriptions-six-pods",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-subscriptions-six-pods",
      deployment: "subscriptions-api",
      database: "billing-db",
      revisions: [
        { number: 12, tag: "v5.0.3", changeCause: "v5.0.3 pause a subscription from the app", traits: [] },
        { number: 13, tag: "v5.1.0", changeCause: "v5.1.0 smart retries for failed renewal charges", traits: [leak("billing-gateway", 0.04, 50)] },
      ],
      revision: 13,
      replicas: 6,
      poolSize: 15,
      podCapacityRps: 65,
      leaked: [15, 14, 10, 7, 4, 2],
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "billing-gateway", status: "degraded", facts: [{ key: "p99", value: "2.6 s (normal: 200 ms)" }, { key: "Renewal batch", value: "06:00 run in progress" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — subscriptions-api 5xx > 5% for 5m. Assigned to you." },
    { at: 45, from: "Ines Duarte · Billing team", text: "Morning! Can you just restart subscriptions-api? The renewal batch always unsticks after a restart." },
    { at: 150, from: "Aiko Brandt · Support", text: "People are getting “your payment failed” emails for cards that work fine." },
    { at: 260, from: "Ravi Menon · Director of Engineering", text: "Failed renewals send dunning emails. Every minute is more angry customers." },
  ],
  hints: [
    "Six pools of 15 is 90. What’s the ceiling, and what does a seventh pod do to it?",
    "A restart rolls like a deploy: new pod first.",
    "The pool will drain again on this build however many times it restarts.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/subscriptions-api", 'psql -c "show max_connections"', SESSIONS_BY_APP, "kubectl rollout history deployment/subscriptions-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/subscriptions-api", why: "billing-gateway timeouts and starved Hikari pools on v5.1.0." },
      { command: SESSIONS_BY_APP, why: "subscriptions-api holds 90 of billing-db’s connections." },
      { command: 'psql -c "show max_connections"', why: "100 with 3 reserved: no room for a seventh pool." },
      { command: "kubectl rollout history deployment/subscriptions-api", why: "v5.1.0 added smart retries; v5.0.3 didn’t have them." },
      { command: "kubectl scale deployment/subscriptions-api --replicas=5", why: "Five pods carry the traffic and leave room for one surge pod." },
      { command: "kubectl rollout undo deployment/subscriptions-api", why: "Back to v5.0.3. A restart or rollback without the room would stall on a crash-looping pod." },
      { command: "kubectl rollout status deployment/subscriptions-api", why: "Wait for five pods on v5.0.3, then declare." },
    ],
  },
  postmortem: {
    question: "Why did the restart stall?",
    options: [
      "The renewal batch held table locks the new pod waited on",
      "A seventh pool of 15 didn’t fit in billing-db",
      "The new pods failed readiness while the batch ran",
      "Kubernetes refused to restart during a CronJob",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v5.1.0’s smart retries stranded a pooled connection on every billing-gateway timeout, and billing-db had no room for the extra pool a rolling restart needs.",
      why: "Six pools of 15 held 90 of 97 usable connections. The restart’s surge pod asked for 15 more, got FATAL: sorry, too many clients already, and crash-looped while the six leaking pods kept serving. Even a clean restart would only have reset the leak. Scaling to five made room, and the rollback removed the leak.",
      tell: "90 sessions from one app against max_connections 100, and a surge pod dying on “too many clients already”.",
    },
  },
  lostCheckoutsPerPoint: 300,
};

// ── 8 · scaling out into max_connections ────────────────────────────────────────────────

const loyaltyScaleOut: Scenario = {
  id: "infra-t3-loyalty-scale-out",
  tier: 3,
  title: "Points redemption errors at checkout",
  severity: "SEV2",
  service: "loyalty-api",
  briefing:
    "Customers paying partly with loyalty points get errors since v3.4.0 went out. loyalty-api runs three pods with pools of 20 on loyalty-db, a small instance capped at 90 connections. You have kubectl on the prod bastion and a psql role on loyalty-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Leadership wants more pods. Check what more pods cost loyalty-db before you add any." },
  opensAtSecondOfDay: 17 * HOUR + 44 * MINUTE,
  seed: "infra-t3-loyalty-scale-out",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-loyalty-scale-out",
      deployment: "loyalty-api",
      database: "loyalty-db",
      maxConnections: 90,
      revisions: [
        { number: 41, tag: "v3.3.0", changeCause: "v3.3.0 tiered points multipliers", traits: [] },
        { number: 42, tag: "v3.4.0", changeCause: "v3.4.0 redeem points as partial payment", traits: [leak("points-gateway", 0.06, 100)] },
      ],
      revision: 42,
      leaked: [19, 15, 10],
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "points-gateway", status: "degraded", facts: [{ key: "p99", value: "2.7 s (normal: 150 ms)" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — loyalty-api 5xx > 5% for 5m. Assigned to you." },
    { at: 30, from: "Ravi Menon · Director of Engineering", text: "Double-points weekend traffic. Throw more pods at it, six or eight, whatever it takes." },
    { at: 110, from: "Greta Lindqvist · DBA", text: "loyalty-db is the small one: 90 connections. I can’t resize it before Monday." },
    { at: 200, from: "PagerDuty", text: "Escalated to SEV1 — points redemption success rate below 60%." },
  ],
  hints: [
    "Traffic is no higher than yesterday. Why would more pods help?",
    "Each new pod opens a full pool before it serves anything. Count them against the cap.",
    "The pools drain on the newest build only.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl top pods", "kubectl logs deployment/loyalty-api", 'psql -c "show max_connections"', STATE_BY_STATE] },
  solution: {
    infrastructure: [
      { command: "kubectl top pods", why: "The starved pod idles on CPU: it isn’t overloaded, it’s waiting for connections." },
      { command: "kubectl logs deployment/loyalty-api", why: "points-gateway timeouts, then Hikari with all 20 active and none idle." },
      { command: STATE_BY_STATE, why: "Idle sessions in Postgres the app thinks are busy: a leak." },
      { command: "kubectl rollout history deployment/loyalty-api", why: "v3.4.0 added points as partial payment." },
      { command: "kubectl rollout undo deployment/loyalty-api", why: "Back to v3.3.0. One surge pod fits under 87 connections; two more pods would not." },
      { command: "kubectl rollout status deployment/loyalty-api", why: "Wait for v3.3.0 on all three pods, then declare." },
    ],
  },
  postmortem: {
    question: "Why would scaling loyalty-api out not have helped?",
    options: [
      "New pods would inherit the old pods’ leaked connections",
      "Extra pools crash-loop past 87, and pods still leak",
      "The HPA would immediately scale it back to three",
      "points-gateway limits each client to three connections",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v3.4.0 stranded a pooled connection on every points-gateway timeout until a pod’s pool of 20 was gone.",
      why: "Traffic was normal; the pods were starved, not busy. Each extra pod opens 20 connections at start-up, and loyalty-db allows 87, so the fifth pod on would die with FATAL: sorry, too many clients already, and the ones that fit would leak like the rest. The rollback needed only one surge pod, which fit.",
      tell: "kubectl top showed the failing pod nearly idle, and Postgres listed its sessions as idle while Hikari called them active.",
    },
  },
  lostCheckoutsPerPoint: 550,
};

// ── 9–11 · an INVALID index, and three tempting ways to make it worse ───────────────────

const failoverInvalidIndex: Scenario = {
  id: "infra-t3-failover-invalid-index",
  tier: 3,
  title: "Checkout slows after the database failover",
  severity: "SEV2",
  service: "checkout-api",
  briefing:
    "orders-db failed over at 03:12 during maintenance. Since the morning traffic arrived, checkout-api p99 is over a second and 5xx is climbing. No deploy since yesterday. You have kubectl on the prod bastion and a psql role on orders-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The pods look busy. Before you add more, find out what they are waiting on." },
  opensAtSecondOfDay: 7 * HOUR + 41 * MINUTE,
  seed: "infra-t3-failover-invalid-index",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-failover-invalid-index",
      deployment: "checkout-api",
      database: "orders-db",
      hotIndex: {
        name: "orders_customer_pending_idx",
        definition: "btree (customer_id, created_at DESC) WHERE status = 'pending'::text",
        query: "SELECT id FROM orders WHERE customer_id = $1 AND status = 'pending' AND created_at > now() - interval '30 minutes'",
        isValid: false,
        cacheEviction: 0.12,
        rebuild: null,
      },
      revisions: [
        { number: 9, tag: "v4.13.0", changeCause: "v4.13.0 reuse pending orders on retry", traits: [] },
        { number: 10, tag: "v4.13.1", changeCause: "v4.13.1 log pending-order reuse", traits: [] },
      ],
      revision: 10,
      podsStartedAgo: 30_000,
      jobs: [{ name: "migrate-0151", status: "Failed", finishedAt: -16_140, durationSeconds: 412 }],
      logs: {
        "migrate-0151": [
          log("migrate-0151", -16_552, "INFO", "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_status_idx;"),
          log("migrate-0151", -16_540, "INFO", "CREATE INDEX CONCURRENTLY orders_customer_pending_idx ON orders (customer_id, created_at DESC) WHERE status = 'pending';"),
          log("migrate-0151", -16_141, "ERROR", "FATAL:  terminating connection due to administrator command"),
          log("migrate-0151", -16_141, "ERROR", "server closed the connection unexpectedly"),
          log("migrate-0151", -16_141, "ERROR", "\tThis probably means the server terminated abnormally"),
          log("migrate-0151", -16_141, "ERROR", "\tbefore or while processing the request."),
          log("migrate-0151", -16_140, "ERROR", "connection to server was lost"),
        ],
      },
    }),
  isRootCauseFixed: isIndexValid,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api p99 > 1s and 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Ravi Menon · Director of Engineering", text: "Morning rush is coming. Scale checkout-api out, double it if you have to." },
    { at: 120, from: "Greta Lindqvist · DBA", text: "Failover itself was clean. orders-db CPU is high though, lots of sequential reads." },
    { at: 210, from: "PagerDuty", text: "Escalated to SEV1 — checkout success rate below 60%." },
  ],
  hints: [
    "The pods hold their connections longer, not more of them. What is each one running?",
    "Something ran on orders-db during the maintenance window. Did it finish?",
    "More pods means more pools on a database that is already busy.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", STATE_BY_STATE, 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', "kubectl get jobs", 'psql -c "\\d orders"'],
  },
  solution: {
    infrastructure: [
      { command: STATE_BY_STATE, why: "Mostly active sessions: Postgres is doing slow work, not holding leaked connections." },
      { command: 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', why: "The pending-order lookup takes hundreds of milliseconds and keeps getting slower." },
      { command: "kubectl get jobs", why: "migrate-0151 Failed during the maintenance window." },
      { command: "kubectl logs job/migrate-0151", why: "It dropped the old index, then lost its connection mid-CREATE INDEX CONCURRENTLY when the primary shut down." },
      { command: 'psql -c "\\d orders"', why: "orders_customer_pending_idx is INVALID: Postgres ignores it and seq-scans orders." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_customer_pending_idx"', why: "Rebuild it without locking orders against writes." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch the rebuild finish, then declare once 5xx drops." },
    ],
  },
  postmortem: {
    question: "What was the root cause?",
    options: [
      "The failover promoted a replica with a cold buffer cache",
      "Migration 0151’s index was left INVALID by the failover",
      "checkout-api needed more pods for the morning traffic",
      "The new primary has a lower max_connections setting",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Migration 0151 dropped the old orders index, then lost its connection when the failover shut the primary down mid-CREATE INDEX CONCURRENTLY, leaving the new index INVALID.",
      why: "Postgres never uses an invalid index, so the pending-order lookup seq-scanned orders and held each pooled connection for longer as the scans evicted the hot set. Scaling out adds pools of 20 to a database that allows 97, so the fifth pod would crash-loop on “too many clients”, and the ones that fit run the same slow query. REINDEX CONCURRENTLY rebuilds it without blocking writes.",
      tell: "Active sessions all running one statement, \\d orders marking the index INVALID, and the job log ending in “terminating connection due to administrator command”.",
    },
  },
  lostCheckoutsPerPoint: 450,
};

const runbookPlainReindex: Scenario = {
  id: "infra-t3-runbook-plain-reindex",
  tier: 3,
  title: "Order placement crawls after a node drain",
  severity: "SEV2",
  service: "orders-api",
  briefing:
    "orders-api’s duplicate-order check is slow and 5xx is climbing. Last night a node drain evicted the weekly index-maintenance job. The DBA runbook has a one-line fix for this. You have kubectl on the prod bastion and a psql role on orders-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The runbook is from before orders took writes around the clock. Read the fix before you paste it." },
  opensAtSecondOfDay: 8 * HOUR + 19 * MINUTE,
  seed: "infra-t3-runbook-plain-reindex",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-runbook-plain-reindex",
      deployment: "orders-api",
      database: "orders-db",
      hotIndex: {
        name: "orders_customer_id_status_idx",
        definition: "btree (customer_id, status)",
        query: "SELECT count(*) FROM orders WHERE customer_id = $1 AND status = 'pending'",
        isValid: false,
        cacheEviction: 0.08,
        rebuild: null,
      },
      revisions: [
        { number: 27, tag: "v6.4.0", changeCause: "v6.4.0 block duplicate orders within 30 s", traits: [] },
        { number: 28, tag: "v6.4.1", changeCause: "v6.4.1 return 409 on duplicate order", traits: [] },
      ],
      revision: 28,
      podsStartedAgo: 50_000,
      jobs: [{ name: "index-maintenance", status: "Failed", finishedAt: -21_700, durationSeconds: 640 }],
      logs: {
        "index-maintenance": [
          log("index-maintenance", -22_340, "INFO", "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_idx;"),
          log("index-maintenance", -22_330, "INFO", "CREATE INDEX CONCURRENTLY orders_customer_id_status_idx ON orders (customer_id, status);"),
        ],
      },
      events: [
        {
          t: -21_701,
          type: "Warning",
          reason: "Evicted",
          object: "pod/index-maintenance-x7k2p",
          message: "The node was low on resource: memory. Threshold quantity: 100Mi, available: 91244Ki.",
        },
      ],
    }),
  isRootCauseFixed: isIndexValid,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — orders-api p99 > 1s and 5xx > 5% for 5m. Assigned to you." },
    { at: 45, from: "Greta Lindqvist · DBA", text: "Runbook DB-07, step 3: REINDEX INDEX orders_customer_id_status_idx. Takes twenty seconds." },
    { at: 125, from: "Aiko Brandt · Support", text: "Customers get “something went wrong” on Place order. Some got through on a retry." },
    { at: 220, from: "Ravi Menon · Director of Engineering", text: "Every order goes through orders-api. Don’t take it down to fix it." },
  ],
  hints: [
    "Find out what the slow sessions are running and how the planner runs it.",
    "The maintenance job never finished. What did it leave on orders?",
    "Twenty seconds is fast because it locks the table. Checkout writes to that table every second.",
  ],
  suggestions: {
    infrastructure: [STATE_BY_STATE, 'psql -c "\\d orders"', "kubectl get events", "kubectl get jobs", 'psql -c "select indexname, indisvalid from pg_indexes"'],
  },
  solution: {
    infrastructure: [
      { command: STATE_BY_STATE, why: "Mostly active sessions: slow queries, not leaked connections." },
      { command: "psql -c \"explain select count(*) from orders where customer_id = $1 and status = 'pending'\"", why: "Seq Scan on orders for the duplicate-order check." },
      { command: "kubectl get events", why: "index-maintenance’s pod was evicted overnight when its node ran low on memory." },
      { command: "kubectl logs job/index-maintenance", why: "It dropped the old index, then died during CREATE INDEX CONCURRENTLY." },
      { command: 'psql -c "\\d orders"', why: "orders_customer_id_status_idx is INVALID." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_customer_id_status_idx"', why: "Rebuild without blocking writes. The runbook’s plain REINDEX would lock orders for the whole rebuild." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch it finish, then declare." },
    ],
  },
  postmortem: {
    question: "Why not run the runbook’s REINDEX as written?",
    options: [
      "Plain REINDEX can’t rebuild an index that is INVALID",
      "It blocks writes to orders until it finishes",
      "It needs superuser, which the on-call role lacks",
      "It rebuilds every index on the table, not just one",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The node drain evicted the index-maintenance job mid-CREATE INDEX CONCURRENTLY after it had already dropped the old index, leaving orders_customer_id_status_idx INVALID.",
      why: "Without a valid index the duplicate-order check seq-scanned orders and held each connection longer as the cache cooled. A plain REINDEX is quicker but takes a lock that blocks every INSERT and UPDATE on orders until it finishes, so every order fails for those seconds. REINDEX CONCURRENTLY takes longer and keeps orders writable.",
      tell: "\\d orders marked the index INVALID, EXPLAIN showed a Seq Scan, and the events showed the job’s pod Evicted for memory pressure.",
    },
  },
  lostCheckoutsPerPoint: 450,
};

const deadlockedIndexScaleDown: Scenario = {
  id: "infra-t3-deadlocked-index-scale-down",
  tier: 3,
  title: "Order status lookups pile up on orders-db",
  severity: "SEV2",
  service: "order-status-api",
  briefing:
    "order-status-api, which checkout polls after payment, is timing out, and orders-db CPU is near 100%. Migration 0187 ran at 10:02. You have kubectl on the prod bastion and a psql role on orders-db.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "The DBA wants fewer connections. Fewer connections won’t make a slow query fast." },
  opensAtSecondOfDay: 10 * HOUR + 36 * MINUTE,
  seed: "infra-t3-deadlocked-index-scale-down",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-deadlocked-index-scale-down",
      deployment: "order-status-api",
      database: "orders-db",
      hotIndex: {
        name: "orders_status_customer_idx",
        definition: "btree (status, customer_id) INCLUDE (total_minor)",
        query: "SELECT id, total_minor FROM orders WHERE status = 'pending' AND customer_id = $1",
        isValid: false,
        cacheEviction: 0.1,
        rebuild: null,
      },
      revisions: [
        { number: 15, tag: "v2.2.0", changeCause: "v2.2.0 poll order status every 2 s after payment", traits: [] },
        { number: 16, tag: "v2.3.0", changeCause: "v2.3.0 order status with totals (migration 0187: covering index)", traits: [] },
      ],
      revision: 16,
      podsStartedAgo: 2_100,
      jobs: [{ name: "migrate-0187", status: "Complete", finishedAt: -2_030, durationSeconds: 96 }],
      logs: {
        "migrate-0187": [
          log("migrate-0187", -2_126, "INFO", "CREATE INDEX CONCURRENTLY orders_status_customer_idx ON orders (status, customer_id) INCLUDE (total_minor);"),
          log("migrate-0187", -2_031, "WARN", "ERROR:  deadlock detected"),
          log("migrate-0187", -2_031, "WARN", "DETAIL:  Process 48121 waits for ShareLock on virtual transaction 7/183342; blocked by process 48344."),
          log("migrate-0187", -2_031, "INFO", "DROP INDEX CONCURRENTLY IF EXISTS orders_status_idx;"),
          log("migrate-0187", -2_030, "INFO", "migration 0187 applied (2 statements, 1 warning)"),
        ],
      },
    }),
  isRootCauseFixed: isIndexValid,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — order-status-api 5xx > 5% for 5m. Assigned to you." },
    { at: 35, from: "Greta Lindqvist · DBA", text: "orders-db CPU at 96%. Please scale order-status-api down to 2, it’s hammering the database." },
    { at: 120, from: "Aiko Brandt · Support", text: "Customers paid but the confirmation page spins. Some paid twice to be sure." },
    { at: 230, from: "Ravi Menon · Director of Engineering", text: "Double payments are the worst outcome here. Make the confirmation page work." },
  ],
  hints: [
    "The database is busy because each query is slow, not because there are many of them.",
    "The migration says it applied with a warning. Read the warning.",
    "Fewer pods carry the same polling with fewer connections.",
  ],
  suggestions: {
    infrastructure: [STATE_BY_STATE, 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', "kubectl get jobs", 'psql -c "\\d orders"', "kubectl get pods"],
  },
  solution: {
    infrastructure: [
      { command: 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', why: "The status lookup takes hundreds of milliseconds and rising." },
      { command: "kubectl logs job/migrate-0187", why: "CREATE INDEX CONCURRENTLY hit a deadlock, and the migration still dropped the old index." },
      { command: 'psql -c "select indexname, indisvalid from pg_indexes"', why: "orders_status_customer_idx has indisvalid = f." },
      { command: 'psql -c "REINDEX INDEX CONCURRENTLY orders_status_customer_idx"', why: "Rebuild the index without blocking writes. Scaling down would leave each pod’s pool shorter against the same slow query." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch it finish, then declare." },
    ],
  },
  postmortem: {
    question: "What was the root cause?",
    options: [
      "order-status-api opened too many connections to orders-db",
      "Migration 0187 left its index INVALID after a deadlock",
      "Two-second polling overloaded orders-db with lookups",
      "The INCLUDE column made the new index too large for memory",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Migration 0187’s CREATE INDEX CONCURRENTLY failed with “deadlock detected”, leaving orders_status_customer_idx INVALID, and the migration dropped the old index anyway.",
      why: "Every status poll seq-scanned orders. The CPU was the scans, not the connection count: two pods would have run the same slow query with less pool between them and shed traffic besides. REINDEX CONCURRENTLY rebuilt the index without locking writes.",
      tell: "pg_stat_statements put the status lookup at the top with a climbing mean, indisvalid was false, and the migration log carried the deadlock as a warning before the DROP.",
    },
  },
  lostCheckoutsPerPoint: 400,
};

// ── 12 · killing the backends under a live pool ─────────────────────────────────────────

const giftcardTerminateBackends: Scenario = {
  id: "infra-t3-giftcard-terminate-backends",
  tier: 3,
  title: "Gift card checkout hangs",
  severity: "SEV2",
  service: "giftcard-api",
  briefing:
    "Paying with a gift card hangs and fails since v2.8.0. The DBA sees dozens of idle sessions from giftcard-api on giftcard-db and wants them gone. You have kubectl on the prod bastion and a psql role that can terminate backends.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "Those idle sessions are a symptom. Killing them from the database side hits the healthy pools too." },
  opensAtSecondOfDay: 15 * HOUR + 52 * MINUTE,
  seed: "infra-t3-giftcard-terminate-backends",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-giftcard-terminate-backends",
      deployment: "giftcard-api",
      database: "giftcard-db",
      revisions: [
        { number: 70, tag: "v2.7.5", changeCause: "v2.7.5 show the remaining balance on the receipt", traits: [] },
        { number: 71, tag: "v2.8.0", changeCause: "v2.8.0 split a payment across gift card and card", traits: [leak("giftcard-processor", 0.06, 100)] },
      ],
      revision: 71,
      leaked: [20, 14, 9],
    }),
  isRootCauseFixed: isOnCleanBuild,
  objectives: (state) => [{ role: "infrastructure", label: "Leave giftcard-db’s sessions alone", isMet: state.sessionsTerminated === 0 }],
  externals: [{ id: "giftcard-processor", status: "degraded", facts: [{ key: "p99", value: "2.9 s (normal: 120 ms)" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — giftcard-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Greta Lindqvist · DBA", text: "pg_stat_activity is full of idle giftcard-api sessions. Terminate them and the pool will reconnect." },
    { at: 130, from: "Aiko Brandt · Support", text: "Gift card plus card is failing. Gift card on its own seems fine." },
    { at: 240, from: "Ravi Menon · Director of Engineering", text: "Gift card season starts next week. I want this understood, not just restarted." },
  ],
  hints: [
    "To Postgres those sessions look idle. To the app they are still checked out.",
    "Ending a session in the database doesn’t return it to the pool that borrowed it.",
    "Something in the newest build borrows a connection and never gives it back.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/giftcard-api", STATE_BY_STATE, 'psql -c "select pid, application_name, state, query from pg_stat_activity"'] },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/giftcard-api", why: "giftcard-processor timeouts, then Hikari with all 20 active and none idle." },
      { command: 'psql -c "select pid, application_name, state, query from pg_stat_activity"', why: "Idle for minutes, last query a lookup: borrowed by the app and never returned." },
      { command: "kubectl rollout history deployment/giftcard-api", why: "v2.8.0 added split gift card payments." },
      { command: "kubectl rollout undo deployment/giftcard-api", why: "Back to v2.7.5. Terminating backends would only break the healthy pools’ idle connections." },
      { command: "kubectl rollout status deployment/giftcard-api", why: "Wait for v2.7.5 on every pod, then declare." },
    ],
  },
  postmortem: {
    question: "Why doesn’t pg_terminate_backend clear the leak?",
    options: [
      "The on-call role isn’t allowed to terminate those sessions",
      "Hikari still counts the dead connections as borrowed",
      "Postgres refuses to terminate sessions inside a transaction",
      "The sessions reconnect within a second and leak again",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v2.8.0’s split payment path borrowed a pooled connection and never closed it when a giftcard-processor call timed out.",
      why: "The leaked connections sit idle in Postgres, but inside the app Hikari still counts them as borrowed, so the pool stays empty whatever the database does. Terminating every idle backend also kills the healthy pods’ idle pool connections, so their next queries fail with “terminating connection due to administrator command”. Rolling back removes the leak.",
      tell: "pg_stat_activity listed the sessions as idle for minutes while Hikari reported active=20, idle=0, and only the split gift card path failed.",
    },
  },
  lostCheckoutsPerPoint: 250,
};

// ── 13 · the restart that buys ten minutes and a reopen ─────────────────────────────────

const preorderRestartReopens: Scenario = {
  id: "infra-t3-preorder-restart-reopens",
  tier: 3,
  title: "Pre-order deposits fail at launch",
  severity: "SEV1",
  service: "preorder-api",
  briefing:
    "The console pre-order opened at 20:00 and deposit charges are failing. preorder-api went to v1.10.0 this afternoon. You have kubectl on the prod bastion and a psql role on preorders-db. The launch is being streamed; whatever you do has to hold.",
  roles: ["infrastructure"],
  roleBriefings: { infrastructure: "A restart will make the graph look great for a few minutes. Make sure it stays that way." },
  opensAtSecondOfDay: 20 * HOUR + 9 * MINUTE,
  seed: "infra-t3-preorder-restart-reopens",
  initialState: () =>
    serviceCluster({
      seed: "infra-t3-preorder-restart-reopens",
      deployment: "preorder-api",
      database: "preorders-db",
      revisions: [
        { number: 18, tag: "v1.9.2", changeCause: "v1.9.2 waitlist emails", traits: [] },
        { number: 19, tag: "v1.10.0", changeCause: "v1.10.0 charge the deposit when the slot is reserved", traits: [leak("payment-gateway", 0.1, 100)] },
      ],
      revision: 19,
      leaked: [20, 15, 11],
      podsStartedAgo: 1_000,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [{ id: "payment-gateway", status: "degraded", facts: [{ key: "Launch traffic", value: "Elevated latency, p99 2.8 s" }, { key: "Calls timing out", value: "≈4%" }] }],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — preorder-api 5xx > 5% for 2m. Assigned to you." },
    { at: 30, from: "Marta Kowal · Launch manager", text: "We’re live on stream! Restart it, that fixed staging this afternoon." },
    { at: 100, from: "Aiko Brandt · Support", text: "People say the deposit failed but their slot is gone." },
    { at: 200, from: "Ravi Menon · Director of Engineering", text: "If this reopens on stream it’s worse than staying down. Fix it once." },
  ],
  hints: [
    "Staging recovered after a restart. How long did it stay recovered?",
    "Count how fast a fresh pod’s pool fills on this build.",
    "The leak arrived with this afternoon’s deposit change.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/preorder-api", STATE_BY_STATE, "curl -s http://preorder-api:8080/actuator/metrics/hikaricp.connections.active"] },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/preorder-api", why: "Deposit charges time out at the gateway, and then the pool is empty." },
      { command: "curl -s http://preorder-api:8080/actuator/metrics/hikaricp.connections.active", why: "Pools sit at or near 20 active with launch traffic flat." },
      { command: STATE_BY_STATE, why: "Postgres calls those sessions idle: a leak, so a restart only resets the count." },
      { command: "kubectl rollout history deployment/preorder-api", why: "v1.10.0 started charging deposits at reservation time." },
      { command: "kubectl rollout undo deployment/preorder-api", why: "Back to v1.9.2. A restart would drain again within minutes, mid-stream." },
      { command: "kubectl rollout status deployment/preorder-api", why: "Wait for v1.9.2 on every pod, then declare." },
    ],
  },
  postmortem: {
    question: "Why did a restart only buy a few minutes?",
    options: [
      "Launch traffic kept growing past what three pods could carry",
      "v1.10.0 still leaked a connection per gateway timeout",
      "The restart left the old pods holding their sessions",
      "Hikari’s pool warm-up held connections it didn’t need",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v1.10.0 charged the deposit inside the reservation and leaked the pooled connection whenever a payment-gateway call timed out.",
      why: "At launch traffic with the gateway slow, each pod stranded a connection every ten seconds or so, so a fresh pool of 20 was gone in a few minutes. A restart reset the count and reopened the incident on stream; rolling back removed the leak.",
      tell: "Hikari’s active count climbed steadily on flat traffic while Postgres showed those sessions idle, and pools refilled from zero after a restart at the same pace.",
    },
  },
  lostCheckoutsPerPoint: 500,
};

/** Tier-3 infrastructure War Rooms: each has a plausible first move that makes it worse. */
export const INFRA_TIER3_INCIDENTS: readonly Scenario[] = [
  hotfixKeepsLeaking,
  xmxBumpOom,
  metaspaceOverLeak,
  undoIntoCrash,
  surgeBlockedFourPods,
  walletRestartStalls,
  bnplFiveSmallPools,
  loyaltyScaleOut,
  failoverInvalidIndex,
  runbookPlainReindex,
  deadlockedIndexScaleDown,
  giftcardTerminateBackends,
  preorderRestartReopens,
  subscriptionsSixPods,
];
