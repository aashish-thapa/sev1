import { seededRandom } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import { templateHash, type ClusterEvent, type ClusterState, type Deployment, type Job, type LogEntry, type Pod, type Trait } from "../sim/model.ts";
import { isOnCleanBuild } from "./checkout-cluster.ts";

/** Same shape as checkoutCluster's service: one pod serves 130 rps, the shop sends 300, 40% of it checkouts. */
const POD_CAPACITY_RPS = 130;
const TRAFFIC = { requestsPerSecond: 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 } as const;
const WARM_UP_SECONDS = 30;
const MENTOR = "Priya Nair · Senior SRE (your mentor)";

type ClusterSetup = {
  readonly revisions: Deployment["revisions"];
  readonly revision: number;
  readonly replicas: number;
  /** Pods running when the warm-up starts; defaults to `replicas`. */
  readonly runningPods?: number;
  readonly podsStartedAgo?: number;
  /** Connections each starting pod has already stranded, for a leak that began before the page. */
  readonly startingLeak?: readonly number[];
  readonly events?: (hash: (revision: number) => string) => readonly ClusterEvent[];
  readonly logs?: Readonly<Record<string, readonly LogEntry[]>>;
  readonly jobs?: readonly Job[];
};

/**
 * checkoutCluster for a service of any name: the service behind the edge's POST /checkout runs
 * its warm-up up to the page, then the damage counters are zeroed so scoring starts at the page.
 */
function serviceCluster(seed: string, service: string, setup: ClusterSetup): ClusterState {
  const hash = templateHash(service, setup.revision, 0);
  const startedAgo = setup.podsStartedAgo ?? 1_200;
  const pods: Pod[] = Array.from({ length: setup.runningPods ?? setup.replicas }, (_, index) => ({
    name: podName(service, hash, index + 1),
    templateHash: hash,
    revision: setup.revision,
    phase: "Running",
    startedAt: -startedAgo - index * 35,
    phaseLeft: 0,
    leaked: setup.startingLeak?.[index] ?? 0,
    restarts: 0,
    connectionHistory: [],
  }));
  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [
      { name: service, replicas: setup.replicas, poolSize: 20, podCapacityRps: POD_CAPACITY_RPS, revision: setup.revision, generation: 0, revisions: setup.revisions, pods },
    ],
    database: { name: "orders-db", host: "orders-db.internal", maxConnections: 100, reservedConnections: 3 },
    traffic: TRAFFIC,
    logs: setup.logs ?? {},
    events: setup.events?.((revision) => templateHash(service, revision, 0)) ?? [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: pods.length,
    ...(setup.jobs ? { jobs: setup.jobs } : {}),
  };
  const random = seededRandom(`${seed}:warm-up`);
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

/** The one move that fixes a tier-1 incident: put the replica count back, or roll back the bad build. */
type Fix = { readonly kind: "scale"; readonly replicas: number } | { readonly kind: "rollback" };

type Row = Omit<Scenario, "tier" | "roles" | "seed" | "initialState" | "isRootCauseFixed" | "externals" | "roleBriefings"> & {
  readonly roleBriefing: string;
  readonly cluster: ClusterSetup;
  readonly fix: Fix;
};

function incident({ roleBriefing, cluster, fix, ...row }: Row): Scenario {
  return {
    ...row,
    tier: 1,
    roles: ["infrastructure"],
    roleBriefings: { infrastructure: roleBriefing },
    seed: row.id,
    initialState: () => serviceCluster(row.id, row.service, cluster),
    isRootCauseFixed:
      fix.kind === "scale" ? (state) => state.deployments.every((deployment) => deployment.replicas >= fix.replicas) : isOnCleanBuild,
    externals: [],
  };
}

const crashesOnCheckout = (lastWords: string, afterSeconds = 3, jitterSeconds = 5): Trait => ({
  kind: "crashes-while-serving",
  termination: { reason: "Error", exitCode: 1 },
  afterSeconds,
  jitterSeconds,
  lastWords,
  failsCheckouts: true,
});

const diesWhileServing = (termination: { reason: "OOMKilled" | "Error"; exitCode: number }, lastWords: string, afterSeconds: number, jitterSeconds: number): Trait => ({
  kind: "crashes-while-serving",
  termination,
  afterSeconds,
  jitterSeconds,
  lastWords,
  failsCheckouts: false,
});

const leaksOn = (dependency: string, leaksPerSecondAtBaseline: number): Trait => ({
  kind: "leaks-connection-on-dependency-timeout",
  dependency,
  leaksPerSecondAtBaseline,
  perPodBaselineRps: 100,
});

const log = (source: string, t: number, level: LogEntry["level"], text: string): LogEntry => ({ t, source, level, text });

const rightsizerWeekend = incident({
  id: "infra-t1-rightsizer-weekend",
  title: "Half the Saturday sale gets a 503",
  severity: "SEV2",
  service: "orders-api",
  briefing:
    "The Saturday flash sale opened at 09:00 and about half of all checkouts are bouncing with 503s. Nothing was deployed this week. You have kubectl on the prod bastion; Priya is on the call.",
  roleBriefing: "orders-api takes every POST /checkout. The edge says it's overflowing. Count what's actually serving before you blame the code.",
  opensAtSecondOfDay: 9 * 3600 + 14 * 60,
  cluster: {
    revisions: [
      { number: 21, tag: "v9.4.0", changeCause: "v9.4.0 order notes field", traits: [] },
      { number: 22, tag: "v9.4.1", changeCause: "v9.4.1 bump postgres driver to 42.7.4", traits: [] },
    ],
    revision: 22,
    replicas: 1,
    runningPods: 1,
    events: (hash) => [
      { t: -25_200, type: "Normal", reason: "ScalingReplicaSet", object: "deployment/orders-api", message: `Scaled down replica set orders-api-${hash(22)} to 1 from 3` },
      { t: -25_195, type: "Normal", reason: "SuccessfulCreate", object: "job/rightsizer-29340120", message: "Created pod: rightsizer-29340120-k7xqp" },
    ],
    jobs: [{ name: "rightsizer-29340120", status: "Complete", finishedAt: -25_190, durationSeconds: 14 }],
    logs: {
      "rightsizer-29340120": [
        log("rightsizer-29340120", -25_204, "INFO", "rightsizer 0.9.2: sampling window Fri 22:00 – Sat 02:00 (4h)"),
        log("rightsizer-29340120", -25_203, "INFO", "deployment/orders-api: p95 cpu 6% of request, p95 rps 38 → recommend replicas=1 (was 3)"),
        log("rightsizer-29340120", -25_202, "WARN", "deployment/orders-api has no HorizontalPodAutoscaler; recommendation will not scale back up on load"),
        log("rightsizer-29340120", -25_200, "INFO", "applied 1 recommendation (mode=enforce): orders-api 3 → 1"),
      ],
    },
  },
  fix: { kind: "scale", replicas: 3 },
  lostCheckoutsPerPoint: 260,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — orders-api 5xx > 50% for 3m. Assigned to you." },
    { at: 15, from: MENTOR, text: "Half failing, half working usually means not enough of something. How many pods does it have right now?" },
    { at: 45, from: "Lena Ortiz · Growth", text: "The sale email went to 2 million people at 09:00. Please tell me this isn't the email." },
    { at: 70, from: MENTOR, text: "One pod. It runs three on a weekday. kubectl get events will say who changed that, and there's a job in the list worth reading." },
    { at: 105, from: "Hiro Tanaka · FinOps", text: "Our rightsizer went from dry-run to enforce on Friday. It only touches things that are idle overnight…" },
    { at: 130, from: MENTOR, text: "Put it back where it was: kubectl scale deployment/orders-api --replicas=3. We'll talk to FinOps after." },
    { at: 230, from: "Elena Ruiz · VP Engineering", text: "The sale is the biggest hour of the month. Where are we?" },
  ],
  hints: [
    "About half the requests work. Count how many pods are serving and compare it with a normal weekday.",
    "The cluster’s recent events say when the count changed, and a short job ran right before it.",
    "Nothing in the code changed. Put the count back to what it runs on a normal day.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl get events", "kubectl get jobs", "kubectl describe deployment/orders-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "One pod, healthy, and the edge logs 503 UO: it's overflowing, not crashing." },
      { command: "kubectl get events", why: "orders-api was scaled down to 1 from 3 at 02:14, by a job, not by a deploy." },
      { command: "kubectl logs job/rightsizer-29340120", why: "The rightsizer sampled 22:00–02:00, saw 6% CPU, and enforced replicas=1 with no autoscaler to bring it back." },
      { command: "kubectl scale deployment/orders-api --replicas=3", why: "Three pods carry 300 rps with headroom; one carries 130." },
      { command: "kubectl get pods", why: "Wait until all three are 1/1 Running and the 503s stop, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why was orders-api shedding half its requests?",
    options: [
      "v9.4.1's new postgres driver slowed every query down under sale traffic",
      "A rightsizing job sized it to 1 replica from a quiet overnight window",
      "orders-db hit max_connections when the sale email went out to everyone",
      "The edge load balancer lost half of its upstream health checks",
    ],
    answerIndex: 1,
    explanation: {
      cause: "A FinOps rightsizer, newly switched to enforce mode, set orders-api to 1 replica based on a 4-hour overnight sample.",
      why: "One pod serves about 130 rps and the sale sent 300, so the edge shed the overflow as 503 UO. Nothing was broken in the code or the database; the deployment simply wanted one pod. Scaling back to three restored the capacity, and a rightsizer must never enforce on a service without an autoscaler.",
      tell: "kubectl get pods showed a single healthy pod, the events showed 'Scaled down … to 1 from 3' at 02:14, and the rightsizer job's log printed the recommendation it applied.",
    },
  },
});

const canaryScaleTypo = incident({
  id: "infra-t1-canary-scale-typo",
  title: "A slice of payments time out",
  severity: "SEV3",
  service: "payments-api",
  briefing:
    "Around one checkout in eight is failing with a 503. No deploy is running. A canary of payments-api was wrapped up a few minutes ago. You have kubectl on the prod bastion and Priya on the call.",
  roleBriefing: "payments-api serves POST /checkout behind the edge and normally runs four pods. Check what it has now.",
  opensAtSecondOfDay: 16 * 3600 + 3 * 60,
  cluster: {
    revisions: [
      { number: 40, tag: "v12.7.2", changeCause: "v12.7.2 3DS2 challenge timeout to 10s", traits: [] },
      { number: 41, tag: "v12.8.0", changeCause: "v12.8.0 iDEAL payment method", traits: [] },
    ],
    revision: 41,
    replicas: 2,
    runningPods: 2,
    events: (hash) => [
      { t: -240, type: "Normal", reason: "ScalingReplicaSet", object: "deployment/payments-api-canary", message: "Scaled down replica set payments-api-canary-6f9d8 to 0 from 1" },
      { t: -190, type: "Normal", reason: "ScalingReplicaSet", object: "deployment/payments-api", message: `Scaled down replica set payments-api-${hash(41)} to 2 from 4` },
    ],
  },
  fix: { kind: "scale", replicas: 4 },
  lostCheckoutsPerPoint: 100,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV3 triggered — payments-api 5xx > 10% for 3m. Assigned to you." },
    { at: 15, from: MENTOR, text: "A steady slice failing, no crashes? Look at how many pods are serving versus how many it should have." },
    { at: 50, from: "Dev Raman · Payments", text: "Canary for v12.8.0 looked clean, so I scaled it down and moved on. That's all I touched." },
    { at: 80, from: MENTOR, text: "kubectl get events lists every scale. Check which deployment each one hit." },
    { at: 115, from: "Dev Raman · Payments", text: "Oh no. Tab completion. I think I scaled payments-api, not payments-api-canary, the second time." },
    { at: 140, from: MENTOR, text: "It runs four. kubectl scale deployment/payments-api --replicas=4 and it's done." },
    { at: 240, from: "Maya Okonkwo · Support", text: "A trickle of 'payment failed, try again' tickets. Not a flood yet." },
  ],
  hints: [
    "The failures are a steady slice, and no pod is restarting. Compare serving pods with the usual count.",
    "Every scale leaves a line in the cluster’s recent events, with the deployment it hit.",
    "The build is fine. It just has half the pods it usually runs.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl get deployments", "kubectl get events"] },
  solution: {
    infrastructure: [
      { command: "kubectl get deployments", why: "payments-api is 2/2 Ready, but it normally runs four." },
      { command: "kubectl get events", why: "Two scale-downs a minute apart: the canary to 0, then payments-api to 2 from 4." },
      { command: "kubectl scale deployment/payments-api --replicas=4", why: "Puts back the two pods the typo took away." },
      { command: "kubectl get deployments", why: "Wait for 4/4 Ready and the 503s to stop, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did one checkout in eight fail?",
    options: [
      "The v12.8.0 canary leaked bad traffic into the stable pods",
      "payments-api was scaled to 2 instead of its canary",
      "iDEAL payments overloaded the payment gateway",
      "orders-db ran short of connections for the extra pods",
    ],
    answerIndex: 1,
    explanation: {
      cause: "While shutting down the canary, a scale command meant for payments-api-canary was tab-completed to payments-api and set it to 2 replicas.",
      why: "Two pods serve about 260 rps of the 300 the shop sends, so the edge shed the rest as 503 UO: a steady 13% with no crashes and nothing deployed. Scaling back to four restored the headroom.",
      tell: "kubectl get events showed payments-api 'Scaled down … to 2 from 4' a minute after the canary's own scale-down, with no rollout around it.",
    },
  },
});

const maintenanceLeftDown = incident({
  id: "infra-t1-maintenance-left-down",
  title: "Checkout stays dark after maintenance",
  severity: "SEV1",
  service: "cart-service",
  briefing:
    "The 05:30 orders-db maintenance window closed at 06:00 and the pager went off at once: cart-service answers nothing. The database upgrade itself reported success. You have kubectl and psql on the prod bastion.",
  roleBriefing: "cart-service writes every order to orders-db. The maintenance runbook touched it. Find out what state the runbook left it in.",
  opensAtSecondOfDay: 6 * 3600 + 1 * 60,
  cluster: {
    revisions: [
      { number: 17, tag: "v3.22.0", changeCause: "v3.22.0 save-for-later list", traits: [] },
      { number: 18, tag: "v3.22.1", changeCause: "v3.22.1 fix cart merge on login", traits: [] },
    ],
    revision: 18,
    replicas: 0,
    runningPods: 0,
    events: (hash) => [
      { t: -1_800, type: "Normal", reason: "ScalingReplicaSet", object: "deployment/cart-service", message: `Scaled down replica set cart-service-${hash(18)} to 0 from 3` },
      { t: -1_790, type: "Normal", reason: "Completed", object: "job/orders-db-minor-upgrade", message: "Job completed" },
    ],
    jobs: [{ name: "orders-db-minor-upgrade", status: "Complete", finishedAt: -60, durationSeconds: 1_760 }],
    logs: {
      "orders-db-minor-upgrade": [
        log("orders-db-minor-upgrade", -1_820, "INFO", "runbook db-minor-upgrade v4 started (args: --until=8)"),
        log("orders-db-minor-upgrade", -1_800, "INFO", "step 3/9: scale writers to 0 → deployment/cart-service replicas=0"),
        log("orders-db-minor-upgrade", -400, "INFO", "step 7/9: orders-db restarted on PostgreSQL 16.6 (was 16.4)"),
        log("orders-db-minor-upgrade", -70, "INFO", "step 8/9: SELECT version() ok, replication lag 0 bytes"),
        log("orders-db-minor-upgrade", -60, "WARN", "step 9/9: scale writers back to their saved replicas — SKIPPED (--until=8)"),
        log("orders-db-minor-upgrade", -60, "INFO", "runbook finished: 8 steps run, 1 skipped"),
      ],
    },
  },
  fix: { kind: "scale", replicas: 3 },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — cart-service 5xx at 100% (maintenance window ended 06:00). Assigned to you." },
    { at: 15, from: MENTOR, text: "First: is there anything running to answer? Then: what did the maintenance actually do?" },
    { at: 45, from: "Omar Haddad · DBA", text: "orders-db is up on 16.6, replication is clean. From my side the upgrade is done." },
    { at: 75, from: MENTOR, text: "No pods and a job that just finished. kubectl logs job/orders-db-minor-upgrade will show every step it ran, and every one it didn't." },
    { at: 110, from: "Omar Haddad · DBA", text: "I ran it with --until=8 so I could check the database before letting writes in. Then the 05:50 call ate me. Sorry." },
    { at: 135, from: MENTOR, text: "Step 9 is yours to do by hand: it runs three. kubectl scale deployment/cart-service --replicas=3." },
    { at: 210, from: "Elena Ruiz · VP Engineering", text: "Early shoppers in Europe can't check out. What's the status?" },
  ],
  hints: [
    "Every request fails. Before anything else, see whether anything is running to answer them.",
    "A maintenance job finished minutes before the page. Its output lists each step it ran, and any it skipped.",
    "The database is healthy. The step that brings the writers back never ran.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl get jobs", "kubectl get events", 'psql -c "select state, count(*) from pg_stat_activity group by state"'] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "No pods at all: nothing is crashing, nothing is there." },
      { command: "kubectl get jobs", why: "orders-db-minor-upgrade completed a minute before the page." },
      { command: "kubectl logs job/orders-db-minor-upgrade", why: "Step 3 scaled cart-service to 0; step 9, which scales it back, was skipped by --until=8." },
      { command: "kubectl scale deployment/cart-service --replicas=3", why: "Does step 9 by hand: back to the three replicas it runs." },
      { command: "kubectl get pods", why: "Wait for three pods 1/1 Running, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why was cart-service down after the maintenance window?",
    options: [
      "PostgreSQL 16.6 rejected cart-service's connections after the upgrade",
      "The runbook stopped before the step that scales writers back up",
      "cart-service crashed on the new database version's protocol",
      "The maintenance window's alert suppression hid a bad deploy",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The upgrade runbook was run with --until=8, so step 9, which scales cart-service back from 0 to its saved replicas, never ran.",
      why: "Step 3 scaled the writers to zero so the database could restart cleanly. The operator stopped at step 8 to check the database and was pulled away; the window ended with cart-service still wanting zero pods. Scaling it back to three restored it, and the runbook should alert when it exits with writers still down.",
      tell: "No pods at all, an event scaling cart-service to 0 from 3 at the start of the window, and the job log line 'step 9/9 … SKIPPED (--until=8)'.",
    },
  },
});

const taxRateNpe = incident({
  id: "infra-t1-tax-rate-npe",
  title: "Tax service crashes on every checkout",
  severity: "SEV2",
  service: "tax-api",
  briefing:
    "tax-api shipped v3.4.0 at 12:50 and its pods have been dying since. Checkout can't price an order without it, so most payments fail. You have kubectl on the prod bastion; Priya is on the call.",
  roleBriefing: "tax-api prices every POST /checkout. Its pods keep restarting. Find out why, then make it stop.",
  opensAtSecondOfDay: 12 * 3600 + 58 * 60,
  cluster: {
    revisions: [
      { number: 30, tag: "v3.3.2", changeCause: "v3.3.2 round half-even for EU VAT", traits: [] },
      {
        number: 31,
        tag: "v3.4.0",
        changeCause: "v3.4.0 Québec QST support",
        traits: [
          crashesOnCheckout(
            'Exception in thread "http-nio-8080-exec-6" java.lang.NullPointerException: Cannot invoke "java.math.BigDecimal.multiply(java.math.BigDecimal)" because the return value of "java.util.Map.get(Object)" is null',
          ),
        ],
      },
    ],
    revision: 31,
    replicas: 3,
    podsStartedAgo: 45,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — tax-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "Pods first. If RESTARTS is climbing, the logs will tell you what killed them." },
    { at: 50, from: "Aisha Bello · Tax engineering", text: "We added a QST rate table for Québec in v3.4.0. Tested in staging, all green." },
    { at: 85, from: MENTOR, text: "Map.get returned null and it went straight into a multiply. The previous build never did that lookup. Roll back first: kubectl rollout undo deployment/tax-api." },
    { at: 130, from: "Aisha Bello · Tax engineering", text: "Found it: the rate table is keyed by province code, prod config only has the federal rates loaded." },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Customers see 'unable to calculate tax'. How long?" },
  ],
  hints: [
    "The pods are there but keep dying. Look at their status and restart counts.",
    "A pod that dies usually logs why just before it goes.",
    "The trouble started with the newest release, and the one before it ran fine for weeks.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/tax-api", "kubectl rollout history deployment/tax-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "CrashLoopBackOff on every pod, restarts climbing." },
      { command: "kubectl logs deployment/tax-api", why: "Each one dies on a NullPointerException: a rate lookup returned null and was multiplied." },
      { command: "kubectl rollout history deployment/tax-api", why: "v3.4.0 (Québec QST) went out just before; v3.3.2 was steady." },
      { command: "kubectl rollout undo deployment/tax-api", why: "v3.3.2 doesn't do the lookup that returns null." },
      { command: "kubectl rollout status deployment/tax-api", why: "Wait for every pod to run the old build, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did tax-api's pods keep dying?",
    options: [
      "They ran past their 1Gi memory limit pricing big carts",
      "v3.4.0 looked up a tax rate prod never loaded, and the null crashed it",
      "orders-db refused connections during the lunch peak",
      "The new QST rules made tax calculation too slow for the readiness probe to pass",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v3.4.0 looked up Québec's QST rate in a table that prod config never populated; the lookup returned null and the multiply threw.",
      why: "Staging had the full rate table, so tests passed. In prod the first order that reached the new code path threw a NullPointerException and took the process down; Kubernetes restarted it into the same crash. Rolling back removed the lookup until the config ships.",
      tell: "CrashLoopBackOff right after the deploy, and every pod's last log line was the same NullPointerException naming Map.get returning null inside BigDecimal.multiply.",
    },
  },
});

const missingSecretPlaceholder = incident({
  id: "infra-t1-missing-secret-placeholder",
  title: "Billing never finishes starting",
  severity: "SEV2",
  service: "billing-api",
  briefing:
    "billing-api v6.0.0 rolled out at 08:20 and checkout has been failing since. Its pods start, then fall over within seconds. You have kubectl on the prod bastion and Priya is around.",
  roleBriefing: "billing-api captures payment on POST /checkout. Its newest pods won't stay up. Read what they say as they die.",
  opensAtSecondOfDay: 8 * 3600 + 27 * 60,
  cluster: {
    revisions: [
      { number: 54, tag: "v5.9.2", changeCause: "v5.9.2 retry Adyen webhooks with backoff", traits: [] },
      {
        number: 55,
        tag: "v6.0.0",
        changeCause: "v6.0.0 move webhook signing to adyen.hmac-key",
        traits: [crashesOnCheckout('java.lang.IllegalArgumentException: Could not resolve placeholder \'adyen.hmac-key\' in value "${adyen.hmac-key}"', 0, 2)],
      },
    ],
    revision: 55,
    replicas: 3,
    podsStartedAgo: 30,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — billing-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "kubectl get pods. If they never stay Ready, the first thing they log is what's missing." },
    { at: 55, from: "Tomás Silva · Payments platform", text: "v6.0.0 renames the webhook secret. The SealedSecret PR for prod is… still open, I think." },
    { at: 90, from: MENTOR, text: "A placeholder it can't resolve means config prod doesn't have. Don't hand-edit secrets at 8am: kubectl rollout undo deployment/billing-api, then merge the secret and redeploy." },
    { at: 140, from: "Tomás Silva · Payments platform", text: "Confirmed, the prod secret still has the old key name. I'll get it merged before we try again." },
    { at: 225, from: "Elena Ruiz · VP Engineering", text: "Morning orders are failing. Update?" },
  ],
  hints: [
    "The pods come up and fall over almost at once. Check their state and how often they restart.",
    "An app that can’t start says what it was missing in its last line.",
    "The release before this one had everything it needed.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl logs deployment/billing-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "CrashLoopBackOff, restarting within seconds of starting." },
      { command: "kubectl logs deployment/billing-api", why: "Spring can't resolve the placeholder adyen.hmac-key: the property doesn't exist in prod." },
      { command: "kubectl rollout history deployment/billing-api", why: "v6.0.0 moved webhook signing to that new property; v5.9.2 used the old one." },
      { command: "kubectl rollout undo deployment/billing-api", why: "v5.9.2 reads the key prod actually has." },
      { command: "kubectl rollout status deployment/billing-api", why: "Wait for the rollout to finish, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why couldn't billing-api v6.0.0 stay up?",
    options: [
      "Adyen rejected its webhook signatures and it shut itself down",
      "It needed a property, adyen.hmac-key, that prod's secret lacked",
      "Its JVM ran out of heap during startup",
      "The rollout's readiness probe timed out before Spring finished loading",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v6.0.0 read a renamed property, adyen.hmac-key, but the prod secret that supplies it hadn't been updated.",
      why: "Spring resolves every ${…} placeholder while building the application context; one it can't resolve throws IllegalArgumentException and the process exits. Kubernetes restarted each pod into the same failure. Rolling back to v5.9.2, which reads the old key name, restored checkout while the secret change was merged.",
      tell: "CrashLoopBackOff seconds after each start, and the logs ended on \"Could not resolve placeholder 'adyen.hmac-key'\".",
    },
  },
});

const flywayChecksum = incident({
  id: "infra-t1-flyway-checksum",
  title: "Inventory refuses to boot",
  severity: "SEV2",
  service: "inventory-api",
  briefing:
    "inventory-api v8.1.0 went out at 15:05. Since then its pods won't stay up and checkout can't reserve stock, so most orders fail. You have kubectl on the prod bastion and Priya on the call.",
  roleBriefing: "inventory-api reserves stock during POST /checkout and migrates its own schema on startup. It's crash-looping. Find out why.",
  opensAtSecondOfDay: 15 * 3600 + 12 * 60,
  cluster: {
    revisions: [
      { number: 63, tag: "v8.0.3", changeCause: "v8.0.3 V47 reserve_stock function", traits: [] },
      {
        number: 64,
        tag: "v8.1.0",
        changeCause: "v8.1.0 backorder flag; tidy SQL comments",
        traits: [
          crashesOnCheckout(
            "org.flywaydb.core.api.exception.FlywayValidateException: Validate failed: Migrations have failed validation. Migration checksum mismatch for migration version 47 -> Applied to database : 1203877412 -> Resolved locally : -88112305.",
            0,
            2,
          ),
        ],
      },
    ],
    revision: 64,
    replicas: 3,
    podsStartedAgo: 30,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — inventory-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "Look at the pods, then at what they say right before they die." },
    { at: 55, from: "Ines Varga · Inventory", text: "v8.1.0 was tiny: a backorder flag, and I cleaned up comments in some old migration files." },
    { at: 90, from: MENTOR, text: "Flyway compares every applied migration with the file in the build. Edit an applied one and it won't start. Roll back: kubectl rollout undo deployment/inventory-api." },
    { at: 135, from: "Ines Varga · Inventory", text: "V47 was one of the files I touched. I'll put it back byte for byte." },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Orders are failing at 'reserving your items'. ETA?" },
  ],
  hints: [
    "The pods keep restarting within seconds. Their status and restart counts say how bad.",
    "Read the last thing a pod logs before it exits: it names what failed validation.",
    "The build before this one started cleanly against the very same database.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/inventory-api", "kubectl get events"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Every pod in CrashLoopBackOff." },
      { command: "kubectl logs deployment/inventory-api", why: "Flyway validation fails: migration 47's checksum in the build doesn't match the one the database recorded." },
      { command: "kubectl rollout history deployment/inventory-api", why: "v8.1.0 'tidied SQL comments', which changed an already-applied migration file." },
      { command: "kubectl rollout undo deployment/inventory-api", why: "v8.0.3 carries V47 exactly as it was applied, so validation passes." },
      { command: "kubectl rollout status deployment/inventory-api", why: "Wait for the old build on every pod, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did inventory-api v8.1.0 refuse to start?",
    options: [
      "Migration 47 failed halfway and left orders-db in a broken state",
      "An already-applied migration file was edited, so Flyway's checksum failed",
      "orders-db was out of connections for the new pods",
      "The backorder flag added a column that conflicted with the reserve_stock function",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v8.1.0 edited comments inside V47, a migration already applied to prod, so its checksum no longer matched the schema history.",
      why: "Flyway validates every applied migration against the file in the build before migrating. A changed checksum fails validation and stops the app from starting, even though the schema itself is fine. Rolling back to v8.0.3 restored the original file; the fix going forward is to never edit applied migrations.",
      tell: "Every pod's last line was FlywayValidateException: 'Migration checksum mismatch for migration version 47', with different applied and local checksums.",
    },
  },
});

const couponClassCast = incident({
  id: "infra-t1-coupon-classcast",
  title: "Coupons take checkout down",
  severity: "SEV2",
  service: "promotions-api",
  briefing:
    "promotions-api v2.18.0 (coupon stacking) went out at 19:30 and its pods started dying right after. Checkout can't apply discounts without it. You have kubectl on the prod bastion; Priya is on the call.",
  roleBriefing: "promotions-api applies discounts on every POST /checkout. Its pods are restarting. Find out what kills them.",
  opensAtSecondOfDay: 19 * 3600 + 38 * 60,
  cluster: {
    revisions: [
      { number: 12, tag: "v2.17.4", changeCause: "v2.17.4 free-shipping threshold per region", traits: [] },
      {
        number: 13,
        tag: "v2.18.0",
        changeCause: "v2.18.0 coupon stacking",
        traits: [
          crashesOnCheckout(
            'Exception in thread "http-nio-8080-exec-11" java.lang.ClassCastException: class java.lang.Integer cannot be cast to class java.lang.Long (java.lang.Integer and java.lang.Long are in module java.base of loader \'bootstrap\')',
            4,
            6,
          ),
        ],
      },
    ],
    revision: 13,
    replicas: 3,
    podsStartedAgo: 50,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — promotions-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "Check the pods' STATUS and RESTARTS first, then read a crash." },
    { at: 50, from: "Noor Rahman · Promotions", text: "Stacking reads discounts out of the Redis cache. Values under 2^31 come back as Integer, oh." },
    { at: 85, from: MENTOR, text: "It worked before this release and dies after it: kubectl rollout undo deployment/promotions-api. Fix the cast in daylight." },
    { at: 140, from: "Lena Ortiz · Growth", text: "The evening coupon push is live, so every checkout has a code on it right now." },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Is checkout back? The coupon email just went out." },
  ],
  hints: [
    "The pods exist but keep going away. How often do they restart?",
    "The crash leaves its reason in the pod’s last log lines.",
    "It began with the coupon release; the release before it handled the same traffic.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/promotions-api", "kubectl rollout history deployment/promotions-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "CrashLoopBackOff, restarts climbing on all three pods." },
      { command: "kubectl logs deployment/promotions-api", why: "A ClassCastException, Integer to Long, on a request thread, every time." },
      { command: "kubectl rollout history deployment/promotions-api", why: "v2.18.0 (coupon stacking) is the newest; v2.17.4 was stable." },
      { command: "kubectl rollout undo deployment/promotions-api", why: "v2.17.4 doesn't read the cached discounts as Long." },
      { command: "kubectl rollout status deployment/promotions-api", why: "Wait for the rollback to finish, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What crashed promotions-api?",
    options: [
      "The Redis cache was down, so discount lookups threw on every checkout",
      "v2.18.0 cast cached discounts to Long, but they came back as Integer",
      "Coupon stacking made checkouts too slow for the readiness probe",
      "The coupon email traffic exceeded what three pods can serve",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v2.18.0 read discount amounts from a JSON cache and cast them to Long; the JSON parser returns small numbers as Integer.",
      why: "Every discount under 2^31 came back as an Integer, so the cast threw on the first checkout with a coupon, which during the evening push was nearly all of them. The process died and restarted into the same crash. Rolling back removed the cast.",
      tell: "CrashLoopBackOff right after v2.18.0, and each pod's last line was 'class java.lang.Integer cannot be cast to class java.lang.Long'.",
    },
  },
});

const rateCacheHeap = incident({
  id: "infra-t1-rate-cache-heap",
  title: "Shipping quotes come and go",
  severity: "SEV2",
  service: "shipping-api",
  briefing:
    "Since shipping-api v5.3.0 went out this morning, checkout fails in bursts every minute or two, then recovers. Nothing else changed. You have kubectl on the prod bastion and Priya on the call.",
  roleBriefing: "shipping-api quotes delivery on every POST /checkout. Its pods disappear one at a time. Find out how they're dying.",
  opensAtSecondOfDay: 10 * 3600 + 49 * 60,
  cluster: {
    revisions: [
      { number: 88, tag: "v5.2.6", changeCause: "v5.2.6 DHL Express service levels", traits: [] },
      {
        number: 89,
        tag: "v5.3.0",
        changeCause: "v5.3.0 memoize carrier quotes by cart hash",
        traits: [
          diesWhileServing(
            { reason: "OOMKilled", exitCode: 137 },
            "[1834.502s][info][gc] GC(2291) Pause Full (G1 Compaction Pause) 1019M->1017M(1024M) 1611.877ms",
            30,
            40,
          ),
        ],
      },
    ],
    revision: 89,
    replicas: 3,
    podsStartedAgo: 40,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 120,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — shipping-api 5xx > 10% (flapping). Assigned to you." },
    { at: 15, from: MENTOR, text: "Bursts mean pods dropping one at a time. kubectl describe pods shows how each container last died." },
    { at: 55, from: MENTOR, text: "OOMKilled, exit 137: the kernel killed it for passing its memory limit. Something in the new build keeps growing." },
    { at: 85, from: "Kofi Mensah · Fulfilment", text: "v5.3.0 caches quotes by cart hash so we stop paying per carrier call. No eviction yet, it was on the list." },
    { at: 115, from: MENTOR, text: "Restarting just resets the clock. kubectl rollout undo deployment/shipping-api takes the cache away." },
    { at: 240, from: "Maya Okonkwo · Support", text: "Customers say delivery options vanish and come back when they refresh." },
  ],
  hints: [
    "It fails in waves. Watch which pods go away between them, and when.",
    "A pod’s description remembers how its last container ended.",
    "Something in the newest build grows until the pod can’t hold it. Fresh pods only buy a minute.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl top pods"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Restarts tick up on one pod, then another: they die in turn, not together." },
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: OOMKilled, Exit Code: 137, against a 1Gi limit." },
      { command: "kubectl logs deployment/shipping-api", why: "Full GC pauses with the heap at 1019M of 1024M just before each kill." },
      { command: "kubectl rollout undo deployment/shipping-api", why: "v5.2.6 has no unbounded quote cache." },
      { command: "kubectl rollout status deployment/shipping-api", why: "Wait for the rollout to finish, then declare resolved and watch it stay flat." },
    ],
  },
  postmortem: {
    question: "Why did shipping-api's pods keep dying?",
    options: [
      "The carrier APIs timed out and the pods gave up waiting on them",
      "v5.3.0's quote cache never evicted, so each pod hit its memory limit",
      "The readiness probe was too strict for slow carrier calls",
      "Kubernetes kept evicting the pods from a node that was running short of disk",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v5.3.0 memoized every carrier quote by cart hash with no size limit or expiry.",
      why: "Each distinct cart added an entry, so the heap filled until garbage collection couldn't free anything and the container passed its 1Gi limit; the kernel killed it with exit code 137. Pods started at different times, so they died one by one and checkout failed in waves. Rolling back removed the cache.",
      tell: "kubectl describe pod showed Reason: OOMKilled, Exit Code: 137, and the last log lines were full G1 pauses with the heap at 1019M of 1024M.",
    },
  },
});

const receiptFontsOom = incident({
  id: "infra-t1-receipt-fonts-oom",
  title: "Receipts knock pods over at the evening peak",
  severity: "SEV2",
  service: "receipts-api",
  briefing:
    "receipts-api renders the PDF receipt for each order as checkout finishes. Since v1.14.0 shipped this afternoon, its pods die every half minute or so at the evening peak. You have kubectl on the prod bastion and Priya on the call.",
  roleBriefing: "receipts-api renders a receipt inside every POST /checkout. Its pods keep getting killed. Find out by what.",
  opensAtSecondOfDay: 20 * 3600 + 11 * 60,
  cluster: {
    revisions: [
      { number: 26, tag: "v1.13.5", changeCause: "v1.13.5 VAT line per item on receipts", traits: [] },
      {
        number: 27,
        tag: "v1.14.0",
        changeCause: "v1.14.0 embed brand fonts in PDF receipts",
        traits: [
          diesWhileServing(
            { reason: "OOMKilled", exitCode: 137 },
            "ReceiptRenderer - rendering order=ord_5512093 embedded_fonts=4 (37.9 MB per render) concurrent_renders=24 heap_used=1003M/1024M",
            18,
            30,
          ),
        ],
      },
    ],
    revision: 27,
    replicas: 3,
    podsStartedAgo: 30,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 160,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — receipts-api 5xx > 10% (flapping). Assigned to you." },
    { at: 15, from: MENTOR, text: "Pods vanishing without an exception in the logs? kubectl describe pods. Look at Last State." },
    { at: 50, from: "Rosa Lindqvist · Brand", text: "We finally got our own typeface into the receipts today! Four weights." },
    { at: 80, from: MENTOR, text: "OOMKilled, 137. Each render carries 38 MB of fonts and the peak runs two dozen at once. That's the 1Gi limit." },
    { at: 110, from: MENTOR, text: "Back to the build without them: kubectl rollout undo deployment/receipts-api. Subset the fonts and try again tomorrow." },
    { at: 235, from: "Elena Ruiz · VP Engineering", text: "Evening peak is our best hour. What's happening with checkout?" },
  ],
  hints: [
    "Pods die one at a time, and nothing obvious is thrown. Ask Kubernetes how each one ended.",
    "The last thing each pod logs says how much memory a single receipt takes now.",
    "The release before today’s rendered receipts with system fonts and never came near its limit.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl get events"] },
  solution: {
    infrastructure: [
      { command: "kubectl get events", why: "BackOff events tagged OOMKilled, one pod after another." },
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: OOMKilled, Exit Code: 137." },
      { command: "kubectl logs deployment/receipts-api", why: "Each render now embeds 37.9 MB of fonts, two dozen at a time, against a 1Gi heap." },
      { command: "kubectl rollout undo deployment/receipts-api", why: "v1.13.5 renders with system fonts and stays well under the limit." },
      { command: "kubectl rollout status deployment/receipts-api", why: "Wait for the rollback to finish, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What killed receipts-api's pods at the peak?",
    options: [
      "A memory leak in the PDF library that grew a little with every receipt rendered",
      "Embedding four full fonts per render pushed concurrent renders over 1Gi",
      "The node ran out of CPU and the kubelet evicted them",
      "orders-db was slow to return order lines for the receipts",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v1.14.0 embedded four full brand font files, about 38 MB, in every receipt render.",
      why: "At the evening peak each pod renders around two dozen receipts at once. Two dozen times 38 MB is most of the 1Gi limit before anything else, so the container went over and the kernel killed it (exit code 137). It isn't a slow leak: each pod dies as soon as concurrency peaks. Rolling back to system fonts brought memory back down.",
      tell: "OOMKilled with Exit Code 137 in kubectl describe pod, and the renderer's last line showing 37.9 MB per render at 24 concurrent renders.",
    },
  },
});

const walletBalanceLeak = incident({
  id: "infra-t1-wallet-balance-leak",
  title: "Wallet payments drain the pool",
  severity: "SEV2",
  service: "wallet-api",
  briefing:
    "wallet-api v4.2.0 went out an hour ago. Checkout errors started small and keep climbing, pod by pod. stored-value-gateway is slower than usual today. You have kubectl, psql and curl on the prod bastion.",
  roleBriefing: "wallet-api handles store-credit and gift balance on POST /checkout. Errors grow over time without any crash. Find out what's running out.",
  opensAtSecondOfDay: 11 * 3600 + 5 * 60,
  cluster: {
    revisions: [
      { number: 70, tag: "v4.1.3", changeCause: "v4.1.3 balance cache TTL to 30s", traits: [] },
      { number: 71, tag: "v4.2.0", changeCause: "v4.2.0 async balance hold before capture", traits: [leaksOn("stored-value-gateway", 0.045)] },
    ],
    revision: 71,
    replicas: 3,
    podsStartedAgo: 3_400,
    startingLeak: [20, 15, 9],
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 250,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — wallet-api 5xx > 25% and rising. Assigned to you." },
    { at: 15, from: MENTOR, text: "No restarts, traffic flat, errors climbing? Read a pod's log and see what it's waiting for." },
    { at: 50, from: "Chen Wei · Wallet", text: "stored-value-gateway status page: elevated latency. Probably them?" },
    { at: 80, from: MENTOR, text: "Hikari says all 20 busy, but ask Postgres: if those sessions are idle, something borrowed them and never gave them back." },
    { at: 115, from: MENTOR, text: "Slow gateways happen; the old build survived them. The new one leaks on every timeout. kubectl rollout undo deployment/wallet-api." },
    { at: 160, from: "PagerDuty", text: "wallet-api 5xx now above 50%." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "Gift card customers are stuck. What's the ETA?" },
  ],
  hints: [
    "Nothing restarts and traffic is flat, but errors climb pod by pod. Something inside them is running out.",
    "Compare what the app thinks its connections are doing with what the database says they are doing.",
    "The slow partner is a trigger, not the cause: the build before this one rode out the same slowness.",
  ],
  suggestions: {
    infrastructure: [
      "kubectl logs deployment/wallet-api",
      "curl -s http://wallet-api:8080/actuator/metrics/hikaricp.connections.active",
      'psql -c "select state, count(*) from pg_stat_activity group by state"',
    ],
  },
  solution: {
    infrastructure: [
      { command: "kubectl logs deployment/wallet-api", why: "HikariPool: total=20, active=20, idle=0, and stored-value-gateway timeouts just before each step down." },
      { command: 'psql -c "select state, count(*) from pg_stat_activity group by state"', why: "Postgres sees most of those connections as idle: borrowed and never returned." },
      { command: "kubectl rollout history deployment/wallet-api", why: "v4.2.0 added the async balance hold; v4.1.3 didn't leak." },
      { command: "kubectl rollout undo deployment/wallet-api", why: "Removes the leak. A restart would empty the pools only for them to drain again." },
      { command: "kubectl rollout status deployment/wallet-api", why: "Wait for every pod on the old build, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did wallet-api run out of database connections?",
    options: [
      "stored-value-gateway's latency made wallet-api's own queries slow down",
      "v4.2.0 never returned its connection when a gateway call timed out",
      "orders-db's max_connections was too low for three pods",
      "A pool of 20 per pod was too small for the lunchtime traffic",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v4.2.0's async balance hold borrowed a pooled connection and lost it whenever the stored-value-gateway call timed out.",
      why: "The timeout threw before the connection was closed, so it stayed checked out forever. With the gateway slow, each pod stranded connections one by one until all 20 were gone, then failed everything it was sent. Postgres saw those sessions as idle because nothing was using them. Rolling back removed the leak; the old build rode out the same latency.",
      tell: "Hikari reported active=20, idle=0 while Postgres showed the sessions idle, traffic was flat, and gateway timeout warnings lined up with each step down.",
    },
  },
});

const pspAdapterLeak = incident({
  id: "infra-t1-psp-adapter-leak",
  title: "Order router starves pod by pod",
  severity: "SEV2",
  service: "order-router",
  briefing:
    "order-router v7.7.0 went out after lunch. One pod already fails everything it gets, and a second is heading the same way. psp-adapter has been timing out a few calls an hour all week. You have kubectl, psql and curl on the prod bastion.",
  roleBriefing: "order-router sends every POST /checkout to the right payment provider. One pod fails all its requests and nothing crashes. Find out why.",
  opensAtSecondOfDay: 14 * 3600 + 32 * 60,
  cluster: {
    revisions: [
      { number: 95, tag: "v7.6.1", changeCause: "v7.6.1 route Klarna by basket size", traits: [] },
      { number: 96, tag: "v7.7.0", changeCause: "v7.7.0 non-blocking HTTP client for psp-adapter", traits: [leaksOn("psp-adapter", 0.05)] },
    ],
    revision: 96,
    replicas: 3,
    podsStartedAgo: 2_600,
    startingLeak: [20, 12, 11],
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 250,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — order-router 5xx > 25% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "One pod failing everything while the others are fine: ask it about its database pool. The actuator will tell you." },
    { at: 55, from: "Marta Kowalczyk · Payments routing", text: "v7.7.0 swaps the psp-adapter client for the non-blocking one. Cancellation handling was the tricky bit." },
    { at: 90, from: MENTOR, text: "Pool full, Postgres says idle. That's a leak, and it started with v7.7.0. kubectl rollout undo deployment/order-router." },
    { at: 150, from: "PagerDuty", text: "order-router 5xx above 60%." },
    { at: 230, from: "Elena Ruiz · VP Engineering", text: "Order routing is a single point of failure. Status?" },
  ],
  hints: [
    "One pod fails everything and the others don't, yet none of them restart. Ask a pod about its database pool.",
    "The database can tell you whether the connections the app holds are actually doing anything.",
    "It started with the newest release. Fresh pods just start draining again.",
  ],
  suggestions: {
    infrastructure: [
      "curl -s http://order-router:8080/actuator/health",
      "kubectl logs deployment/order-router",
      'psql -c "select pid, application_name, state from pg_stat_activity"',
    ],
  },
  solution: {
    infrastructure: [
      { command: "curl -s http://order-router:8080/actuator/metrics/hikaricp.connections.active", why: "The pool is at or near its max of 20 even though traffic is flat." },
      { command: 'psql -c "select pid, application_name, state from pg_stat_activity"', why: "order-router sessions sit idle for minutes: borrowed, never returned." },
      { command: "kubectl rollout history deployment/order-router", why: "v7.7.0 swapped in the non-blocking psp-adapter client." },
      { command: "kubectl rollout undo deployment/order-router", why: "v7.6.1 closes its connection when a psp-adapter call times out." },
      { command: "kubectl rollout status deployment/order-router", why: "Wait for every pod on v7.6.1, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What emptied order-router's connection pools?",
    options: [
      "A spike in checkout traffic after lunch used every connection",
      "v7.7.0 kept a connection checked out after each psp-adapter timeout",
      "psp-adapter held the database connections open on its side",
      "orders-db had a long-running vacuum that blocked new sessions from opening",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v7.7.0's non-blocking psp-adapter client cancelled timed-out calls without releasing the database connection the request held.",
      why: "psp-adapter times out a handful of calls an hour, as it always has. Each timeout now stranded one pooled connection; a pod with all 20 stranded fails every request it gets, and its share falls on the others. Postgres saw the stranded sessions as idle. Rolling back to v7.6.1 removed the leak.",
      tell: "Pool at its max with flat traffic, Postgres listing order-router sessions idle for minutes, and the worst pod being the oldest one.",
    },
  },
});

const libpostalSegfault = incident({
  id: "infra-t1-libpostal-segfault",
  title: "Address checks crash the JVM",
  severity: "SEV2",
  service: "address-api",
  briefing:
    "address-api upgraded its address-parsing library in v3.0.0 this morning. Since then its pods drop one at a time and checkout fails in bursts. You have kubectl on the prod bastion; Priya is on the call.",
  roleBriefing: "address-api normalizes the shipping address on every POST /checkout. Its pods die every so often with no Java exception. Find out how.",
  opensAtSecondOfDay: 9 * 3600 + 52 * 60,
  cluster: {
    revisions: [
      { number: 44, tag: "v2.9.7", changeCause: "v2.9.7 Irish Eircode validation", traits: [] },
      {
        number: 45,
        tag: "v3.0.0",
        changeCause: "v3.0.0 jpostal 1.2 (libpostal native upgrade)",
        traits: [diesWhileServing({ reason: "Error", exitCode: 134 }, "#  SIGSEGV (0xb) at pc=0x00007f3a1c2d41e0, pid=1, tid=87", 20, 35)],
      },
    ],
    revision: 45,
    replicas: 3,
    podsStartedAgo: 40,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 140,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — address-api 5xx > 10% (flapping). Assigned to you." },
    { at: 15, from: MENTOR, text: "Bursts usually mean pods dying in turn. Check restarts, then what each one said last." },
    { at: 55, from: MENTOR, text: "SIGSEGV and exit 134: the JVM itself crashed, inside native code. Java can't catch that." },
    { at: 85, from: "Sven Larsen · Address platform", text: "v3.0.0 bumps jpostal to the new libpostal build. Our tests only use the sample addresses…" },
    { at: 115, from: MENTOR, text: "A native crash after a native upgrade: kubectl rollout undo deployment/address-api, then let them reproduce it with real addresses." },
    { at: 240, from: "Maya Okonkwo · Support", text: "Customers say 'checking your address' spins, then works on retry." },
  ],
  hints: [
    "The failures come in bursts. See which pods go away between them.",
    "There’s no Java stack trace. Look at the very last line a dying pod writes, and its exit code.",
    "The newest release swapped a native library; the release before it parsed the same addresses fine.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl describe pods", "kubectl logs deployment/address-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Restarts climbing one pod at a time." },
      { command: "kubectl describe pods", why: "Last State: Terminated, Reason: Error, Exit Code: 134: the process aborted, not an OOM." },
      { command: "kubectl logs deployment/address-api", why: "The JVM's fatal error banner: SIGSEGV in native code." },
      { command: "kubectl rollout undo deployment/address-api", why: "v2.9.7 runs the libpostal build that never crashed." },
      { command: "kubectl rollout status deployment/address-api", why: "Wait for the rollback to finish, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did address-api's pods keep dying?",
    options: [
      "They ran out of memory loading the larger address model",
      "The new native libpostal build segfaulted on some real addresses",
      "A Java exception in Eircode validation killed the request threads",
      "The liveness probe timed out while addresses were being parsed",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v3.0.0 upgraded jpostal to a libpostal native build that segfaults on certain real-world addresses.",
      why: "A SIGSEGV in native code takes down the whole JVM, which writes its fatal error banner and aborts (exit code 134). Each pod lived until it parsed one of those addresses, so they died in turn and checkout failed in bursts. It wasn't memory: Reason was Error, not OOMKilled. Rolling back restored the old native build.",
      tell: "Exit Code 134 with Reason: Error in kubectl describe pod, and the last log line was the JVM's '#  SIGSEGV (0xb) at pc=…' banner.",
    },
  },
});

const giftcardNoSuchMethod = incident({
  id: "infra-t1-giftcard-nosuchmethod",
  title: "Gift cards break on a library bump",
  severity: "SEV2",
  service: "giftcard-api",
  briefing:
    "giftcard-api v2.5.0 went out at 17:40, a routine dependency bump. Its pods died within seconds of their first checkout and have been restarting since. You have kubectl on the prod bastion and Priya on the call.",
  roleBriefing: "giftcard-api redeems balances on every POST /checkout. It's crash-looping after a dependency bump. Find out why.",
  opensAtSecondOfDay: 17 * 3600 + 47 * 60,
  cluster: {
    revisions: [
      { number: 33, tag: "v2.4.9", changeCause: "v2.4.9 mask card numbers in logs", traits: [] },
      {
        number: 34,
        tag: "v2.5.0",
        changeCause: "v2.5.0 bump dependencies (renovate #812)",
        traits: [
          crashesOnCheckout(
            "Exception in thread \"http-nio-8080-exec-2\" java.lang.NoSuchMethodError: 'void com.marlow.payments.client.ChargeRequest.setCurrency(java.lang.String)'",
            3,
            4,
          ),
        ],
      },
    ],
    revision: 34,
    replicas: 3,
    podsStartedAgo: 40,
  },
  fix: { kind: "rollback" },
  lostCheckoutsPerPoint: 400,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — giftcard-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: MENTOR, text: "Pods first: STATUS and RESTARTS. Then the last line one of them wrote." },
    { at: 50, from: "Ada Obi · Gift cards", text: "It was only a Renovate PR. CI was green, it compiled fine." },
    { at: 85, from: MENTOR, text: "NoSuchMethodError compiles fine and fails at runtime: two library versions disagree. Roll back: kubectl rollout undo deployment/giftcard-api." },
    { at: 130, from: "Ada Obi · Gift cards", text: "payments-client went 3.x to 4.0 transitively. setCurrency takes a Currency now, not a String." },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Holiday gift card sales are failing. Where are we?" },
  ],
  hints: [
    "The pods are there but keep restarting. Check how often.",
    "The crash names the exact method the code expected to find.",
    "The previous release, before the dependency bump, redeemed cards all week.",
  ],
  suggestions: { infrastructure: ["kubectl get pods", "kubectl logs deployment/giftcard-api", "kubectl describe deployment/giftcard-api"] },
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "CrashLoopBackOff across all three pods." },
      { command: "kubectl logs deployment/giftcard-api", why: "NoSuchMethodError for ChargeRequest.setCurrency(String): the library on the classpath doesn't have that method." },
      { command: "kubectl rollout history deployment/giftcard-api", why: "v2.5.0 is the Renovate dependency bump; v2.4.9 was healthy." },
      { command: "kubectl rollout undo deployment/giftcard-api", why: "v2.4.9 ships the payments-client version its code was built against." },
      { command: "kubectl rollout status deployment/giftcard-api", why: "Wait for the old build everywhere, then declare resolved." },
    ],
  },
  postmortem: {
    question: "Why did giftcard-api v2.5.0 crash on checkout?",
    options: [
      "The payments service it calls changed its API that afternoon",
      "A transitive bump changed a method the code still called the old way",
      "Card-number masking threw on gift card codes",
      "Its pods couldn't reach orders-db after the dependency bump changed the JDBC driver",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The dependency bump pulled payments-client 4.0 in transitively, where ChargeRequest.setCurrency takes a Currency instead of a String.",
      why: "The code that calls setCurrency(String) lives in another library compiled against 3.x, so the build still compiled. At runtime the JVM looked for the String version, couldn't find it, and threw NoSuchMethodError on the first checkout, killing the process. Rolling back restored the matching version.",
      tell: "CrashLoopBackOff right after a dependency-only release, and each pod's last line was NoSuchMethodError naming ChargeRequest.setCurrency(java.lang.String).",
    },
  },
});

/** Infrastructure's guided tier: one cause each, found with kubectl, psql or curl, fixed with one move. */
export const INFRA_TIER1_INCIDENTS: readonly Scenario[] = [
  rightsizerWeekend,
  canaryScaleTypo,
  maintenanceLeftDown,
  taxRateNpe,
  missingSecretPlaceholder,
  flywayChecksum,
  couponClassCast,
  rateCacheHeap,
  receiptFontsOom,
  walletBalanceLeak,
  pspAdapterLeak,
  libpostalSegfault,
  giftcardNoSuchMethod,
];
