import { seededRandom } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import { isLive, revisionOf, templateHash, type ClusterState, type Deployment, type Pod } from "../sim/model.ts";

const DEPLOYMENT = "checkout-api";
const WARM_UP_SECONDS = 30;

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
        leaksPerSecondAtBaseline: 0.05,
        perPodBaselineRps: 100,
      },
    ],
  },
];

function initialState(): ClusterState {
  const hash = templateHash(DEPLOYMENT, 7, 0);
  const startingLeak = [20, 13, 7];
  const pods: Pod[] = startingLeak.map((leaked, index) => ({
    name: podName(DEPLOYMENT, hash, index + 1),
    templateHash: hash,
    revision: 7,
    phase: "Running",
    startedAt: -5_100 - index * 40,
    phaseLeft: 0,
    leaked,
    restarts: 0,
    connectionHistory: [],
  }));

  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [{ name: DEPLOYMENT, replicas: 3, poolSize: 20, revision: 7, generation: 0, revisions, pods }],
    database: { name: "orders-db", host: "orders-db.internal", maxConnections: 100, reservedConnections: 3 },
    traffic: { requestsPerSecond: 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 },
    logs: {},
    events: [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: pods.length,
  };
  // Run the outage up to the moment the page fires, so logs and graphs already have history.
  const random = seededRandom("checkout-pool-leak:warm-up");
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

export const checkoutPoolLeak: Scenario = {
  id: "checkout-pool-leak",
  title: "Checkout is timing out",
  tier: 3,
  severity: "SEV2",
  service: DEPLOYMENT,
  briefing:
    "PagerDuty woke you: checkout-api 5xx above 5% and climbing. Customers can’t pay. You have a shell on the prod bastion and full kubectl access. Find it, stop the bleeding, and don’t make it worse.",
  roles: ["infrastructure"],
  opensAtSecondOfDay: 10 * 3600 + 17 * 60,
  seed: "checkout-pool-leak",
  initialState,
  isRootCauseFixed: (state) =>
    state.deployments.every((deployment) =>
      deployment.pods.filter(isLive).every((pod) => revisionOf(deployment, pod.revision).traits.length === 0) &&
      revisionOf(deployment, deployment.revision).traits.length === 0,
    ),
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Degraded performance — elevated latency (since 06:40)" },
        { key: "p99 from checkout-api", value: "2.9 s (normal: 180 ms)" },
        { key: "Client timeout", value: "3000 ms × 3 attempts" },
        { key: "Calls timing out", value: "≈3% of charges" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Assigned to you." },
    { at: 40, from: "Maya Okonkwo · Support", text: "Tickets coming in: card form spins forever, some customers retried and got charged twice?" },
    { at: 95, from: "Sam Tan · Eng manager", text: "payment-gateway status page says “degraded latency”. Is this just them?" },
    { at: 170, from: "PagerDuty", text: "Escalated to SEV1 — checkout success rate below 50%." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "What’s the ETA? The autumn campaign email goes out at 10:30." },
  ],
  postmortem: {
    question: "What was the root cause?",
    options: [
      "payment-gateway latency saturated checkout-api’s CPU",
      "v4.12.0’s retry path never returned DB connections",
      "orders-db hit max_connections and refused new sessions",
      "A pool of 20 was too small for the checkout traffic",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v4.12.0 leaked a pooled connection every time a payment-gateway call timed out.",
      why: "The new retry wrapper borrowed a connection, then threw on the third timeout before close() ran. payment-gateway was slow, so each pod stranded connections one by one until all 20 were pinned; readiness then failed and the survivors took more traffic and leaked faster. Restarts only reset the count — rolling back removes the leak.",
      tell: "Hikari reported active=20 while Postgres showed those sessions as plain idle, traffic was flat, and the pool drained in steps that matched payment-gateway timeout warnings.",
    },
  },
};
