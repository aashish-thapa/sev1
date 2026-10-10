import { seededRandom } from "../../domain/random.ts";
import type { Objective, Scenario } from "../scenario.ts";
import { unsafeRetryShare } from "../sim/clients.ts";
import { configValue, findConfig, findFlag, isFlagOn, RETRY_POLICY_NAMES, type Commerce } from "../sim/commerce.ts";
import { blockedShare } from "../sim/edge.ts";
import { podName, step } from "../sim/engine.ts";
import { isLive, revisionOf, templateHash, type ClusterState, type Deployment, type Pod } from "../sim/model.ts";

const DEPLOYMENT = "checkout-api";
/** The sale opened at 10:00:00; the page fires at 10:03:00, once the retry storm has taken hold. */
const WARM_UP_SECONDS = 180;
/** The launch email lands as the sale opens: a minute of demand above what the degraded gateway can take. */
const LAUNCH_SURGE_SECONDS = 45;
const LAUNCH_SURGE_FACTOR = 1.6;
const SALE_RPS = 300;
const HOUR = 3600;
const DAY = 24 * HOUR;

export const RETRY_FLAG = "checkout.auto_retry";
export const RETRY_CONFIG_KEY = "checkout_retry_policy";
export const STUFFING_ALERT = "SEC-4471";

const revisions: Deployment["revisions"] = [
  { number: 5, tag: "v4.10.2", changeCause: "v4.10.2 bump spring-boot to 3.3.4", traits: [] },
  { number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
  {
    number: 7,
    tag: "v4.12.0",
    changeCause: "v4.12.0 retry wrapper for payment-gateway client",
    traits: [
      {
        kind: "leaks-connection-on-dependency-timeout",
        dependency: "payment-gateway",
        leaksPerSecondAtBaseline: 0.0003,
        perPodBaselineRps: 100,
      },
    ],
  },
];

const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const iosUa = (version: string, build: number) => `Marlow/${version} (com.marlow.shop; build:${build}; iOS 18.6.2) Alamofire/5.10.2`;
const androidUa = (version: string) => `Marlow/${version} (Android 15; Pixel 8) okhttp/4.12.0`;

function commerce(): Commerce {
  return {
    platforms: [
      {
        id: "web",
        customerShare: 0.52,
        current: { version: "2026.10.09-2", userAgent: WEB_UA, timeoutMs: 8000, retry: { kind: "flag", key: RETRY_FLAG, whenOn: "immediate", whenOff: "none" } },
        previous: null,
        adoption: 1,
        rollout: { kind: "instant" },
        inReview: null,
      },
      {
        id: "ios",
        customerShare: 0.36,
        current: { version: "7.3.0", userAgent: iosUa("7.3.0", 7301), timeoutMs: 10_000, retry: { kind: "remote-config", key: RETRY_CONFIG_KEY } },
        previous: { version: "7.2.4", userAgent: iosUa("7.2.4", 7244), timeoutMs: 30_000, retry: { kind: "fixed", policy: "none" } },
        adoption: 0.52,
        rollout: { kind: "phased", day: 6, isPaused: false, adoptionPerSecond: 0.0007 / 60 },
        inReview: null,
      },
      {
        id: "android",
        customerShare: 0.12,
        current: { version: "7.2.4", userAgent: androidUa("7.2.4"), timeoutMs: 30_000, retry: { kind: "fixed", policy: "none" } },
        previous: null,
        adoption: 1,
        rollout: { kind: "instant" },
        inReview: "7.3.0",
      },
    ],
    flags: [
      {
        key: RETRY_FLAG,
        description: "Retry POST /checkout automatically when it times out or returns 5xx",
        owner: "team-checkout-web",
        history: [{ at: -19 * HOUR, by: "web-release-bot", from: false, to: true, note: "web 2026.10.09-2 (FE-2291): turn on checkout auto-retry" }],
      },
      {
        key: "checkout.payment_element_v2",
        description: "New card form with inline validation",
        owner: "team-checkout-web",
        history: [{ at: -19 * HOUR, by: "web-release-bot", from: false, to: true, note: "web 2026.10.09-2 (FE-2240)" }],
      },
      {
        key: "checkout.express_pay",
        description: "Apple Pay / Google Pay buttons above the card form",
        owner: "team-checkout-web",
        history: [{ at: -9 * DAY, by: "priya.shah", from: false, to: true, note: "GA after 2-week ramp" }],
      },
      {
        key: "home.sale_banner",
        description: "Autumn Sale hero banner on the home page",
        owner: "team-growth",
        history: [{ at: -6 * 60 - 40, by: "lena.ortiz", from: false, to: true, note: "Autumn Sale go-live" }],
      },
      {
        key: "search.typo_tolerance",
        description: "Fuzzy matching in product search",
        owner: "team-search",
        history: [{ at: -3 * DAY, by: "dev.raman", from: true, to: false, note: "p95 regression, off until SRCH-311" }],
      },
    ],
    remoteConfig: [
      {
        key: RETRY_CONFIG_KEY,
        description: "How the app retries POST /checkout on timeout or 5xx",
        readBy: "ios >= 7.3.0",
        allowed: RETRY_POLICY_NAMES,
        baseVersion: 56,
        history: [{ at: -5 * DAY, by: "release-bot", from: "none", to: "immediate", note: "ios 7.3.0 (MOB-1184): default for new checkout networking layer" }],
      },
      {
        key: "home_banner_campaign",
        description: "Campaign id for the home screen hero",
        readBy: "ios >= 7.0.0, android >= 7.0.0",
        allowed: null,
        baseVersion: 31,
        history: [{ at: -6 * 60 - 40, by: "lena.ortiz", from: "none", to: "autumn-sale-2026", note: "Autumn Sale go-live" }],
      },
      {
        key: "checkout_express_pay_enabled",
        description: "Show Apple Pay / Google Pay on the checkout sheet",
        readBy: "ios >= 7.1.0, android >= 7.1.0",
        allowed: ["true", "false"],
        baseVersion: 12,
        history: [{ at: -40 * DAY, by: "jonah.reyes", from: "false", to: "true", note: "GA" }],
      },
      {
        key: "min_supported_version",
        description: "Builds below this get a blocking update screen",
        readBy: "ios >= 6.0.0, android >= 6.0.0",
        allowed: null,
        baseVersion: 9,
        history: [{ at: -90 * DAY, by: "jonah.reyes", from: "6.8.0", to: "7.0.0", note: "drop iOS 15" }],
      },
    ],
    gateway: { name: "payment-gateway", chargesPerSecond: 94, maxQueueSeconds: 20, baselineTimeoutShare: 0.03, backlog: 0, timeoutShare: 0 },
    wafRules: [
      { id: "r-0001", action: "block", expression: 'ip.src in $tor_exit_nodes and http.request.uri.path eq "/login"', createdAt: -120 * DAY, createdBy: "a.kowalski", customerShare: 0 },
      { id: "r-0002", action: "rate_limit", expression: 'http.request.uri.path eq "/login" (10/1m per ip.src)', createdAt: -120 * DAY, createdBy: "a.kowalski", customerShare: 0 },
    ],
    nextWafRuleNumber: 3,
    alerts: [
      {
        id: "SEC-4466",
        title: "Impossible travel: s.okafor (corporate VPN egress)",
        rule: "idp.impossible_travel",
        severity: "low",
        openedAt: -3 * HOUR,
        autoContainAt: null,
        containTopIps: 0,
        resolution: { disposition: "benign", at: -2 * HOUR - 1500, by: "m.haddad", note: "VPN egress in Frankfurt; confirmed with user" },
      },
      {
        id: STUFFING_ALERT,
        title: "Possible credential stuffing / card testing on POST /checkout",
        rule: "edge.checkout.distributed_post_burst",
        severity: "high",
        openedAt: -55,
        autoContainAt: 400,
        containTopIps: 500,
        resolution: null,
      },
    ],
    ledger: {
      averageOrderCents: 5840,
      paidOrders: 0,
      orphanedCaptures: 0,
      orphanedBySegment: {},
      orphanHistory: [],
      minutes: [],
      refundedCaptures: 0,
      refundBatches: [],
    },
    pulse: { organicCheckoutsPerSecond: 0, checkoutAttemptsPerSecond: 0, blockedPerSecond: 0, gatewayCallsPerSecond: 0, checkoutFailureRate: 0 },
  };
}

function initialState(): ClusterState {
  const hash = templateHash(DEPLOYMENT, 7, 0);
  const startingLeak = [9, 7, 5];
  const pods: Pod[] = startingLeak.map((leaked, index) => ({
    name: podName(DEPLOYMENT, hash, index + 1),
    templateHash: hash,
    revision: 7,
    phase: "Running",
    startedAt: -19 * HOUR - index * 40,
    phaseLeft: 0,
    leaked,
    restarts: 0,
    connectionHistory: [],
  }));

  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [{ name: DEPLOYMENT, replicas: 3, poolSize: 20, revision: 7, generation: 0, revisions, pods }],
    database: { name: "orders-db", host: "orders-db.internal", maxConnections: 100, reservedConnections: 3 },
    traffic: { requestsPerSecond: SALE_RPS, checkoutShare: 0.25, connectionHoldSeconds: 0.015 },
    logs: {},
    events: [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: pods.length,
    commerce: commerce(),
  };
  // Run from the sale opening to the page, so the storm, the logs and the ledger already have history.
  const random = seededRandom("checkout-meltdown:warm-up");
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) {
    const requestsPerSecond = second < LAUNCH_SURGE_SECONDS ? SALE_RPS * LAUNCH_SURGE_FACTOR : SALE_RPS;
    state = step({ ...state, traffic: { ...state.traffic, requestsPerSecond } }, random);
  }
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

function isLeakGone(state: ClusterState): boolean {
  return state.deployments.every(
    (deployment) =>
      deployment.pods.filter(isLive).every((pod) => revisionOf(deployment, pod.revision).traits.length === 0) &&
      revisionOf(deployment, deployment.revision).traits.length === 0,
  );
}

function objectives(state: ClusterState): readonly Objective[] {
  const { commerce } = state;
  if (!commerce) return [];
  const flag = findFlag(commerce, RETRY_FLAG);
  const config = findConfig(commerce, RETRY_CONFIG_KEY);
  const alert = commerce.alerts.find((candidate) => candidate.id === STUFFING_ALERT);
  const disposition = alert?.resolution?.disposition;
  const blocked = blockedShare(commerce.wafRules);
  const owed = Math.floor(commerce.ledger.orphanedCaptures);
  const refunded = commerce.ledger.refundedCaptures;
  return [
    { role: "infrastructure", label: "checkout-api is off the leaking v4.12.0 build", isMet: isLeakGone(state) },
    { role: "frontend", label: `Web auto-retry is off (${RETRY_FLAG})`, isMet: !!flag && !isFlagOn(flag) },
    { role: "mobile", label: `iOS 7.3.0 no longer retries immediately (${RETRY_CONFIG_KEY})`, isMet: !!config && configValue(config) !== "immediate" },
    {
      role: "security",
      label:
        blocked > 0.001
          ? `A WAF rule is blocking ${Math.round(blocked * 100)}% of checkout customers`
          : `${STUFFING_ALERT} closed as ${disposition ?? "—"}, no customers blocked`,
      isMet: (disposition === "benign" || disposition === "false-positive") && blocked <= 0.001,
    },
    {
      role: "data",
      label: `Refunds queued for ${refunded.toLocaleString("en-US")} of ${owed.toLocaleString("en-US")} orphaned charges`,
      isMet: owed > 0 && refunded >= owed * 0.99,
    },
  ];
}

export const checkoutMeltdown: Scenario = {
  id: "checkout-meltdown",
  title: "Checkout meltdown",
  tier: 5,
  severity: "SEV1",
  service: DEPLOYMENT,
  briefing:
    "The Autumn Sale opened at 10:00. Three minutes in, checkout is failing, support says customers are being charged three and four times, and security has a high-severity alert open on the checkout path. Infra, frontend, mobile, security and data are all paged. No single laptop can fix this.",
  roles: ["infrastructure", "frontend", "mobile", "security", "data"],
  teamPlaybook: [
    { role: "frontend", by: "Priya Shah", at: 55, line: "flags set checkout.auto_retry off", says: "Turned off checkout.auto_retry on web — that release was retrying every timeout with no backoff." },
    { role: "infrastructure", by: "Sam Tan", at: 70, line: "kubectl rollout undo deployment/checkout-api", says: "Rolling checkout-api back to v4.11.3. The pool was leaking on gateway timeouts." },
    { role: "mobile", by: "Jonas Weber", at: 80, line: "remote-config set checkout_retry_policy backoff", says: "iOS 7.3 retry policy is now backoff via remote config. Halting the release alone wouldn't have touched installed apps." },
    { role: "security", by: "Lena Park", at: 110, line: "siem resolve SEC-4471 --disposition benign", says: "SEC-4471 is our own customers retrying, not credential stuffing. Closed it before the playbook auto-blocks anyone." },
    { role: "data", by: "Omar Haddad", at: 330, line: "reconcile submit", says: "Refund batch submitted for every orphaned capture. Finance has the list." },
  ],
  roleBriefings: {
    infrastructure:
      "You hold the pager and the prod bastion: kubectl, psql, curl. checkout-api is throwing 5xx and the payment gateway is degraded. You run the incident — pull in the other roles when the evidence points at them.",
    frontend:
      "You own checkout-web. Your laptop has the flags CLI and RUM. Yesterday’s web release changed how the Pay button handles slow responses.",
    mobile:
      "You own the iOS and Android apps: remote-config and releases. iOS 7.3.0 is mid phased release. Remember what you can and can’t take back from phones already in customers’ hands.",
    security:
      "SOC on-call: siem and waf. A high-severity alert fired on POST /checkout and the SOAR playbook will auto-block the top talkers unless someone triages it. Decide what this traffic really is before anything gets blocked.",
    data:
      "Data on-call: warehouse (payments and orders via CDC, ~45 s behind) and reconcile (refund batches for Payments Ops). Finance needs to know which revenue is real and who to refund.",
  },
  opensAtSecondOfDay: 10 * HOUR + WARM_UP_SECONDS,
  seed: "checkout-meltdown",
  initialState,
  // The page opens with checkout already at zero success; even a fast team loses ~20k checkouts while the gateway queue drains.
  lostCheckoutsPerPoint: 1000,
  isRootCauseFixed: (state) => isLeakGone(state) && (!state.commerce || unsafeRetryShare(state.commerce, state.t) < 0.001),
  objectives,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Reduced capacity in us-east — merchants should retry with backoff (since 09:41)" },
        { key: "Throughput for us", value: "≈94 charges/s while degraded; excess queues FIFO" },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
        { key: "Idempotency", value: "Idempotency-Key honoured for 24 h" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx > 10% during the Autumn Sale. #inc-1042 opened; frontend, mobile, security and data on-calls paged." },
    { at: 25, from: "Maya Okonkwo · Support", text: "Phones are melting. Pay button spins, then customers see three or four identical pending charges on their card." },
    { at: 50, from: "Priya Shah · Frontend lead", text: `Web 2026.10.09-2 went out yesterday with auto-retry on the Pay button behind ${RETRY_FLAG}. Frontend on-call: check RUM for /checkout before anyone rolls anything back.` },
    { at: 80, from: "SOC · SIEM", text: `${STUFFING_ALERT} (high): possible credential stuffing / card testing on POST /checkout from 3,140 source IPs. SOAR will auto-contain (block the top 500 IPs) at 10:10 unless someone triages it.` },
    { at: 115, from: "Jonah Reyes · Mobile lead", text: `iOS 7.3.0 is on day 6 of its phased release. It reads ${RETRY_CONFIG_KEY} from remote config and the release bot set it to “immediate”. New App Store reviews: “charged four times”.` },
    { at: 150, from: "Sam Tan · Eng manager", text: "payment-gateway’s TAM says we’re sending three charge attempts for every order we take, on a day their capacity is already reduced. Their advice: back off." },
    { at: 190, from: "Grace Liu · Finance", text: "The revenue dashboard says the sale is way ahead of forecast but paid orders are down. Which is real? I need a refund list before people start filing disputes — each chargeback costs us $15." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "The sale email goes to 2M inboxes at 10:30. What do we need to stop, and who owns it?" },
  ],
  postmortem: {
    question: "What turned a slow payment gateway into a checkout meltdown?",
    options: [
      "A credential-stuffing botnet flooded POST /checkout",
      "Clients retried at once with no backoff or idempotency key",
      "orders-db max_connections was too low for sale traffic",
      "iOS 7.3.0 crashed on the checkout screen",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Web and iOS 7.3.0 retried checkout instantly, without backoff or an idempotency key.",
      why: "The degraded gateway queued calls. Each timeout made the clients send up to three new orders, so the queue grew, more calls timed out, and calls captured after checkout-api gave up became double charges. v4.12.0 leaked a connection on each timeout. Rollback fixed the pool, but the storm held until both clients stopped retrying.",
      tell: "Checkout requests per Pay tap ran near 3–4 on web 2026.10.09-2 and iOS 7.3.0 and 1.0 elsewhere. Sessions were old and logins normal, and orphaned charges had no idempotency key.",
    },
  },
};
