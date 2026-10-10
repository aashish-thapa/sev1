import { seededRandom } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { podName, step } from "../sim/engine.ts";
import { templateHash, type ClusterState, type Deployment, type Pod } from "../sim/model.ts";

const DEPLOYMENT = "checkout-api";
const WARM_UP_SECONDS = 30;
const HOT_INDEX = "orders_customer_status_created_idx";

const revisions: Deployment["revisions"] = [
  { number: 6, tag: "v4.12.0", changeCause: "v4.12.0 retry wrapper for payment-gateway client", traits: [] },
  { number: 7, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
  { number: 8, tag: "v4.13.0", changeCause: "v4.13.0 reuse pending orders on retry (migration 0142: composite orders index)", traits: [] },
];

function initialState(): ClusterState {
  const hash = templateHash(DEPLOYMENT, 8, 0);
  const pods: Pod[] = [0, 1, 2].map((index) => ({
    name: podName(DEPLOYMENT, hash, index + 1),
    templateHash: hash,
    revision: 8,
    phase: "Running",
    startedAt: -1_320 - index * 35,
    phaseLeft: 0,
    leaked: 0,
    restarts: 0,
    connectionHistory: [],
  }));

  let state: ClusterState = {
    t: -WARM_UP_SECONDS,
    deployments: [{ name: DEPLOYMENT, replicas: 3, poolSize: 20, revision: 8, generation: 0, revisions, pods }],
    database: {
      name: "orders-db",
      host: "orders-db.internal",
      maxConnections: 100,
      reservedConnections: 3,
      hotIndex: {
        name: HOT_INDEX,
        definition: "btree (customer_id, status, created_at DESC)",
        query: "SELECT id, total_minor FROM orders WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        isValid: false,
        cacheEviction: 0.06,
        rebuild: null,
      },
    },
    traffic: { requestsPerSecond: 300, checkoutShare: 0.4, connectionHoldSeconds: 0.015 },
    logs: {
      "migrate-0142": [
        { t: -1_400, source: "migrate-0142", level: "INFO", text: `CREATE INDEX CONCURRENTLY ${HOT_INDEX} ON orders (customer_id, status, created_at DESC);` },
        { t: -1_100, source: "migrate-0142", level: "WARN", text: "ERROR:  canceling statement due to statement timeout" },
        { t: -1_100, source: "migrate-0142", level: "INFO", text: "DROP INDEX CONCURRENTLY IF EXISTS orders_customer_id_idx;" },
        { t: -1_099, source: "migrate-0142", level: "INFO", text: "migration 0142 applied (2 statements, 1 warning)" },
      ],
    },
    jobs: [{ name: "migrate-0142", status: "Complete", finishedAt: -1_099, durationSeconds: 301 }],
    events: [],
    series: { errorRate: [], p99Ms: [], dbConnections: [] },
    errorRate: 0,
    failedCheckouts: 0,
    healthyFor: 0,
    crashLoopsCaused: 0,
    sessionsTerminated: 0,
    nameCounter: pods.length,
  };
  // Run the slowdown up to the moment the page fires, so logs and graphs already have history.
  const random = seededRandom("orders-index-invalid:warm-up");
  for (let second = 0; second < WARM_UP_SECONDS; second += 1) state = step(state, random);
  return { ...state, failedCheckouts: 0, crashLoopsCaused: 0 };
}

export const ordersIndexInvalid: Scenario = {
  id: "orders-index-invalid",
  title: "Checkout is crawling",
  severity: "SEV2",
  service: DEPLOYMENT,
  briefing:
    "PagerDuty: checkout-api p99 over 2 s and 5xx climbing since this morning’s deploy. Nothing else changed. You have the prod bastion, kubectl and a psql role on orders-db. Find what’s slow, fix it, and don’t take checkout down while you do.",
  roles: ["infrastructure"],
  opensAtSecondOfDay: 8 * 3600 + 52 * 60,
  seed: "orders-index-invalid",
  initialState,
  isRootCauseFixed: (state) => state.database.hotIndex?.isValid ?? true,
  // The 45 s concurrent rebuild bleeds checkouts however fast the player is, so each point costs more of them.
  lostCheckoutsPerPoint: 300,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api p99 > 2s and 5xx > 5% for 5m. Assigned to you." },
    { at: 35, from: "Sam Tan · Eng manager", text: "v4.13.0 went out at 08:30. Roll it back?" },
    { at: 110, from: "Maya Okonkwo · Support", text: "Customers say the pay button spins for ages, then errors. A few got through on the second try." },
    { at: 190, from: "PagerDuty", text: "Escalated to SEV1 — checkout success rate below 60%." },
    { at: 270, from: "Elena Ruiz · VP Engineering", text: "Breakfast promo emails land at 09:15. Where are we?" },
  ],
  postmortem: {
    question: "What was the root cause?",
    options: [
      "v4.13.0’s retry path held connections open across gateway calls",
      "Migration 0142’s new index failed to build, and the old one was dropped anyway",
      "orders-db ran out of max_connections when the deploy rolled",
      "Autovacuum fell behind and bloated the orders table",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Migration 0142 left the new orders index INVALID after its CREATE INDEX CONCURRENTLY hit statement_timeout, then dropped the index checkout had been using.",
      why: "Postgres never uses an invalid index, so checkout's pending-order lookup seq-scanned 4M rows. Each scan held a pooled connection for half a second and climbed toward two as the scans pushed the hot set out of shared_buffers, until every pod's pool of 20 was busy and requests timed out. Rolling back the app changes nothing: the schema stays as the migration left it. REINDEX CONCURRENTLY rebuilds the index without blocking writes; a plain REINDEX also works but locks orders against writes until it finishes.",
      tell: "pg_stat_activity showed dozens of active sessions running one statement, not idle ones. EXPLAIN showed a Seq Scan, \\d orders marked the index INVALID, and the migration log had a statement timeout followed by a DROP.",
    },
  },
};
