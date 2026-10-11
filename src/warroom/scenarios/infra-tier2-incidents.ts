import { seededRandom } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import {
  templateHash,
  type ClusterEvent,
  type ClusterState,
  type CrashWhileServing,
  type Deployment,
  type HotIndex,
  type Job,
  type LogEntry,
  type Pod,
  type Revision,
  type Trait,
} from "../sim/model.ts";
import { CHECKOUT, isOnCleanBuild } from "./checkout-cluster.ts";

/**
 * Tier 2 infrastructure War Rooms: one cause hiding among plausible suspects. Each opens on the
 * checkout-api cluster with a neighbour, an external or a recent change that looks guilty and isn't.
 */

const POOL_SIZE = 20;
const POD_CAPACITY_RPS = 130;
const MAX_CONNECTIONS = 100;
const RESERVED_CONNECTIONS = 3;
const WARM_UP_SECONDS = 30;
const MINUTE = 60;

type Neighbour = {
  readonly name: string;
  readonly replicas: number;
  readonly poolSize: number;
  readonly revisions: readonly Revision[];
  readonly revision: number;
  readonly startedAgo?: number;
};

type ClusterSetup = {
  readonly seed: string;
  readonly revisions: readonly Revision[];
  readonly revision: number;
  readonly replicas?: number;
  /** checkout-api pods already up when the warm-up starts; defaults to `replicas`. */
  readonly runningPods?: number;
  readonly podsStartedAgo?: number;
  /** Connections each running checkout pod has already stranded. */
  readonly leaked?: readonly number[];
  /** checkout-api pods, after the running ones, already crash-looping when the warm-up starts. */
  readonly crashLooping?: number;
  readonly requestsPerSecond?: number;
  /** Other deployments on orders-db: they hold pooled connections but take no customer traffic. */
  readonly neighbours?: readonly Neighbour[];
  readonly hotIndex?: HotIndex;
  readonly logs?: Readonly<Record<string, readonly LogEntry[]>>;
  readonly events?: readonly ClusterEvent[];
  readonly jobs?: readonly Job[];
};

function podsOf(name: string, revision: number, running: number, startedAgo: number, leaked: readonly number[], crashLooping: number): Pod[] {
  const hash = templateHash(name, revision, 0);
  return Array.from({ length: running + crashLooping }, (_, index): Pod => {
    const isCrashLooping = index >= running;
    return {
      name: podName(name, hash, index + 1),
      templateHash: hash,
      revision,
      phase: isCrashLooping ? "CrashLoopBackOff" : "Running",
      startedAt: -startedAgo - index * 35,
      phaseLeft: isCrashLooping ? 4 + index * 3 : 0,
      leaked: isCrashLooping ? 0 : (leaked[index] ?? 0),
      restarts: isCrashLooping ? 1 : 0,
      connectionHistory: [],
      ...(isCrashLooping ? { lastTermination: { reason: "Error", exitCode: 1 } as const } : {}),
    };
  });
}

/** checkout-api (three pods, pools of 20, 130 rps each) plus any neighbours on orders-db, run up to the page. */
function buildCluster(setup: ClusterSetup): ClusterState {
  const replicas = setup.replicas ?? 3;
  const front: Deployment = {
    name: CHECKOUT,
    replicas,
    poolSize: POOL_SIZE,
    podCapacityRps: POD_CAPACITY_RPS,
    revision: setup.revision,
    generation: 0,
    revisions: setup.revisions,
    pods: podsOf(CHECKOUT, setup.revision, setup.runningPods ?? replicas, setup.podsStartedAgo ?? 1_200, setup.leaked ?? [], setup.crashLooping ?? 0),
  };
  const neighbours = (setup.neighbours ?? []).map(
    (neighbour): Deployment => ({
      name: neighbour.name,
      replicas: neighbour.replicas,
      poolSize: neighbour.poolSize,
      revision: neighbour.revision,
      generation: 0,
      revisions: neighbour.revisions,
      pods: podsOf(neighbour.name, neighbour.revision, neighbour.replicas, neighbour.startedAgo ?? 3_000, [], 0),
    }),
  );
  const deployments = [front, ...neighbours];
  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments,
    database: {
      name: "orders-db",
      host: "orders-db.internal",
      maxConnections: MAX_CONNECTIONS,
      reservedConnections: RESERVED_CONNECTIONS,
      ...(setup.hotIndex ? { hotIndex: setup.hotIndex } : {}),
    },
    traffic: { requestsPerSecond: setup.requestsPerSecond ?? 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 },
    logs: setup.logs ?? {},
    events: setup.events ?? [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: deployments.reduce((sum, deployment) => sum + deployment.pods.length, 0),
    ...(setup.jobs ? { jobs: setup.jobs } : {}),
  };
  const random = seededRandom(`${setup.seed}:warm-up`);
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

function revision(number: number, tag: string, change: string, traits: readonly Trait[] = []): Revision {
  return { number, tag, changeCause: `${tag} ${change}`, traits };
}

function crash(trait: Omit<CrashWhileServing, "kind">): CrashWhileServing {
  return { kind: "crashes-while-serving", ...trait };
}

function replicasOf(state: ClusterState, name: string): number {
  return state.deployments.find((deployment) => deployment.name === name)?.replicas ?? 0;
}

/** True when every deployment's pools, at its desired replicas, fit under orders-db's max_connections. */
function fitsConnectionBudget(state: ClusterState): boolean {
  const wanted = state.deployments.reduce((sum, deployment) => sum + deployment.replicas * deployment.poolSize, 0);
  return wanted <= state.database.maxConnections - state.database.reservedConnections;
}

/** A neighbour hogging orders-db is fixed once checkout runs its three pods and everyone's pools fit. */
function isConnectionBudgetRestored(state: ClusterState): boolean {
  return replicasOf(state, CHECKOUT) >= 3 && fitsConnectionBudget(state);
}

function scaledEvent(t: number, name: string, revisionNumber: number, to: number, from: number): ClusterEvent {
  const direction = to > from ? "up" : "down";
  return {
    t,
    type: "Normal",
    reason: "ScalingReplicaSet",
    object: `deployment/${name}`,
    message: `Scaled ${direction} replica set ${name}-${templateHash(name, revisionNumber, 0)} to ${to} from ${from}`,
  };
}

const PAGER = "PagerDuty";
const SUPPORT = "Maya Okonkwo · Support";
const MANAGER = "Sam Tan · Eng manager";
const VP = "Elena Ruiz · VP Engineering";

// ── A bad checkout build, with an innocent neighbour deployed the same hour ─────────────────────

const heapExhaustion: Scenario = {
  id: "infra-t2-heap-exit-on-oome",
  tier: 2,
  title: "Checkout pods exit with code 3",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api pods keep exiting and coming back. Two things shipped in the last hour: checkout-api v4.16.0 and promo-engine v2.8.0. Marketing is sure it's the promo change. You have kubectl on the prod bastion; find which one, and undo only that.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Two deploys, one outage. The pods tell you how they died; the deploy history tells you what changed in each.",
  },
  opensAtSecondOfDay: 15 * 3600 + 8 * MINUTE,
  seed: "infra-t2-heap-exit-on-oome",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-heap-exit-on-oome",
      revisions: [
        revision(11, "v4.15.2", "pin jackson-databind 2.17.2"),
        revision(12, "v4.16.0", "render PDF receipts inline on POST /checkout", [
          crash({
            termination: { reason: "Error", exitCode: 3 },
            afterSeconds: 60,
            jitterSeconds: 55,
            lastWords: "Terminating due to java.lang.OutOfMemoryError: Java heap space",
            failsCheckouts: false,
          }),
        ]),
      ],
      revision: 12,
      podsStartedAgo: 25,
      neighbours: [
        {
          name: "promo-engine",
          replicas: 2,
          poolSize: 5,
          revisions: [revision(30, "v2.7.4", "cache campaign rules for 60s"), revision(31, "v2.8.0", "stackable autumn promo codes")],
          revision: 31,
          startedAgo: 2_400,
        },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 260,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% (flapping). Assigned to you." },
    { at: 45, from: "Lena Ortiz · Growth", text: "promo-engine v2.8.0 went out at 14:20 for the autumn codes. If it's that, roll it back, but the campaign is live." },
    { at: 110, from: SUPPORT, text: "Customers with big baskets fail more often. Small orders mostly go through." },
    { at: 200, from: MANAGER, text: "checkout-api v4.16.0 shipped at 14:35 with the PDF receipts. Any link?" },
    { at: 300, from: VP, text: "Which of the two is it? I don't want both rolled back on a guess." },
  ],
  hints: [
    "Two deploys landed close together. Only one of the two deployments is actually falling over.",
    "Exit code 3 isn't the kernel's doing. Read the very last line the process printed.",
    "The heap ran out inside the app that crashes, so look at what its newest build started holding in memory.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl rollout history deployment/promo-engine"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Only checkout-api pods restart; promo-engine's two pods have been up for forty minutes without a restart." },
      { command: "kubectl describe pods", why: "checkout-api's Last State is Terminated, Reason: Error, Exit Code 3: the JVM stopped itself, not the kernel's OOM killer." },
      { command: "kubectl logs deployment/checkout-api", why: "The last line is Terminating due to java.lang.OutOfMemoryError: Java heap space, so the heap filled up inside checkout-api." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.16.0 started rendering PDF receipts inside the checkout request. That's what fills the heap." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Roll back checkout-api only. promo-engine isn't crashing, so the campaign stays live." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for the old build on every pod, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did checkout-api pods keep exiting?",
    options: [
      "promo-engine v2.8.0 returned stacked discounts that checkout couldn't parse, so it crashed",
      "v4.16.0 built PDF receipts on the heap during checkout until the JVM ran out of heap",
      "The kernel OOM-killed the pods at their 1Gi container memory limit",
      "orders-db dropped connections and the pods exited on the error",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.16.0 rendered a PDF receipt for each order on the request thread and kept the bytes on the heap, so large baskets pushed the heap past its maximum.",
      why: "The JVM runs with -XX:+ExitOnOutOfMemoryError, so the first heap OutOfMemoryError makes it exit with code 3 and Kubernetes restarts the pod. Pods died one after another and checkout failed in bursts. promo-engine shipped the same hour but never restarted, so rolling it back would have ended the campaign and fixed nothing.",
      tell: "Only checkout-api pods restarted, with Exit Code 3 (not 137 OOMKilled), and their last line was Terminating due to java.lang.OutOfMemoryError: Java heap space.",
    },
  },
};

const nativeThreads: Scenario = {
  id: "infra-t2-native-thread-exhaustion",
  tier: 2,
  title: "Checkout runs out of threads",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api restarts every couple of minutes. notifications-api moved to a new broker this morning and order emails are delayed, so the notifications team is in the channel apologising already. You have kubectl. Prove whose fault it is before anyone rolls back.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "A noisy neighbour is apologising. Check whether its pods are the ones dying before you believe it.",
  },
  opensAtSecondOfDay: 9 * 3600 + 47 * MINUTE,
  seed: "infra-t2-native-thread-exhaustion",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-native-thread-exhaustion",
      revisions: [
        revision(14, "v4.16.1", "retry order webhooks with jitter"),
        revision(15, "v4.16.2", "fan out order webhooks on a per-order executor", [
          crash({
            termination: { reason: "Error", exitCode: 3 },
            afterSeconds: 85,
            jitterSeconds: 60,
            lastWords:
              "Terminating due to java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached",
            failsCheckouts: false,
          }),
        ]),
      ],
      revision: 15,
      podsStartedAgo: 70,
      neighbours: [
        {
          name: "notifications-api",
          replicas: 2,
          poolSize: 4,
          revisions: [revision(52, "v3.0.9", "template fixes"), revision(53, "v3.1.0", "publish order emails via the new broker")],
          revision: 53,
          startedAgo: 4_800,
        },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 220,
  externals: [
    {
      id: "email-broker",
      status: "degraded",
      facts: [
        { key: "Queue lag", value: "11 min (normal: < 30 s)" },
        { key: "Owner", value: "team-notifications" },
      ],
    },
  ],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 30, from: "Theo Lindqvist · Notifications", text: "Sorry all, our broker migration is lagging. Order emails are behind. Could that be breaking checkout?" },
    { at: 120, from: SUPPORT, text: "Payment fails, works on retry. And no confirmation emails either, which isn't helping." },
    { at: 210, from: MANAGER, text: "Theo is offering to roll back notifications-api. Should he?" },
    { at: 320, from: VP, text: "Checkout first, emails second. What's the call?" },
  ],
  hints: [
    "Late emails and failed payments may not share a cause. See which pods actually restart.",
    "The process said what it couldn't get more of on its way out, and it wasn't heap.",
    "Something in the newest checkout build creates threads per order and never stops them.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get events", "kubectl rollout history deployment/notifications-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "checkout-api restarts; notifications-api's pods have run for over an hour with no restarts." },
      { command: "kubectl logs deployment/checkout-api", why: "It dies on OutOfMemoryError: unable to create native thread. The JVM hit the process thread limit, not the heap." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.16.2 moved webhook fan-out onto a new executor for every order. Nothing shuts those executors down." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Rolling back removes the executor leak. Rolling back notifications-api wouldn't change checkout at all." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for every pod to run v4.16.1, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What made checkout-api restart?",
    options: [
      "The notifications broker migration backed up and blocked checkout",
      "v4.16.2 created a thread pool per order and never shut it down",
      "The pods hit their 1Gi memory limit and were OOMKilled",
      "Too many requests per pod exhausted Tomcat's worker threads during the morning peak",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.16.2 created a new executor for every order's webhooks and never shut it down, so its threads piled up until the process couldn't start another.",
      why: "Every live thread holds a native stack outside the heap. Once the pod reached its process limit, pthread_create failed and the JVM, running with ExitOnOutOfMemoryError, exited with code 3. The notifications broker lag was real but separate: notifications-api never restarted, and checkout publishes emails asynchronously.",
      tell: "Only checkout-api restarted, and its last line was OutOfMemoryError: unable to create native thread, which means it ran out of threads, not heap.",
    },
  },
};

const nativeMemory: Scenario = {
  id: "infra-t2-grpc-native-memory",
  tier: 2,
  title: "Checkout OOMKilled with a quiet heap",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api pods are being OOMKilled, yet its heap dashboard is flat at 40%. inventory-api shipped v5.0.0 an hour ago and checkout now calls it over gRPC. You have kubectl. Decide which deployment to roll back.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "The heap graph says fine and the kernel says otherwise. Work out where the memory is and whose build put it there.",
  },
  opensAtSecondOfDay: 16 * 3600 + 51 * MINUTE,
  seed: "infra-t2-grpc-native-memory",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-grpc-native-memory",
      revisions: [
        revision(17, "v4.17.3", "stock check over REST"),
        revision(18, "v4.18.0", "stock check over gRPC with a channel per request", [
          crash({
            termination: { reason: "OOMKilled", exitCode: 137 },
            afterSeconds: 75,
            jitterSeconds: 45,
            lastWords: "MemoryWatchdog rss=1011Mi limit=1024Mi heap.used=402Mi netty.directMemory=446Mi grpc.channels.open=1873",
            failsCheckouts: false,
          }),
        ]),
      ],
      revision: 18,
      podsStartedAgo: 40,
      neighbours: [
        {
          name: "inventory-api",
          replicas: 2,
          poolSize: 6,
          revisions: [revision(8, "v4.9.1", "REST stock endpoint"), revision(9, "v5.0.0", "gRPC StockService alongside REST")],
          revision: 9,
          startedAgo: 3_700,
        },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 240,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% (flapping). Assigned to you." },
    { at: 50, from: "Ines Duarte · Inventory", text: "inventory-api v5.0.0 is the gRPC server checkout talks to now. Happy to roll it back if you think it's us." },
    { at: 140, from: MANAGER, text: "Heap is at 40% on every checkout pod. How can it be out of memory?" },
    { at: 230, from: SUPPORT, text: "Checkout fails a few times an hour per customer. They're getting annoyed." },
    { at: 330, from: VP, text: "Pick one and roll it back. Which?" },
  ],
  hints: [
    "The memory limit applies to the whole container, not just the heap.",
    "Compare the dying pods' last line with what the heap graph shows. Something else is eating the rest.",
    "The server answering the calls isn't the one using up the memory.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl top pods", "kubectl rollout history deployment/inventory-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl describe pods", why: "checkout-api's last state is OOMKilled with Exit Code 137: the kernel killed it at the 1Gi container limit. inventory-api's pods never restarted." },
      { command: "kubectl logs deployment/checkout-api", why: "RSS is at the limit with the heap at about 400Mi. The other ~450Mi is Netty direct memory from almost 1,900 open gRPC channels." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.18.0 opens a new gRPC channel for every stock check and never closes it." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Rolling back the client fixes the leak. inventory-api's server only answers the calls." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait until every pod runs v4.17.3, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Where did checkout-api's memory go?",
    options: [
      "The Java heap filled up with stock responses from inventory-api",
      "Open gRPC channels' direct buffers, outside the heap",
      "inventory-api v5.0.0 sent oversized replies that overflowed checkout's request buffers",
      "orders-db result sets cached by Hikari across requests",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.18.0 built a new gRPC channel for each stock check and never shut it down. Each channel kept Netty direct buffers outside the Java heap.",
      why: "The container limit counts all of the process's memory. With the heap steady at ~400Mi, the native buffers grew until RSS reached 1Gi and the kernel OOM-killed the pod (exit 137). inventory-api only served the calls; rolling it back would have broken stock checks and left the leak in place.",
      tell: "The pods were OOMKilled (137) while the heap sat at 40%, and the watchdog line showed netty.directMemory and grpc.channels.open climbing.",
    },
  },
};

const tenderRecursion: Scenario = {
  id: "infra-t2-split-tender-recursion",
  tier: 2,
  title: "Gift-card checkouts crash the pods",
  severity: "SEV1",
  service: CHECKOUT,
  briefing:
    "Most checkouts are failing and checkout-api is crash-looping. gift-card-api and checkout-api both deployed split-tender support this morning, the API first and checkout after. You have kubectl. Find which build is crashing and roll back that one.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Both halves of one feature shipped today. Only one of them is falling over; logs and restart counts will show you which.",
  },
  opensAtSecondOfDay: 11 * 3600 + 12 * MINUTE,
  seed: "infra-t2-split-tender-recursion",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-split-tender-recursion",
      revisions: [
        revision(20, "v4.18.4", "gift card balance in the order summary"),
        revision(21, "v4.19.0", "split tender: gift card + card in one checkout", [
          crash({
            termination: { reason: "Error", exitCode: 1 },
            afterSeconds: 4,
            jitterSeconds: 6,
            lastWords: 'Exception in thread "http-nio-8080-exec-7" java.lang.StackOverflowError',
            failsCheckouts: true,
          }),
        ]),
      ],
      revision: 21,
      podsStartedAgo: 30,
      neighbours: [
        {
          name: "gift-card-api",
          replicas: 2,
          poolSize: 5,
          revisions: [revision(40, "v1.11.0", "balance lookups by card hash"), revision(41, "v1.12.0", "partial redemption endpoint for split tender")],
          revision: 41,
          startedAgo: 5_400,
        },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 450,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV1 triggered — checkout-api 5xx > 50% for 3m. Assigned to you." },
    { at: 35, from: "Ravi Menon · Payments", text: "gift-card-api v1.12.0 added partial redemptions at 09:40. Want me to pull it?" },
    { at: 90, from: SUPPORT, text: "It's not only gift-card customers. Plain card payments are failing too." },
    { at: 160, from: MANAGER, text: "checkout-api v4.19.0 shipped at 11:05. That's the other half of split tender." },
    { at: 250, from: VP, text: "SEV1. I need checkout back. Which rollback?" },
  ],
  hints: [
    "Plain card checkouts fail too, so think about where a crash could take out every request.",
    "Look at which pods restart, and at the last thing a crashing one says.",
    "An error from very deep recursion comes from the code that recurses, not the service it calls.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl logs deployment/checkout-api", "kubectl rollout history deployment/gift-card-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "checkout-api is in CrashLoopBackOff with climbing restarts. gift-card-api has run since 09:40 without a restart." },
      { command: "kubectl logs deployment/checkout-api", why: "Each crash ends with java.lang.StackOverflowError on a request thread: checkout's own code recursed until the stack ran out." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.19.0 added split tender at 11:05, and the crashes started then." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Roll back checkout-api. gift-card-api's new endpoint is harmless with no caller." },
      { command: "kubectl get pods", why: "Wait until the new pods are 1/1 Ready with no restarts, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What took checkout down?",
    options: [
      "gift-card-api v1.12.0 answered with a payload checkout couldn't handle",
      "v4.19.0's tender allocator recursed without end and overflowed the stack",
      "The pods ran out of heap allocating gift-card balances for every order",
      "A gift-card abuse spike flooded checkout with requests until the pods fell over",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.19.0's split-tender allocator and its rebalance step called each other for every order with no base case, so each checkout recursed until the thread's stack overflowed.",
      why: "Every checkout went through the allocator, gift card or not, so every pod crashed within seconds of taking traffic and Kubernetes kept restarting it. gift-card-api's new endpoint was only called after allocation, which never finished. Rolling it back would have changed nothing.",
      tell: "Only checkout-api crash-looped, plain card payments failed too, and its last line was a StackOverflowError on a Tomcat request thread.",
    },
  },
};

const livenessCoupling: Scenario = {
  id: "infra-t2-liveness-on-fraud-scorer",
  tier: 2,
  title: "Kubelet keeps killing checkout",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api pods keep getting restarted, and the fraud-scorer team has a latency incident of their own going. Everyone assumes fraud-scorer is to blame and that we should wait it out. You have kubectl. Work out why the kubelet is restarting healthy pods, and whether waiting is really the plan.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "A slow dependency is a fact of life. Whether a slow dependency should restart your pods is a choice someone made recently.",
  },
  opensAtSecondOfDay: 20 * 3600 + 26 * MINUTE,
  seed: "infra-t2-liveness-on-fraud-scorer",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-liveness-on-fraud-scorer",
      revisions: [
        revision(23, "v4.20.1", "fraud-scorer timeout 800ms with fallback"),
        revision(24, "v4.20.2", "add fraudScorer to the liveness health group", [
          crash({
            termination: { reason: "Error", exitCode: 143 },
            afterSeconds: 50,
            jitterSeconds: 40,
            lastWords: "Commencing graceful shutdown. Waiting for active requests to complete",
            failsCheckouts: false,
          }),
        ]),
      ],
      revision: 24,
      podsStartedAgo: 35,
      events: [
        {
          t: -40,
          type: "Warning",
          reason: "Unhealthy",
          object: `pod/${podName(CHECKOUT, templateHash(CHECKOUT, 24, 0), 1)}`,
          message: 'Liveness probe failed: Get "http://10.0.12.44:8080/actuator/health/liveness": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
        },
        {
          t: -38,
          type: "Normal",
          reason: "Killing",
          object: `pod/${podName(CHECKOUT, templateHash(CHECKOUT, 24, 0), 1)}`,
          message: "Container checkout-api failed liveness probe, will be restarted",
        },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 230,
  externals: [
    {
      id: "fraud-scorer",
      status: "degraded",
      facts: [
        { key: "p99", value: "1.4 s (normal: 90 ms)" },
        { key: "Owner's ETA", value: "Investigating, no ETA" },
        { key: "Checkout's client", value: "800 ms timeout, falls back to rules" },
      ],
    },
  ],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% (flapping). Assigned to you." },
    { at: 40, from: "Dana Whitfield · Risk", text: "fraud-scorer is slow, we're on it. Checkout has a fallback though, so it shouldn't be failing?" },
    { at: 130, from: MANAGER, text: "Can we just wait for fraud-scorer to recover?" },
    { at: 220, from: SUPPORT, text: "Customers get a spinner, then an error, then it works. Over and over." },
    { at: 330, from: VP, text: "fraud-scorer says hours, not minutes. We can't wait that long." },
  ],
  hints: [
    "Exit code 143 means the container was asked to stop. Find out who asked.",
    "The cluster's recent events say why the kubelet restarted the container.",
    "A liveness check should only ask whether the process is stuck. Look at when it started asking about something else.",
  ],
  suggestions: {
    infrastructure: ["kubectl describe pods", "kubectl get events", "curl -s http://checkout-api:8080/actuator/health"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: Error, Exit Code 143. That's SIGTERM, so something stopped the container; it didn't crash." },
      { command: "kubectl get events", why: "Liveness probe failed with a timeout, then Container checkout-api failed liveness probe, will be restarted." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.20.2 put the fraudScorer health indicator in the liveness group, so a slow fraud-scorer fails liveness." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "v4.20.1 keeps fraud-scorer out of liveness and falls back to rules when it's slow. Waiting for fraud-scorer could take hours." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait until every pod runs v4.20.1, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did the kubelet keep restarting checkout-api?",
    options: [
      "fraud-scorer's latency made checkout requests time out and crash the pods",
      "v4.20.2 tied liveness to fraud-scorer, so its latency failed the probe",
      "The pods ran out of memory while waiting on slow fraud-scorer calls",
      "Node pressure on the fraud-scorer nodes evicted checkout pods that shared them",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.20.2 added the fraudScorer health indicator to the liveness group, so the liveness endpoint waited on fraud-scorer.",
      why: "When fraud-scorer slowed down, /actuator/health/liveness took longer than the probe's timeout. The kubelet sent SIGTERM to healthy pods (exit 143), Spring shut down gracefully, and the pods restarted one after another. Checkout itself was coping: it falls back to rules after 800 ms. Liveness should only cover the process itself; dependencies belong in readiness or nowhere.",
      tell: "Exit Code 143 rather than a crash, Unhealthy events for the liveness probe followed by 'failed liveness probe, will be restarted', and graceful-shutdown last lines.",
    },
  },
};

const nativeSegfault: Scenario = {
  id: "infra-t2-libvips-segfault",
  tier: 2,
  title: "Checkout dies with exit code 134",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api pods keep dying with exit code 134. The platform team patched every node's kernel overnight and has already offered to drain and roll back the nodes. You have kubectl. Find out whether the kernel or the app is crashing.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Overnight node patching is the obvious suspect. The JVM leaves a crash report naming the frame that crashed.",
  },
  opensAtSecondOfDay: 7 * 3600 + 34 * MINUTE,
  seed: "infra-t2-libvips-segfault",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-libvips-segfault",
      revisions: [
        revision(26, "v4.21.0", "QR code on receipts via zxing"),
        revision(27, "v4.21.1", "QR codes via libvips JNI binding", [
          crash({
            termination: { reason: "Error", exitCode: 134 },
            afterSeconds: 45,
            jitterSeconds: 50,
            lastWords: "#  SIGSEGV (0xb) at pc=0x00007f6e2c1d4a3b, pid=1, tid=112",
            failsCheckouts: false,
          }),
        ]),
      ],
      revision: 27,
      podsStartedAgo: 30,
      events: [
        { t: -6 * 3600, type: "Normal", reason: "NodeReady", object: "node/ip-10-0-12-44", message: "Node ip-10-0-12-44 status is now: NodeReady" },
        { t: -6 * 3600 + 400, type: "Normal", reason: "NodeReady", object: "node/ip-10-0-12-61", message: "Node ip-10-0-12-61 status is now: NodeReady" },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% (flapping). Assigned to you." },
    { at: 30, from: "Kofi Asante · Platform", text: "We rolled the 6.8 kernel to every node at 01:00. Want us to drain and roll back?" },
    { at: 120, from: MANAGER, text: "Nothing else on those nodes is restarting. Is it really the kernel?" },
    { at: 200, from: SUPPORT, text: "Morning shoppers are hitting errors at payment. Some are giving up." },
    { at: 310, from: VP, text: "Rolling back every node will take hours. Is there something faster?" },
  ],
  hints: [
    "If the kernel were broken, more than one workload would be dying on those nodes.",
    "Exit code 134 is an abort. The JVM prints a report before it aborts. Read the dying pod's last lines.",
    "Native code crashing inside the app arrived with an app build, not with the nodes.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get events", "kubectl describe pods"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: Error, Exit Code 134. The JVM aborted itself, nothing outside killed it." },
      { command: "kubectl logs deployment/checkout-api", why: "The last line is the JVM fatal error header, SIGSEGV (0xb) at pc=…: a native library crashed inside the process." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.21.1 swapped zxing for a libvips JNI binding. That's the native code that crashes, not the kernel." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "v4.21.0 makes QR codes in pure Java. Draining nodes would take hours and fix nothing." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait until every pod runs v4.21.0, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did checkout-api pods keep dying?",
    options: [
      "The overnight 6.8 kernel patch broke the JVM on every node",
      "v4.21.1's libvips JNI binding segfaulted inside the JVM",
      "The pods ran out of memory rendering QR codes and were OOMKilled",
      "A node drain during patching evicted pods faster than they could become ready",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.21.1 rendered receipt QR codes through a new libvips JNI binding that dereferenced freed memory under concurrent use.",
      why: "A segfault in native code takes the whole JVM down: it writes an hs_err report, aborts, and the container exits with 134 (128 + SIGABRT). Nothing else on the patched nodes restarted, and the crashes started with the 07:20 deploy, not at 01:00. Rolling back the app fixed it in a minute; rolling back the kernel would have taken hours and fixed nothing.",
      tell: "Exit Code 134 on checkout-api only, and a last line from the JVM fatal error report: SIGSEGV (0xb) at pc=…, pid=1.",
    },
  },
};

// ── A build that leaks pooled connections ───────────────────────────────────────────────────────

const leakWithTerminateDecoy: Scenario = {
  id: "infra-t2-adyen-proxy-leak",
  tier: 2,
  title: "orders-db looks full, checkout starves",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api requests wait 30 s for a database connection and fail. The DBA on call says orders-db is near max_connections and wants to kill the idle sessions. You have kubectl, psql and curl. Find out who is holding the connections before anyone kills anything.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Killing sessions in Postgres doesn't put connections back in the app's pool. Find out what's holding them.",
  },
  opensAtSecondOfDay: 12 * 3600 + 3 * MINUTE,
  seed: "infra-t2-adyen-proxy-leak",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-adyen-proxy-leak",
      revisions: [
        revision(29, "v4.21.4", "3DS2 challenge flow on web"),
        revision(30, "v4.22.0", "route EU cards through adyen-proxy", [
          { kind: "leaks-connection-on-dependency-timeout", dependency: "adyen-proxy", leaksPerSecondAtBaseline: 0.06, perPodBaselineRps: 100 },
        ]),
      ],
      revision: 30,
      podsStartedAgo: 2_700,
      leaked: [20, 12, 6],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 280,
  externals: [
    {
      id: "adyen-proxy",
      status: "degraded",
      facts: [
        { key: "p99 from checkout-api", value: "3.2 s (normal: 240 ms)" },
        { key: "Client timeout", value: "3000 ms × 3 attempts" },
      ],
    },
  ],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Olu Bakare · DBA", text: "orders-db is sitting near max_connections and most of them are idle. I can pg_terminate_backend the idle ones, say the word." },
    { at: 130, from: SUPPORT, text: "EU customers mostly, some US. The card form spins and then fails." },
    { at: 210, from: MANAGER, text: "Did terminating the idle sessions help? The graph didn't move." },
    { at: 320, from: VP, text: "This started after lunch. What changed at lunch?" },
  ],
  hints: [
    "Postgres calls them idle while the app calls them busy. Both are right.",
    "The connections drain in steps, and each step lines up with a slow call to an outside service.",
    "Killing a session on the database side doesn't take it back from the code that borrowed it.",
  ],
  suggestions: {
    infrastructure: ['psql -c "select state, count(*) from pg_stat_activity group by state"', "kubectl logs deployment/checkout-api", "curl -s http://checkout-api:8080/actuator/metrics/hikaricp.connections.active"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/checkout-api", why: "HikariPool-1 shows total=20, active=20, idle=0, alongside adyen-proxy timeouts on attempt 3/3." },
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Postgres sees those sessions as idle: the app borrowed them and never gave them back. It's a leak, not load." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.22.0 started routing EU cards through adyen-proxy, and the leak follows its timeouts." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "The rollback returns connections properly again. Killing idle sessions would leave the app's pool exactly as empty." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for fresh pods on v4.21.4, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Who was holding orders-db's connections?",
    options: [
      "A runaway analytics query opened hundreds of sessions on orders-db",
      "v4.22.0 kept a connection whenever adyen-proxy timed out",
      "max_connections was too low for lunchtime traffic",
      "Idle sessions that Postgres should have timed out on its own",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.22.0's new adyen-proxy path borrowed a pooled connection and lost it when the third timed-out attempt threw before the connection was returned.",
      why: "adyen-proxy was slow, so each pod stranded a connection every few seconds until all 20 in its pool were stuck. Postgres saw those sessions as idle because no query was running on them; Hikari saw them as checked out. pg_terminate_backend would close them on the server, but the app still counts them as in use and its pool stays empty. Rolling back removes the leak.",
      tell: "Hikari reported active=20 idle=0 while Postgres showed the same sessions as idle, and the drops in the pool lined up with adyen-proxy attempt 3/3 timeouts.",
    },
  },
};

const leakWithRestartDecoy: Scenario = {
  id: "infra-t2-wallet-pay-leak",
  tier: 2,
  title: "Checkout fails again an hour after every restart",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Overnight on-call restarted checkout-api twice when it started timing out, and both times it came back. It's timing out again. The runbook says restart. You have kubectl, psql and curl. Find out what the restarts keep resetting.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "A fix that has to be repeated every hour isn't a fix. Something in the pods fills up over time; find out what, and since when.",
  },
  opensAtSecondOfDay: 6 * 3600 + 18 * MINUTE,
  seed: "infra-t2-wallet-pay-leak",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-wallet-pay-leak",
      revisions: [
        revision(32, "v4.22.3", "Apple Pay merchant validation cache"),
        revision(33, "v4.23.0", "Google Pay tokens via wallet-pay-proxy", [
          { kind: "leaks-connection-on-dependency-timeout", dependency: "wallet-pay-proxy", leaksPerSecondAtBaseline: 0.05, perPodBaselineRps: 100 },
        ]),
      ],
      revision: 33,
      podsStartedAgo: 3_300,
      leaked: [20, 16, 9],
      events: [
        { t: -3_400, type: "Normal", reason: "ScalingReplicaSet", object: `deployment/${CHECKOUT}`, message: `Scaled up replica set ${CHECKOUT}-${templateHash(CHECKOUT, 33, 0)} to 3 from 2` },
      ],
    }),
  isRootCauseFixed: isOnCleanBuild,
  lostCheckoutsPerPoint: 300,
  externals: [
    {
      id: "wallet-pay-proxy",
      status: "degraded",
      facts: [
        { key: "Timeouts", value: "≈4% of token exchanges" },
        { key: "Client timeout", value: "3000 ms × 3 attempts" },
      ],
    },
  ],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 30, from: "Jun Park · Overnight on-call", text: "Third time tonight. Restart fixed it at 02:10 and 04:15. I'd just restart again." },
    { at: 120, from: SUPPORT, text: "Early shoppers can't pay. Google Pay customers seem worst." },
    { at: 220, from: MANAGER, text: "If a restart fixes it, why does it keep coming back?" },
    { at: 330, from: VP, text: "I don't want this to page again at 08:00." },
  ],
  hints: [
    "It builds up from zero after every restart. Watch what fills up.",
    "Compare what the app thinks its connections are doing with what the database thinks.",
    "The first failure was soon after a release that added a new outside call.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "curl -s http://checkout-api:8080/actuator/metrics/hikaricp.connections.active", "kubectl logs deployment/checkout-api"],
  },
  solution: {
    infrastructure: [
      { command: "curl -s http://checkout-api:8080/actuator/metrics/hikaricp.connections.active", why: "Active connections are at or near 20 with traffic flat. The pool is filling up." },
      { command: "kubectl logs deployment/checkout-api", why: "Each pool drop comes after a wallet-pay-proxy timeout on attempt 3/3." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.23.0 added the wallet-pay-proxy call last night, a few hours before the first page." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Rolling back removes the leak. Another restart would only start the hour-long countdown again." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for every pod to run v4.22.3, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did each restart only buy about an hour?",
    options: [
      "The restarts cleared a memory leak that came back as traffic rose",
      "v4.23.0 leaked a connection on every wallet-pay-proxy timeout",
      "orders-db's idle session timeout was too long",
      "The overnight traffic peak exceeded what three replicas can serve",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api v4.23.0 stranded a pooled connection every time a wallet-pay-proxy token exchange timed out three times.",
      why: "A restart gives each pod a fresh, empty pool, so checkout recovered and then leaked its way back to 20 stuck connections in about an hour. The restarts reset the counter; they didn't remove the code that leaks. Rolling back does.",
      tell: "The pool climbed back to active=20 after every restart with flat traffic, and each step lined up with a wallet-pay-proxy attempt 3/3 timeout.",
    },
  },
};

// ── Capacity: the replica count, not the build ──────────────────────────────────────────────────

const replicasFromManifest: Scenario = {
  id: "infra-t2-manifest-replicas",
  tier: 2,
  title: "Checkout sheds load after a quiet release",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Since checkout-api v4.24.0 went out, about one checkout in eight fails with a 503 from the edge. The release only changed copy on the order page. Everyone wants it rolled back. You have kubectl. Check what else the release changed before you roll it back.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "The edge answers 503 before the app ever sees the request. Count how many pods are serving, and how many there should be.",
  },
  opensAtSecondOfDay: 13 * 3600 + 49 * MINUTE,
  seed: "infra-t2-manifest-replicas",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-manifest-replicas",
      revisions: [revision(35, "v4.23.4", "order page copy review"), revision(36, "v4.24.0", "order page copy: delivery estimates")],
      revision: 36,
      replicas: 2,
      podsStartedAgo: 600,
      events: [scaledEvent(-610, CHECKOUT, 36, 2, 3)],
    }),
  isRootCauseFixed: (state) => replicasOf(state, CHECKOUT) >= 3 && fitsConnectionBudget(state),
  lostCheckoutsPerPoint: 200,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: MANAGER, text: "v4.24.0 is just copy, but it's the only change today. Roll it back?" },
    { at: 120, from: "Hana Sato · Release eng", text: "The deploy pipeline applied deploy/checkout-api.yaml from the release branch. That branch was cut a while ago." },
    { at: 210, from: SUPPORT, text: "Errors come and go. Retrying usually works." },
    { at: 320, from: VP, text: "It's lunchtime peak. Get capacity back." },
  ],
  hints: [
    "The failures come from the edge, not from the app. Something is turning requests away for lack of room.",
    "Compare how many pods are serving with how many the deployment normally runs.",
    "Rolling back the image changes the code. It doesn't change how many copies run.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get deployments", "kubectl rollout history deployment/checkout-api"],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get deployments", why: "checkout-api is 2/2: healthy, but it normally runs three replicas." },
      { command: "kubectl describe deployment/checkout-api", why: "Replicas: 2 desired. The manifest from the old release branch still said replicas: 2." },
      { command: "kubectl logs deployment/checkout-api", why: "The pods themselves serve 201s. The 503s are the edge's upstream overflow, so two pods simply can't carry 300 rps." },
      { command: "kubectl scale deployment/checkout-api --replicas=3", why: "Puts back the third replica. Rolling back the image would leave the replica count at two." },
      { command: "kubectl get pods", why: "Wait until three pods are 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What made checkout shed load after v4.24.0?",
    options: [
      "The new delivery-estimate copy slowed the order page down",
      "The release applied a stale manifest with replicas: 2",
      "orders-db could no longer keep up with lunchtime traffic",
      "The edge load balancer lost a health check on one of the three pods",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The pipeline applied deploy/checkout-api.yaml from a release branch cut before checkout was raised from 2 to 3 replicas, so the deploy also scaled checkout down to 2.",
      why: "Each pod serves about 130 rps. Two pods can't carry 300, so the edge turned away the overflow with 503 UO (upstream overflow). The image change was harmless, and rolling it back would have kept two replicas. Scaling back to three fixed it.",
      tell: "kubectl get deployments showed 2/2, a ScalingReplicaSet to 2 from 3 at deploy time, and the edge logs said upstream overflow while the pods returned 201s.",
    },
  },
};

const PARTNER_RPS = 420;

const trafficOutgrewReplicas: Scenario = {
  id: "infra-t2-partner-launch-capacity",
  tier: 2,
  title: "Partner launch outgrows checkout",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Our partnership with Northwind Rewards went live at 18:00. Traffic is up 40%, and a slice of checkouts now fails with 503 from the edge. payment-gateway's status page shows elevated latency. You have kubectl and psql. Find the bottleneck, and remember orders-db has a hard connection limit.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "More customers is good news. Find which part of the path ran out of room, and size the fix to fit orders-db.",
  },
  opensAtSecondOfDay: 18 * 3600 + 14 * MINUTE,
  seed: "infra-t2-partner-launch-capacity",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-partner-launch-capacity",
      revisions: [revision(37, "v4.24.1", "Northwind Rewards points at checkout")],
      revision: 37,
      requestsPerSecond: PARTNER_RPS,
      podsStartedAgo: 7_200,
    }),
  isRootCauseFixed: (state) => replicasOf(state, CHECKOUT) * POD_CAPACITY_RPS >= state.traffic.requestsPerSecond && fitsConnectionBudget(state),
  objectives: (state) => [
    { role: "infrastructure", label: "checkout-api's pools fit inside orders-db's max_connections", isMet: fitsConnectionBudget(state) },
  ],
  lostCheckoutsPerPoint: 180,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Elevated latency in EU-West (since 17:40)" },
        { key: "Timeouts from checkout-api", value: "≈3% (normal)" },
      ],
    },
  ],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 35, from: "Priya Shah · Partnerships", text: "Northwind sent their whole list the launch email. This is the traffic we hoped for!" },
    { at: 110, from: MANAGER, text: "payment-gateway's status page is amber. Is it them?" },
    { at: 200, from: "Olu Bakare · DBA", text: "Heads up: orders-db is max_connections 100. Don't go wild on replicas." },
    { at: 300, from: VP, text: "Northwind are watching their conversion dashboard. Fix it." },
  ],
  hints: [
    "The edge refuses the extra requests itself. Compare the traffic with what the pods can serve.",
    "Each pod has a ceiling, and the launch raised the floor.",
    "Every extra pod brings its own pool of database connections. Check there's room before adding many.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl top pods", 'psql -c "show max_connections"'],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/checkout-api", why: "The pods answer 201 quickly; there's no gateway timeout storm. The 503s are the edge's upstream overflow." },
      { command: "kubectl get deployments", why: "Three replicas at ~130 rps each can't carry 420 rps." },
      { command: 'psql -c "show max_connections"', why: "max_connections is 100, three are reserved, and each pod takes 20. Four pods (80) fit; five (100) don't." },
      { command: "kubectl scale deployment/checkout-api --replicas=4", why: "Four pods carry 420 rps and stay inside orders-db's connection limit." },
      { command: "kubectl get pods", why: "Wait for the fourth pod to be 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did checkout start failing at 18:00?",
    options: [
      "payment-gateway's EU-West latency made charges time out",
      "420 rps outgrew what three checkout pods can serve",
      "orders-db ran out of connections under the extra load",
      "Northwind's points lookup added latency to every checkout and timed requests out",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The partner launch raised traffic from 300 to 420 rps. Three checkout-api pods serve about 390 between them, so the edge shed the rest.",
      why: "The edge returned 503 UO for requests beyond the upstream's capacity; the pods themselves were healthy and gateway timeouts stayed at their usual 3%. Four replicas carry the load. Five or more would each need another 20 connections from an orders-db that has room for 97, and the extra pods would crash-loop on 'too many clients'.",
      tell: "The edge logged upstream overflow while the pods returned fast 201s, and traffic was up 40% with the replica count unchanged.",
    },
  },
};

// ── A neighbour hogging orders-db's connections ─────────────────────────────────────────────────

const reportExporterHog: Scenario = {
  id: "infra-t2-month-end-exporter",
  tier: 2,
  title: "Checkout pod can't get a connection",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "One checkout-api pod has been crash-looping since its node was recycled, and the other two are shedding load. It's month-end close, so finance is running exports. You have kubectl and psql. Get checkout back to three pods without stopping finance's close.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "A pod that can't start is telling you why. Find who else has a pool on orders-db, and who grew it recently.",
  },
  opensAtSecondOfDay: 17 * 3600 + 2 * MINUTE,
  seed: "infra-t2-month-end-exporter",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-month-end-exporter",
      revisions: [revision(38, "v4.24.2", "order summary currency rounding")],
      revision: 38,
      runningPods: 2,
      crashLooping: 1,
      podsStartedAgo: 9_000,
      neighbours: [
        {
          name: "report-exporter",
          replicas: 4,
          poolSize: 10,
          revisions: [revision(12, "v2.3.0", "month-end ledger CSV export")],
          revision: 12,
          startedAgo: 2_100,
        },
      ],
      events: [scaledEvent(-2_100, "report-exporter", 12, 4, 1)],
    }),
  isRootCauseFixed: isConnectionBudgetRestored,
  objectives: (state) => [
    { role: "infrastructure", label: "report-exporter keeps running for the month-end close", isMet: replicasOf(state, "report-exporter") >= 1 },
  ],
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Grace Liu · Finance systems", text: "We scaled report-exporter up to 4 at 16:30 so the close finishes before 19:00. Please don't kill it." },
    { at: 120, from: MANAGER, text: "Can we just restart checkout? Maybe that pod is stuck." },
    { at: 210, from: "Olu Bakare · DBA", text: "orders-db is at its connection cap. Want me to raise max_connections? It needs a restart of the database." },
    { at: 320, from: VP, text: "Checkout and the close both matter. Make both work." },
  ],
  hints: [
    "The pod that can't start says exactly what the database told it.",
    "Count every pool on orders-db, not just checkout's.",
    "Finance needs the exporter running, not running four copies of it.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get deployments", 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"'],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "One checkout-api pod is in CrashLoopBackOff. report-exporter is running four pods." },
      { command: "kubectl logs deployment/report-exporter", why: "Nothing interesting from the exporter itself, so look at the database side." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "checkout-api holds 40, report-exporter holds 40: one more pool of 20 would go past max_connections (97 usable)." },
      { command: "kubectl scale deployment/report-exporter --replicas=1", why: "One exporter keeps the close going and frees 30 connections, enough for checkout's third pod." },
      { command: "kubectl get pods", why: "Wait for the third checkout-api pod to come up 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why couldn't the third checkout-api pod start?",
    options: [
      "Its node was recycled and the pod got stuck on the old node's volume",
      "report-exporter's four pools left no room for another 20",
      "A bad checkout-api build crashed it at startup",
      "orders-db's max_connections had been lowered during the close",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Finance scaled report-exporter from 1 to 4 replicas, each with a pool of 10, which used up the connections checkout-api's third pod needed when its node was recycled.",
      why: "orders-db allows 97 client connections. Checkout's two surviving pods held 40 and the exporter held 40, so the replacement pod's pool of 20 hit 'sorry, too many clients already' and crash-looped, leaving two pods to shed the load. Restarting checkout would only add more pods failing the same way; raising max_connections means restarting the database. One exporter replica is enough for the close.",
      tell: "The crash-looping pod logged FATAL: sorry, too many clients already, and pg_stat_activity grouped by application showed report-exporter holding 40 connections.",
    },
  },
};

const searchIndexerHog: Scenario = {
  id: "infra-t2-catalog-backfill-indexer",
  tier: 2,
  title: "Checkout stuck at two pods",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api lost a pod to a spot interruption and the replacement won't come up. Search has been backfilling the catalog all afternoon. Someone suggested adding replicas to checkout so the third pod isn't needed. You have kubectl and psql.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Adding pods won't help if pods can't start. Find what's using up orders-db, and whether it still needs to.",
  },
  opensAtSecondOfDay: 15 * 3600 + 37 * MINUTE,
  seed: "infra-t2-catalog-backfill-indexer",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-catalog-backfill-indexer",
      revisions: [revision(39, "v4.24.3", "faster order history pagination")],
      revision: 39,
      runningPods: 2,
      crashLooping: 1,
      podsStartedAgo: 14_000,
      neighbours: [
        {
          name: "search-indexer",
          replicas: 8,
          poolSize: 5,
          revisions: [revision(70, "v6.2.0", "reindex catalog from orders-db product views")],
          revision: 70,
          startedAgo: 9_600,
        },
      ],
      events: [scaledEvent(-9_600, "search-indexer", 70, 8, 2)],
    }),
  isRootCauseFixed: isConnectionBudgetRestored,
  objectives: (state) => [
    { role: "infrastructure", label: "search-indexer keeps serving catalog updates", isMet: replicasOf(state, "search-indexer") >= 1 },
  ],
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 45, from: MANAGER, text: "Can we scale checkout to 5 so it doesn't matter that one pod is stuck?" },
    { at: 130, from: "Marco Bellini · Search", text: "We bumped search-indexer to 8 for the catalog backfill. It finished around 14:30, we just never scaled it back. Normally runs 2." },
    { at: 230, from: SUPPORT, text: "Errors at payment, on and off, for the last twenty minutes." },
    { at: 330, from: VP, text: "Where are we on checkout?" },
  ],
  hints: [
    "Read what the replacement pod hears back from the database when it starts.",
    "orders-db has a fixed number of seats. See who is sitting in them.",
    "More checkout replicas means more pods asking for seats that aren't there.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get deployments", 'psql -c "show max_connections"'],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "The third checkout-api pod is crash-looping. search-indexer runs eight pods." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "search-indexer holds 40 connections. With checkout's 40 there's no room for another pool of 20." },
      { command: 'psql -c "show max_connections"', why: "100, with three reserved for superusers: 97 for applications." },
      { command: "kubectl scale deployment/search-indexer --replicas=2", why: "The backfill is done and it normally runs two. That frees 30 connections." },
      { command: "kubectl get pods", why: "Wait for checkout-api to show three pods 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why wouldn't the replacement checkout pod start?",
    options: [
      "The spot interruption left its node without a database route",
      "search-indexer still ran eight pools after its backfill",
      "checkout-api needed more replicas to absorb the lost pod",
      "orders-db was overloaded by search-indexer's queries and stopped accepting sessions",
    ],
    answerIndex: 1,
    explanation: {
      cause: "search-indexer was scaled from 2 to 8 replicas for a catalog backfill and left there after it finished, holding 40 of orders-db's 97 client connections.",
      why: "When a spot interruption took a checkout-api pod, its replacement needed a pool of 20 and Postgres refused it with 'sorry, too many clients already'. Two pods shed checkout traffic. Adding checkout replicas would only add more pods hitting the same limit. Putting search-indexer back to its normal two freed the room.",
      tell: "The replacement pod logged FATAL: sorry, too many clients already, and pg_stat_activity showed search-indexer with 40 sessions, eight pods for a job that had finished.",
    },
  },
};

const forgottenCanary: Scenario = {
  id: "infra-t2-forgotten-canary",
  tier: 2,
  title: "A canary nobody uses starves checkout",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "A checkout-api pod was evicted during a node upgrade and its replacement keeps failing to start. The edge has the canary route at 0% and everyone has forgotten it exists. You have kubectl and psql. Get the third pod running.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "Traffic isn't the only thing a deployment uses. Look at everything holding connections to orders-db, including things that serve nobody.",
  },
  opensAtSecondOfDay: 10 * 3600 + 58 * MINUTE,
  seed: "infra-t2-forgotten-canary",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-forgotten-canary",
      revisions: [revision(41, "v4.25.0", "saved addresses on checkout")],
      revision: 41,
      runningPods: 2,
      crashLooping: 1,
      podsStartedAgo: 20_000,
      neighbours: [
        {
          name: "checkout-api-canary",
          replicas: 2,
          poolSize: 20,
          revisions: [revision(3, "v4.25.1-rc2", "canary: saved addresses autocomplete")],
          revision: 3,
          startedAgo: 260_000,
        },
      ],
    }),
  isRootCauseFixed: isConnectionBudgetRestored,
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Kofi Asante · Platform", text: "Node upgrade evicted one checkout pod at 10:50. Upgrades are paused now." },
    { at: 120, from: MANAGER, text: "Is v4.25.0 bad? Should we roll back?" },
    { at: 210, from: "Ana Ferreira · Checkout team", text: "Oh, the canary from last week's rc? We abandoned that at 0%. Did nobody tear it down?" },
    { at: 320, from: VP, text: "Customers are failing at payment. Status?" },
  ],
  hints: [
    "The replacement pod is turned away by the database, not by the code.",
    "A deployment that serves no customers can still hold database connections.",
    "Something abandoned last week is still running at full size.",
  ],
  suggestions: {
    infrastructure: ["kubectl get pods", "kubectl get deployments", 'psql -c "select state, count(*) from pg_stat_activity group by state"'],
  },
  solution: {
    infrastructure: [
      { command: "kubectl get deployments", why: "checkout-api is 2/3. checkout-api-canary is 2/2, three days old, and takes 0% of traffic." },
      { command: "kubectl logs deployment/checkout-api", why: "The two serving pods are fine; the third's start-up fails on the database." },
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "The canary holds 40 connections while serving no one. Together with checkout's 40, there's no room left." },
      { command: "kubectl scale deployment/checkout-api-canary --replicas=0", why: "The canary was abandoned at 0%. Scaling it to zero frees 40 connections." },
      { command: "kubectl get pods", why: "Wait for three checkout-api pods 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What stopped the replacement checkout pod from starting?",
    options: [
      "checkout-api v4.25.0 fails to start on freshly upgraded nodes",
      "An abandoned canary still held 40 orders-db connections",
      "The node upgrade changed the pod's database credentials",
      "orders-db hit its connection limit because the edge was retrying checkouts",
    ],
    answerIndex: 1,
    explanation: {
      cause: "checkout-api-canary was left at two replicas with pools of 20 after its rc was abandoned at 0% traffic, holding 40 of orders-db's 97 client connections.",
      why: "The canary served nobody but its pools stayed open. When the node upgrade evicted a checkout pod, the replacement couldn't get its 20 connections ('sorry, too many clients already') and crash-looped, so two pods shed checkout traffic. v4.25.0 was fine; rolling it back would have hit the same wall.",
      tell: "kubectl get deployments listed a three-day-old checkout-api-canary at 2/2, and pg_stat_activity showed it holding 40 sessions while taking 0% of traffic.",
    },
  },
};

// ── An index left invalid ───────────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_INDEX = "orders_customer_status_idx";

const indexLockTimeout: Scenario = {
  id: "infra-t2-maintenance-lock-timeout",
  tier: 2,
  title: "Checkout slows a little more every minute",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api latency has been climbing since early morning and 5xx is starting to show. The analytics-etl nightly batch ran late and is still running against orders-db. Everyone blames it. You have kubectl and psql. Find what orders-db is actually busy with.",
  roles: ["infrastructure"],
  roleBriefings: {
    infrastructure: "A late batch makes a good suspect. Ask Postgres which statement is slow, and how it's being planned.",
  },
  opensAtSecondOfDay: 5 * 3600 + 41 * MINUTE,
  seed: "infra-t2-maintenance-lock-timeout",
  initialState: () =>
    buildCluster({
      seed: "infra-t2-maintenance-lock-timeout",
      revisions: [revision(42, "v4.25.2", "order history: hide test orders")],
      revision: 42,
      podsStartedAgo: 30_000,
      neighbours: [
        {
          name: "analytics-etl",
          replicas: 1,
          poolSize: 4,
          revisions: [revision(15, "v1.8.3", "nightly orders extract to the warehouse")],
          revision: 15,
          startedAgo: 1_500,
        },
      ],
      hotIndex: {
        name: LOCK_TIMEOUT_INDEX,
        definition: "btree (customer_id, status)",
        query: "SELECT id, total_minor FROM orders WHERE customer_id = $1 AND status = 'pending' LIMIT 1",
        isValid: false,
        cacheEviction: 0.04,
        rebuild: null,
      },
      jobs: [{ name: "orders-maintenance-29561", status: "Failed", finishedAt: -1_900, durationSeconds: 640 }],
      logs: {
        "orders-maintenance-29561": [
          { t: -2_540, source: "orders-maintenance-29561", level: "INFO", text: `DROP INDEX CONCURRENTLY IF EXISTS ${LOCK_TIMEOUT_INDEX};` },
          { t: -2_530, source: "orders-maintenance-29561", level: "INFO", text: `CREATE INDEX CONCURRENTLY ${LOCK_TIMEOUT_INDEX} ON orders (customer_id, status);` },
          { t: -1_900, source: "orders-maintenance-29561", level: "ERROR", text: "ERROR:  canceling statement due to lock timeout" },
          { t: -1_900, source: "orders-maintenance-29561", level: "ERROR", text: "maintenance step 2/2 failed; exiting 1" },
        ],
      },
    }),
  isRootCauseFixed: (state) => state.database.hotIndex?.isValid ?? true,
  lostCheckoutsPerPoint: 260,
  externals: [],
  comms: [
    { at: 0, from: PAGER, text: "SEV2 triggered — checkout-api p99 > 2s and 5xx > 1%. Assigned to you." },
    { at: 40, from: "Nadia Haddad · Data", text: "analytics-etl started late, sorry. It's a read-only extract. I can stop it if you need." },
    { at: 140, from: MANAGER, text: "Kill the ETL? It's the only thing running at this hour." },
    { at: 230, from: SUPPORT, text: "Early shoppers say the pay button spins for ages." },
    { at: 330, from: VP, text: "The breakfast promo goes out at 06:30. This needs to be fixed by then." },
  ],
  hints: [
    "Find the statement that's slow, then ask the planner how it runs it.",
    "A batch would show up as its own sessions. Count who holds what.",
    "Look at what last night's maintenance job left behind on orders.",
  ],
  suggestions: {
    infrastructure: [
      'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"',
      'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"',
      "kubectl get jobs",
    ],
  },
  solution: {
    infrastructure: [
      { command: 'psql -c "select application_name, count(*) from pg_stat_activity group by application_name"', why: "analytics-etl holds 4 sessions. The pressure comes from checkout-api's own pool." },
      { command: 'psql -c "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5"', why: "checkout's pending-order lookup takes hundreds of milliseconds, and it gets slower." },
      { command: "psql -c \"explain select id, total_minor from orders where customer_id = $1 and status = 'pending' limit 1\"", why: "Parallel Seq Scan on orders: the lookup doesn't use an index." },
      { command: 'psql -c "\\d orders"', why: "orders_customer_status_idx is there but marked INVALID." },
      { command: "kubectl logs job/orders-maintenance-29561", why: "The maintenance job dropped the index, then its rebuild was cancelled on lock timeout." },
      { command: `psql -c "REINDEX INDEX CONCURRENTLY ${LOCK_TIMEOUT_INDEX}"`, why: "Rebuilds the index without locking orders against writes. Stopping the ETL wouldn't touch the plan." },
      { command: 'psql -c "select * from pg_stat_progress_create_index"', why: "Watch the rebuild finish, then declare resolved once 5xx drops." },
    ],
  },
  postmortem: {
    question: "Why was checkout getting slower?",
    options: [
      "analytics-etl's extract competed with checkout for orders-db",
      "A failed maintenance rebuild left the orders index INVALID",
      "checkout-api v4.25.2 added a slower order history query",
      "Autovacuum fell behind overnight and bloated orders",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The nightly orders-maintenance job dropped orders_customer_status_idx and rebuilt it CONCURRENTLY, and the rebuild was cancelled on lock_timeout, leaving the index INVALID.",
      why: "Postgres doesn't plan with an invalid index, so checkout's pending-order lookup scanned the whole orders table. Each scan held a pooled connection longer, and the scans pushed hot pages out of shared_buffers, so it got worse by the minute. analytics-etl held four sessions and wasn't the cause. REINDEX CONCURRENTLY rebuilds the index while checkout keeps writing.",
      tell: "EXPLAIN showed a Seq Scan, \\d orders marked the index INVALID, and the failed maintenance job's log ended with 'canceling statement due to lock timeout'.",
    },
  },
};

/** Every tier 2 infrastructure War Room in this set. */
export const INFRA_TIER2_INCIDENTS: readonly Scenario[] = [
  heapExhaustion,
  nativeThreads,
  nativeMemory,
  tenderRecursion,
  livenessCoupling,
  nativeSegfault,
  leakWithTerminateDecoy,
  leakWithRestartDecoy,
  replicasFromManifest,
  trafficOutgrewReplicas,
  reportExporterHog,
  searchIndexerHog,
  forgottenCanary,
  indexLockTimeout,
];
