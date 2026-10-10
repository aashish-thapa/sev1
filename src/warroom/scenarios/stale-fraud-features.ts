import type { Scenario } from "../scenario.ts";
import { isFeatureStale } from "../sim/fraud.ts";
import type { ClusterState, LogEntry } from "../sim/model.ts";
import { airflowCompact, airflowLine, type AirflowLevel } from "../shell/commands/pipelines.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, FRAUD_MODEL, fraudScorer, lastQuarterHour, scorerOf } from "./fraud-scorer.ts";

const SEED = "stale-fraud-features";
const HOUR = 3600;
const DAY = 24 * HOUR;
/** The decline monitor pages at 08:40, as the morning rush starts. */
const OPENS_AT = 8 * HOUR + 40 * 60;
export const FEATURE_DAG = "features_customer_daily";
const ORDERS_FEATURE = "customer_orders_90d";
/** Last night's 02:00 run gave up on its third attempt at 02:10:07. */
const FAILED_ATTEMPT_AT = 2 * HOUR + 10 * 60 + 7 - OPENS_AT;
const ORDERS_TASK = `build_${ORDERS_FEATURE}`;
const SCHEDULED_RUN = "scheduled__2026-10-09T02:00:00+00:00";
/** The feature SQL as it ran last night, still on the column migration 0147 renamed. */
const FEATURE_SQL = [
  "insert into features.customer_daily (customer_id, customer_orders_90d, as_of)",
  "select o.customer_id, count(*), current_date",
  "from orders.orders o",
  "where o.status = 'paid'",
  "  and o.placed_at >= current_date - 90",
  "group by o.customer_id",
].join("\n");
const FAILING_LINE = "  and o.placed_at >= current_date - 90";

/** The failed task's log: Airflow 2.10 lines, and psycopg2 raising Postgres's missing-column error with libpq's LINE and caret. */
function failedRunLog(): readonly LogEntry[] {
  const entry = (offset: number, origin: string, level: AirflowLevel, message: string): LogEntry => ({
    t: FAILED_ATTEMPT_AT + offset,
    source: FEATURE_DAG,
    level: level === "ERROR" ? "ERROR" : "INFO",
    text: airflowLine(OPENS_AT, FAILED_ATTEMPT_AT + offset, origin, level, message),
  });
  const caret = `${" ".repeat("LINE 5: ".length + FAILING_LINE.indexOf("o.placed_at"))}^`;
  return [
    entry(0, "taskinstance.py:2867", "INFO", "Starting attempt 3 of 3"),
    entry(0, "standard_task_runner.py:72", "INFO", "Started process 48211 to run task"),
    entry(1, "task_command.py:467", "INFO", `Running <TaskInstance: ${FEATURE_DAG}.${ORDERS_TASK} ${SCHEDULED_RUN} [running]> on host airflow-worker-0.airflow-worker.data.svc.cluster.local`),
    entry(2, "sql.py:282", "INFO", `Executing: ${FEATURE_SQL}`),
    entry(2, "sql.py:509", "INFO", `Running statement: ${FEATURE_SQL}, parameters: None`),
    entry(
      3,
      "taskinstance.py:3313",
      "ERROR",
      [
        "Task failed with exception",
        "Traceback (most recent call last):",
        '  File "/home/airflow/.local/lib/python3.12/site-packages/airflow/providers/common/sql/hooks/sql.py", line 514, in _run_command',
        "    cur.execute(sql_statement)",
        "psycopg2.errors.UndefinedColumn: column o.placed_at does not exist",
        `LINE 5: ${FAILING_LINE}`,
        caret,
        'HINT:  Perhaps you meant to reference the column "o.updated_at".',
        // libpq ends the message with a newline and Python's traceback adds its own.
        "",
      ].join("\n"),
    ),
    entry(
      3,
      "taskinstance.py:1226",
      "INFO",
      `Marking task as FAILED. dag_id=${FEATURE_DAG}, task_id=${ORDERS_TASK}, run_id=${SCHEDULED_RUN}, execution_date=20261009T020000, start_date=${airflowCompact(OPENS_AT, FAILED_ATTEMPT_AT)}, end_date=${airflowCompact(OPENS_AT, FAILED_ATTEMPT_AT + 3)}`,
    ),
    entry(4, "local_task_job_runner.py:266", "INFO", "Task exited with return code 1"),
    entry(4, "taskinstance.py:3901", "INFO", "0 downstream tasks scheduled from follow-on schedule check"),
  ];
}

function initialState(): ClusterState {
  const state = checkoutCluster({
    seed: SEED,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({
      gateway: { chargesPerSecond: 150 },
      fraud: fraudScorer({
        versions: [
          { version: "v12", deployedAt: -15 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.98 },
          { version: "v13", deployedAt: -8 * DAY, note: "weekly retrain", falseDeclineShare: 0.005, catchShare: 0.985 },
          { version: "v14", deployedAt: -16 * HOUR - 35 * 60, note: "weekly retrain", falseDeclineShare: 0.005, catchShare: 0.99 },
        ],
        active: "v14",
        features: [
          // Yesterday's run finished the orders task at 02:40, and the refunds task (which waits for the 06:30 refunds export) at 06:44.
          { name: ORDERS_FEATURE, pipeline: FEATURE_DAG, lastSuccessAt: -30 * HOUR, refresh: null },
          { name: "customer_refunds_90d", pipeline: FEATURE_DAG, lastSuccessAt: -26 * HOUR + 4 * 60, refresh: null },
          { name: "device_age_days", pipeline: "features_device_daily", lastSuccessAt: -5 * HOUR - 28 * 60, refresh: null },
          { name: "card_bin_velocity_1h", pipeline: "features_card_velocity", lastSuccessAt: -7 * 60, refresh: null },
        ],
        fraudAttemptsPerSecond: 40,
      }),
    }),
  });
  return { ...state, logs: { ...state.logs, [FEATURE_DAG]: failedRunLog() } };
}

/** Declined customers in the last 15 minutes: the order count the scorer was fed, and the one the warehouse holds. */
function declinedCheckouts(state: ClusterState): readonly string[] {
  const window = lastQuarterHour(state);
  const orders = scorerOf(state)?.features.find((feature) => feature.name === ORDERS_FEATURE);
  if (!window || !orders) return [];
  const isStale = isFeatureStale(orders, state.t);
  const rows: [string, number, number][] = [
    ["3+ paid orders", 0.64, 7],
    ["1-2 paid orders", 0.24, 1],
    ["no paid orders", 0.12, 0],
  ];
  return sqlTable(
    ["customer_history", "declined", "orders_90d_scored", "orders_90d_actual"],
    rows.map(([history, share, actual]) => [history, String(Math.round(window.declined * share)), String(isStale ? 0 : actual), String(actual)]),
  );
}

export const staleFraudFeatures: Scenario = {
  id: "stale-fraud-features",
  title: "Every model declines them",
  tier: 4,
  severity: "SEV2",
  service: FRAUD_MODEL,
  briefing:
    "Since early this morning fraud-scorer has been declining loyal customers, and the morning rush is making it worse by the minute. A new model version went out yesterday afternoon. Brand-new accounts sail through. Find out why our best customers look like fraud.",
  roles: ["data"],
  roleBriefings: {
    data: "Data on-call: models (fraud-scorer in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge; whatever the scorer approves goes on to the gateway.",
  },
  opensAtSecondOfDay: OPENS_AT,
  seed: SEED,
  initialState,
  alertMetric: CUSTOMERS_LOST,
  isRootCauseFixed: (state) => {
    const fraud = scorerOf(state);
    return !!fraud && fraud.mode === "enforce" && fraud.features.every((feature) => !isFeatureStale(feature, state.t));
  },
  // Declines run at 1 in 9 customers until the refresh lands a minute after the fix, and double if a second feature goes stale.
  lostCheckoutsPerPoint: 200,
  evidence: [
    { tool: "warehouse", name: "declined-checkouts", description: "Customers fraud-scorer declined in the last 15 min, with the order counts it scored them on", run: declinedCheckouts },
  ],
  suggestions: { data: ["models show fraud-scorer", "models features fraud-scorer", "pipelines list", "warehouse run declined-checkouts", "models rollback fraud-scorer"] },
  externals: [
    {
      id: "payment-gateway",
      status: "ok",
      facts: [
        { key: "Throughput for us", value: "≈150 charges/s contracted; excess queues FIFO" },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
    { at: 30, from: "Maya Okonkwo · Support", text: "Customers with years of orders are being declined. A friend of mine signed up this morning and checked out fine." },
    { at: 75, from: "Dev Raman · ML platform", text: "fraud-scorer v14 went out yesterday at 16:05. Rolling back is one command if it’s the model." },
    { at: 120, from: "Ingrid Solberg · Data eng", text: "Morning. Migration 0147 on orders-db renamed orders.placed_at to created_at yesterday afternoon. I merged the fix for features_customer_daily at 08:10 (DATA-2210); the DAG picks it up tonight at 02:00 as usual." },
    { at: 180, from: "Rina Nakamura · Risk", text: "Reminder that the BIN-attack bots from last week are still at it, about 40 attempts a second. The scorer eats them." },
    { at: 260, from: "Jonah Reyes · Product", text: "Can we switch fraud checks off until this is sorted? Every decline is a customer we’ll never see again." },
    { at: 360, from: "Elena Ruiz · VP Engineering", text: "Declines doubled in the last few minutes. What’s going on?" },
  ],
  hints: [
    "Every version of the scorer would decline these customers. Look at what it is fed, not which version it is.",
    "An input that hasn’t refreshed in time is served as if the customer were brand new.",
    "The fix for the failing job is already merged. It just hasn’t run.",
  ],
  solution: {
    data: [
      { command: "models features fraud-scorer", why: "customer_orders_90d last refreshed 30 h ago, past the 26 h guard: every customer is scored as if they’d never ordered. customer_refunds_90d is next." },
      { command: `pipelines logs ${FEATURE_DAG}`, why: "Last night’s run failed: column o.placed_at does not exist. The rename fix merged at 08:10, but the DAG only runs at 02:00." },
      { command: `pipelines run ${FEATURE_DAG}`, why: "Runs the fixed DAG now instead of tonight. Its features refresh in about a minute." },
      { command: "models features fraud-scorer", why: "Watch both customer features go from refreshing to fresh; declines fall back to 0.5% once they do." },
    ],
  },
  postmortem: {
    question: "Why did every version of fraud-scorer decline returning customers?",
    options: [
      "customer_orders_90d went stale after its DAG failed on a renamed column",
      "fraud-scorer v14 was trained on too few returning customers’ orders",
      "Risk lowered the decline threshold overnight to stop the card testers",
      "The card-testing bots overloaded the online feature store with reads",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Migration 0147 renamed orders.placed_at to created_at. Last night’s features_customer_daily run failed on the old name, so customer_orders_90d aged past the scorer’s 26 h freshness guard.",
      why: "Past the guard the scorer serves a feature’s default, 0, the value a brand-new account has. Every returning customer looked like a first order, so every model version declined them, and customer_refunds_90d from the same DAG went stale minutes later. The SQL fix was merged at 08:10, but the DAG only runs at 02:00; a manual run rebuilt both features in a minute. Failing open would have let the card-testing bots through to a gateway with no room for them.",
      tell: "customer_orders_90d was 30 h old and STALE, the DAG log ended in psycopg2.errors.UndefinedColumn: column o.placed_at does not exist, rolling back to v13 changed nothing, and declined customers were scored on 0 orders in 90 days while the warehouse showed several.",
    },
  },
};
