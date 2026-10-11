import type { AlertMetric, CommsMessage, Evidence, EvidenceTool, ExternalService, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { airflowCompact, airflowLine, type AirflowLevel } from "../shell/commands/pipelines.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { pendingRefunds, visibleOrphans } from "../sim/commerce-actions.ts";
import type { FraudFeature, FraudModelVersion, FraudScoring } from "../sim/commerce.ts";
import { activeVersion, isFeatureStale } from "../sim/fraud.ts";
import type { ClusterState, LogEntry } from "../sim/model.ts";
import { checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, fraudScorer, lastQuarterHour, scorerOf } from "./fraud-scorer.ts";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
/** The scorer's freshness guard (sim/fraud.ts): a feature this old at t = 0 goes stale `secondsFromPage` after the page. */
const GUARD = 26 * HOUR;
const goesStaleAt = (secondsFromPage: number) => -GUARD + secondsFromPage;
/** How far off its tuned threshold a scorer may sit and still count as tuned. */
const TUNED_TOLERANCE = 0.05;
const WORKER_HOST = "airflow-worker-0.airflow-worker.data.svc.cluster.local";

/** Tier 4's "fixed": the scorer enforces at its tuned threshold, on a version that turns away few good customers, with every input fresh. */
function isScorerHealthy(state: ClusterState): boolean {
  const fraud = scorerOf(state);
  const version = fraud && activeVersion(fraud);
  return (
    !!fraud &&
    !!version &&
    fraud.mode === "enforce" &&
    Math.abs(fraud.threshold - fraud.tunedThreshold) <= TUNED_TOLERANCE + 1e-9 &&
    version.falseDeclineShare <= 0.01 &&
    fraud.features.every((feature) => !isFeatureStale(feature, state.t))
  );
}

/** The last scheduled run's failed task, as Airflow 2.10 logged it. */
type FailedRun = {
  readonly dag: string;
  readonly feature: string;
  /** Second of the incident (negative: before the page) the last attempt started. */
  readonly at: number;
  readonly runId: string;
  readonly executionDate: string;
  /** The statement that raised; absent when the task died connecting. */
  readonly sql?: string;
  /** The exception as Python printed it, from the class name on. */
  readonly error: readonly string[];
};

/** A refund batch the debrief expects once the gateway queue has drained. */
type RefundObjective = { readonly label: string; readonly maxUnrefundedShare: number };

/** One incident's story and numbers; the builder turns it into a Scenario. */
type Row = {
  readonly id: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly scorer: Pick<FraudScoring, "model" | "versions" | "active" | "features" | "fraudAttemptsPerSecond"> & Partial<FraudScoring>;
  readonly gatewayChargesPerSecond?: number;
  /** Seconds of charges already queued at the gateway when the page fires. */
  readonly gatewayBacklogSeconds?: number;
  readonly failedRun?: FailedRun;
  readonly alertMetric?: AlertMetric;
  readonly refunds?: RefundObjective;
  readonly evidence: readonly Evidence[];
  readonly suggestions: readonly string[];
  readonly lostCheckoutsPerPoint: number;
  readonly externals: readonly ExternalService[];
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function caretUnder(line: string, token: string): string {
  return `${" ".repeat(line.indexOf(token))}^`;
}

function failedRunLog(opensAt: number, run: FailedRun): readonly LogEntry[] {
  const task = `build_${run.feature}`;
  const entry = (offset: number, origin: string, level: AirflowLevel, message: string): LogEntry => ({
    t: run.at + offset,
    source: run.dag,
    level: level === "ERROR" ? "ERROR" : "INFO",
    text: airflowLine(opensAt, run.at + offset, origin, level, message),
  });
  const ranFor = run.sql ? 4 : 1;
  return [
    entry(0, "taskinstance.py:2867", "INFO", "Starting attempt 3 of 3"),
    entry(0, "standard_task_runner.py:72", "INFO", `Started process ${52_000 + (Math.abs(run.at) % 7000)} to run task`),
    entry(1, "task_command.py:467", "INFO", `Running <TaskInstance: ${run.dag}.${task} ${run.runId} [running]> on host ${WORKER_HOST}`),
    ...(run.sql
      ? [entry(2, "sql.py:282", "INFO", `Executing: ${run.sql}`), entry(2, "sql.py:509", "INFO", `Running statement: ${run.sql}, parameters: None`)]
      : []),
    entry(
      ranFor,
      "taskinstance.py:3313",
      "ERROR",
      [
        "Task failed with exception",
        "Traceback (most recent call last):",
        ...(run.sql
          ? ['  File "/home/airflow/.local/lib/python3.12/site-packages/airflow/providers/common/sql/hooks/sql.py", line 514, in _run_command', "    cur.execute(sql_statement)"]
          : ['  File "/home/airflow/.local/lib/python3.12/site-packages/psycopg2/__init__.py", line 122, in connect', "    conn = _connect(dsn, connection_factory=connection_factory, **kwasync)"]),
        ...run.error,
        // libpq ends the message with a newline and Python's traceback adds its own.
        "",
      ].join("\n"),
    ),
    entry(
      ranFor,
      "taskinstance.py:1226",
      "INFO",
      `Marking task as FAILED. dag_id=${run.dag}, task_id=${task}, run_id=${run.runId}, execution_date=${run.executionDate}, start_date=${airflowCompact(opensAt, run.at)}, end_date=${airflowCompact(opensAt, run.at + ranFor)}`,
    ),
    entry(ranFor + 1, "local_task_job_runner.py:266", "INFO", "Task exited with return code 1"),
    entry(ranFor + 1, "taskinstance.py:3901", "INFO", "0 downstream tasks scheduled from follow-on schedule check"),
  ];
}

function initialState(row: Row): ClusterState {
  const charges = row.gatewayChargesPerSecond;
  const state = checkoutCluster({
    seed: row.id,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({
      gateway: { ...(charges ? { chargesPerSecond: charges } : {}), backlog: (charges ?? 0) * (row.gatewayBacklogSeconds ?? 0) },
      fraud: fraudScorer(row.scorer),
    }),
  });
  return row.failedRun ? { ...state, logs: { ...state.logs, [row.failedRun.dag]: failedRunLog(row.opensAt, row.failedRun) } } : state;
}

function unrefundedShare(state: ClusterState): number {
  const { commerce } = state;
  if (!commerce) return 0;
  const visible = visibleOrphans(commerce);
  return visible > 0 ? pendingRefunds(commerce) / visible : 0;
}

function incident(row: Row): Scenario {
  const { refunds } = row;
  const objectives = refunds
    ? (state: ClusterState): readonly Objective[] => [{ role: "data", label: refunds.label, isMet: unrefundedShare(state) <= refunds.maxUnrefundedShare }]
    : undefined;
  return {
    id: row.id,
    tier: 4,
    title: row.title,
    severity: row.severity,
    service: row.scorer.model,
    briefing: row.briefing,
    roles: ["data"],
    roleBriefings: { data: row.roleBriefing },
    opensAtSecondOfDay: row.opensAt,
    seed: row.id,
    initialState: () => initialState(row),
    isRootCauseFixed: isScorerHealthy,
    alertMetric: row.alertMetric ?? CUSTOMERS_LOST,
    ...(objectives ? { objectives } : {}),
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    evidence: row.evidence,
    suggestions: { data: row.suggestions },
    externals: row.externals,
    comms: row.comms,
    hints: row.hints,
    solution: { data: row.solution },
    postmortem: row.postmortem,
  };
}

function view(tool: EvidenceTool, name: string, description: string, run: (state: ClusterState) => readonly string[]): Evidence {
  return { tool, name, description, run };
}

/** The last quarter hour's scoring, or zeros before the shop has a pulse. */
function window(state: ClusterState) {
  return lastQuarterHour(state) ?? { customers: 0, declined: 0, declinedShare: 0, fraudAttempts: 0, fraudApproved: 0 };
}

const isStale = (state: ClusterState, name: string) => {
  const found = scorerOf(state)?.features.find((candidate) => candidate.name === name);
  return !!found && isFeatureStale(found, state.t);
};
const isFailOpen = (state: ClusterState) => scorerOf(state)?.mode === "fail-open";
const n = (value: number) => String(Math.round(value));

const version = (v: string, deployedAt: number, note: string, falseDeclineShare: number, catchShare: number): FraudModelVersion => ({
  version: v,
  deployedAt,
  note,
  falseDeclineShare,
  catchShare,
});
const feature = (name: string, pipeline: string, lastSuccessAt: number): FraudFeature => ({ name, pipeline, lastSuccessAt, refresh: null });

const gatewayOk = (throughput: string): ExternalService => ({
  id: "payment-gateway",
  status: "ok",
  facts: [
    { key: "Status page", value: "All systems operational" },
    { key: "Throughput for us", value: throughput },
    { key: "Declines", value: "Card-network declines normal; the 402s come from our scorer, before any charge" },
  ],
});
const gatewaySlow = (throughput: string): ExternalService => ({
  id: "payment-gateway",
  status: "degraded",
  facts: [
    { key: "Status page", value: "Elevated latency for some merchants" },
    { key: "Throughput for us", value: throughput },
    { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
  ],
});

const PAGE_LOST = "SEV2 triggered — checkout customers lost above 5% for 5m (scorer declines, HTTP 402). Data on-call paged.";
const SCORER_BRIEFING = (model: string) =>
  `Data on-call: models (${model}, the scorer in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge: no 5xx, just a lost customer.`;
const QUEUE_BRIEFING = (model: string, cap: number) =>
  `Data on-call: models (${model}, the scorer in front of the payment gateway), pipelines, the warehouse and reconcile. Whatever the scorer approves goes to the gateway, which caps us at ${cap} charges a second; a call queued past checkout-api’s 3 s timeout fails the customer and is still captured.`;

/** Declined customers by order history: what the scorer was fed for one feature, and what the warehouse holds. */
function scoredVersusActual(state: ClusterState, featureName: string, label: string, rows: readonly (readonly [string, number, number])[]): readonly string[] {
  const w = window(state);
  const stale = isStale(state, featureName);
  return sqlTable(
    ["customer_history", "declined", `${label}_scored`, `${label}_actual`],
    rows.map(([history, share, actual]) => [history, n(w.declined * share), String(stale ? 0 : actual), String(actual)]),
  );
}

// ── 1. Chargebacks moved schemas; the new model version takes the blame ──────────────────────────

const CHARGEBACK_SQL = [
  "insert into features.customer_disputes (customer_id, customer_chargebacks_180d, as_of)",
  "select c.customer_id, count(*), current_date",
  "from disputes.chargebacks c",
  "where c.opened_at >= current_date - 180",
  "group by c.customer_id",
].join("\n");
const CHARGEBACK_FROM = "from disputes.chargebacks c";

const schemaMove = incident({
  id: "data-t4-chargebacks-schema-move",
  title: "The table that moved house",
  severity: "SEV2",
  opensAt: 8 * HOUR + 5 * MINUTE,
  briefing:
    "cart-sentinel has been declining long-standing customers since the early hours, and the decline rate is climbing as the morning picks up. cart-sentinel v27 went out last night. Customers with a clean history are the ones turned away. Find out why.",
  roleBriefing: SCORER_BRIEFING("cart-sentinel"),
  scorer: {
    model: "cart-sentinel",
    versions: [
      version("v25", -16 * DAY, "fortnightly retrain", 0.0045, 0.97),
      version("v26", -9 * DAY, "fortnightly retrain", 0.0048, 0.975),
      version("v27", -11 * HOUR - 20 * MINUTE, "retrain + device_age_days monotonic constraint", 0.005, 0.978),
    ],
    active: "v27",
    features: [
      feature("customer_chargebacks_180d", "features_disputes_daily", -29 * HOUR - 10 * MINUTE),
      feature("customer_disputes_won_180d", "features_disputes_daily", goesStaleAt(4 * MINUTE)),
      feature("device_age_days", "features_device_daily", -4 * HOUR - 12 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -5 * MINUTE),
    ],
    fraudAttemptsPerSecond: 6,
  },
  failedRun: {
    dag: "features_disputes_daily",
    feature: "customer_chargebacks_180d",
    at: 3 * HOUR + 12 * MINUTE + 41 - (8 * HOUR + 5 * MINUTE),
    runId: "scheduled__2026-10-09T03:00:00+00:00",
    executionDate: "20261009T030000",
    sql: CHARGEBACK_SQL,
    error: [
      'psycopg2.errors.UndefinedTable: relation "disputes.chargebacks" does not exist',
      `LINE 3: ${CHARGEBACK_FROM}`,
      caretUnder(`LINE 3: ${CHARGEBACK_FROM}`, "disputes.chargebacks"),
    ],
  },
  evidence: [
    view("warehouse", "declined-clean-history", "Customers cart-sentinel declined in the last 15 min, with the chargeback count it scored them on", (state) => [
      ...scoredVersusActual(state, "customer_chargebacks_180d", "chargebacks_180d_missing", [
        ["5+ orders, 0 chargebacks", 0.71, 0],
        ["1-4 orders, 0 chargebacks", 0.22, 0],
        ["any orders, 1+ chargebacks", 0.07, 0],
      ]),
      isStale(state, "customer_chargebacks_180d")
        ? "chargebacks_180d_missing = 1 means the feature was served as missing; the model treats a missing dispute history as a fresh account."
        : "Every declined customer was scored on a dispute history the warehouse agrees with.",
    ]),
  ],
  suggestions: ["models show cart-sentinel", "models features cart-sentinel", "pipelines list", "warehouse run declined-clean-history"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈170 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Customers who have been with us for years are getting “payment declined”. Their banks never saw an attempt." },
    { at: 70, from: "Dev Raman · ML platform", text: "cart-sentinel v27 went out at 20:45 last night. Only change is a monotonic constraint on device age. Rolling back is cheap if you want to." },
    { at: 150, from: "Hana Kobayashi · Payments eng", text: "FYI we finished the payments schema split yesterday: disputes tables now live under payments.*. The compat views were dropped at 18:00 (PAY-1931)." },
    { at: 230, from: "Ingrid Solberg · Data eng", text: "I pushed the schema rename into features_disputes_daily at 07:40. It’ll pick up tonight at 03:00." },
    { at: 330, from: "Elena Ruiz · VP Engineering", text: "Declines just jumped again. Is this the new model or not?" },
  ],
  hints: [
    "Ask what the scorer was fed, not which version is doing the scoring.",
    "Two inputs come from the same nightly job. One is already past the guard, the other is close.",
    "A fix that is merged but scheduled for tonight hasn’t fixed anything yet.",
  ],
  solution: [
    { command: "models features cart-sentinel", why: "customer_chargebacks_180d is 29 h old and STALE; customer_disputes_won_180d from the same DAG crosses the guard within minutes." },
    { command: "pipelines logs features_disputes_daily", why: "Last night’s 03:00 run failed: relation \"disputes.chargebacks\" does not exist. The tables moved to payments.* yesterday." },
    { command: "pipelines run features_disputes_daily", why: "The schema fix merged at 07:40; running the DAG now rebuilds both dispute features in about a minute." },
    { command: "models features cart-sentinel", why: "Both dispute features refresh to fresh, and declines fall back to about 0.5%." },
  ],
  postmortem: {
    question: "Why did cart-sentinel decline customers with clean histories?",
    options: [
      "Its dispute features went stale after the chargebacks table moved",
      "v27’s new monotonic constraint on device age punished old devices",
      "Card testers pushed the chargeback rate past the model’s training range",
      "Payments dropped the compat views, so the scorer couldn’t reach Postgres",
    ],
    answerIndex: 0,
    explanation: {
      cause: "PAY-1931 moved disputes.chargebacks to payments.*; features_disputes_daily failed and its features went stale.",
      why: "Past the 26 h guard the scorer serves a feature as missing, which the model reads as a brand-new account. Every customer looked unproven, on every version, so rolling back v27 changed nothing. The DAG’s fix was merged at 07:40 but only scheduled for 03:00; a manual run rebuilt both features in a minute.",
      tell: "customer_chargebacks_180d was 29 h old and STALE, the DAG log ended in UndefinedTable for disputes.chargebacks, and a second feature from the same DAG went stale mid-incident.",
    },
  },
});

// ── 2. A GDPR erasure leaves refunds without orders; "raise the threshold" ───────────────────────

const REFUND_RATIO_SQL = [
  "insert into features.customer_returns (customer_id, refund_ratio_90d, as_of)",
  "select r.customer_id, r.refunds::numeric / o.orders, current_date",
  "from refunds_90d r join orders_90d o using (customer_id)",
].join("\n");

const erasureDivision = incident({
  id: "data-t4-erasure-division-by-zero",
  title: "Divided by the forgotten",
  severity: "SEV2",
  opensAt: 9 * HOUR + 25 * MINUTE,
  briefing:
    "returns-guard is declining about one checkout in nine, almost all of them returning customers. Risk’s first instinct is to loosen the threshold until things calm down. Work out what is actually turning these customers away.",
  roleBriefing: SCORER_BRIEFING("returns-guard"),
  scorer: {
    model: "returns-guard",
    versions: [version("v8", -21 * DAY, "monthly retrain", 0.0052, 0.96), version("v9", -6 * DAY, "monthly retrain", 0.005, 0.965)],
    active: "v9",
    features: [
      feature("refund_ratio_90d", "features_returns_nightly", -31 * HOUR - 25 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -7 * HOUR - 5 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -2 * MINUTE),
    ],
    fraudAttemptsPerSecond: 5,
  },
  failedRun: {
    dag: "features_returns_nightly",
    feature: "refund_ratio_90d",
    at: 1 * HOUR + 40 * MINUTE + 12 - (9 * HOUR + 25 * MINUTE),
    runId: "scheduled__2026-10-09T01:30:00+00:00",
    executionDate: "20261009T013000",
    sql: REFUND_RATIO_SQL,
    error: ["psycopg2.errors.DivisionByZero: division by zero"],
  },
  evidence: [
    view("warehouse", "orders-vs-refunds", "Customers with refunds in the last 90 days but no orders left in orders_90d", () => [
      ...sqlTable(
        ["erasure_batch", "customers", "refunds_90d", "orders_90d"],
        [
          ["GDPR-2026-10-08", "1184", "1402", "0"],
          ["before 2026-10-08", "0", "0", "0"],
        ],
      ),
      "Erasure batch GDPR-2026-10-08 (privacy-ops, 22:10) deleted these customers’ orders and kept their refund rows for finance.",
    ]),
    view("warehouse", "declined-returners", "Customers returns-guard declined in the last 15 min, with the refund ratio it scored them on", (state) =>
      scoredVersusActual(state, "refund_ratio_90d", "refund_ratio_missing", [
        ["returned 0 items", 0.58, 0],
        ["returned 1-2 items", 0.33, 0],
        ["returned 3+ items", 0.09, 0],
      ]),
    ),
  ],
  suggestions: ["models show returns-guard", "models features returns-guard", "pipelines list", "warehouse run declined-returners"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 35, from: "Rina Nakamura · Risk", text: "Just raise returns-guard’s threshold to 0.95 until this passes. We can live with a bit more fraud for an hour." },
    { at: 90, from: "Maya Okonkwo · Support", text: "Declined customers include people who have never returned a thing." },
    { at: 170, from: "Aiko Tanaka · Privacy ops", text: "Heads-up: last night’s erasure batch ran at 22:10. Orders are deleted, refunds are kept for the auditors, as agreed with finance." },
    { at: 250, from: "Tomas Berg · Data eng", text: "I wrapped the refund-ratio divisor in nullif() at 08:55 (DATA-2281). The returns DAG runs at 01:30." },
    { at: 340, from: "Grace Liu · Finance", text: "We’re losing the morning. What’s the plan?" },
  ],
  hints: [
    "A threshold decides how much risk to accept. Look at what the scores are made of first.",
    "Customers who never returned anything are declined too. Check what the scorer believes about their returns.",
    "Last night’s erasure left some customers with refunds and no orders. Something had to divide by that.",
  ],
  solution: [
    { command: "models features returns-guard", why: "refund_ratio_90d is 31 h old and STALE: every customer is scored as if they had no return history." },
    { command: "pipelines logs features_returns_nightly", why: "The 01:30 run failed: division by zero. The erasure left 1,184 customers with refunds and no orders." },
    { command: "pipelines run features_returns_nightly", why: "The nullif() fix merged at 08:55; a run now rebuilds the refund ratio in about a minute." },
    { command: "models list", why: "Customers declined back near 0.5%, at the tuned threshold." },
  ],
  postmortem: {
    question: "Why did returns-guard decline returning customers this morning?",
    options: [
      "Its refund-ratio DAG divided by zero orders after the erasure",
      "The threshold was too strict for the morning’s mix of returning shoppers",
      "v9 learned to treat any customer with a return as likely fraud",
      "Privacy ops erased the customers’ cards, so the gateway rejected them",
    ],
    answerIndex: 0,
    explanation: {
      cause: "The erasure kept refunds but deleted orders; the refund-ratio DAG divided by zero and its feature went stale.",
      why: "Past the guard refund_ratio_90d is served as missing, the value an unknown customer has, adding about 11% declines on top of the model’s usual 0.5%. Raising the threshold to 0.95 only trims that 0.5%. The nullif() fix was merged at 08:55; a manual run rebuilt the feature.",
      tell: "refund_ratio_90d was 31 h old and STALE, the DAG failed with DivisionByZero, and 1,184 customers had refunds but zero orders after GDPR-2026-10-08.",
    },
  },
});

// ── 3. A vendor file says "N/A"; data eng reruns the wrong DAG ───────────────────────────────────

const domainAgeVendor = incident({
  id: "data-t4-vendor-na-domain-age",
  title: "Not applicable, not fresh",
  severity: "SEV2",
  opensAt: 10 * HOUR + 15 * MINUTE,
  briefing:
    "pay-trust is turning away customers at checkout, and data engineering has already rerun the late customer DAG twice without any change. Brand-new accounts with disposable email addresses pass. Find what pay-trust is really missing.",
  roleBriefing: SCORER_BRIEFING("pay-trust"),
  scorer: {
    model: "pay-trust",
    versions: [version("v3", -30 * DAY, "quarterly retrain", 0.0045, 0.95), version("v4", -12 * DAY, "quarterly retrain + email features", 0.0047, 0.962)],
    active: "v4",
    features: [
      feature("email_domain_age_days", "features_identity_nightly", -28 * HOUR - 50 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -HOUR - 15 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -3 * MINUTE),
    ],
    fraudAttemptsPerSecond: 4,
  },
  failedRun: {
    dag: "features_identity_nightly",
    feature: "email_domain_age_days",
    at: 5 * HOUR + 26 * MINUTE + 3 - (10 * HOUR + 15 * MINUTE),
    runId: "scheduled__2026-10-09T05:15:00+00:00",
    executionDate: "20261009T051500",
    sql: [
      "insert into features.identity (email_domain, email_domain_age_days, as_of)",
      "select v.domain, v.age_days::int, current_date",
      "from vendor.domain_intel_staging v",
    ].join("\n"),
    error: ['psycopg2.errors.InvalidTextRepresentation: invalid input syntax for type integer: "N/A"'],
  },
  evidence: [
    view("warehouse", "vendor-feed", "Rows in today’s domain-intel vendor file, by age_days value", () => [
      ...sqlTable(
        ["age_days_value", "rows", "first_seen_file"],
        [
          ["numeric", "2814907", "2019-03-02"],
          ["N/A", "3312", "2026-10-09"],
        ],
      ),
      "domain-intel changelog 2026-10-08: “age_days now reports N/A for domains with redacted WHOIS”.",
    ]),
    view("warehouse", "declined-by-email", "Customers pay-trust declined in the last 15 min, by email domain kind", (state) => {
      const w = window(state);
      const stale = isStale(state, "email_domain_age_days");
      const rows: [string, number, string][] = [
        ["gmail.com / outlook.com / icloud.com", 0.79, stale ? "0" : "9800+"],
        ["company domains", 0.17, stale ? "0" : "4100+"],
        ["disposable", 0.04, "0-3"],
      ];
      return sqlTable(["email_domain", "declined", "domain_age_days_scored"], rows.map(([domain, share, age]) => [domain, n(w.declined * share), age]));
    }),
  ],
  suggestions: ["models features pay-trust", "pipelines list", "warehouse run declined-by-email", "warehouse run vendor-feed"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈160 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 25, from: "Tomas Berg · Data eng", text: "features_customer_daily ran late this morning. I’ve rerun it twice. Want me to kick it again?" },
    { at: 80, from: "Maya Okonkwo · Support", text: "Gmail and Outlook customers are getting declined. People with ten-year-old accounts." },
    { at: 160, from: "Priya Shah · Identity", text: "domain-intel changed their file format on Thursday, something about redacted WHOIS. We patched the parser cast at 09:40 (ID-512)." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Customer DAG reran, still broken. What else is there?" },
  ],
  hints: [
    "Running a job that already succeeded changes nothing. Find the input that is actually old.",
    "Check which job builds each input; it isn’t always the one people talk about.",
    "Long-established email domains are being scored like ones registered yesterday.",
  ],
  solution: [
    { command: "models features pay-trust", why: "email_domain_age_days is nearly 29 h old and STALE; customer_orders_90d is fresh, so rerunning its DAG does nothing." },
    { command: "pipelines logs features_identity_nightly", why: "The 05:15 run failed casting the vendor’s new “N/A” value to an integer." },
    { command: "pipelines run features_identity_nightly", why: "The cast fix merged at 09:40; this rebuilds email_domain_age_days in about a minute." },
    { command: "models features pay-trust", why: "Every input fresh again; declines return to about 0.5%." },
  ],
  postmortem: {
    question: "Why were customers with long-established email domains declined?",
    options: [
      "email_domain_age_days went stale when the vendor file sent “N/A”",
      "features_customer_daily ran late and served last week’s order counts",
      "v4’s new email features were overfitted to disposable domains",
      "domain-intel stopped sending gmail.com and outlook.com in its file",
    ],
    answerIndex: 0,
    explanation: {
      cause: "domain-intel sent “N/A” for redacted WHOIS; the integer cast failed and email_domain_age_days went stale.",
      why: "The stale feature was served as 0 days, the age of a domain registered today, so every established mailbox looked disposable. Rerunning features_customer_daily refreshed a feature that was already fresh. The identity DAG’s cast was fixed at 09:40 but scheduled for 05:15 tomorrow.",
      tell: "email_domain_age_days was STALE from features_identity_nightly, its log failed on invalid input syntax for type integer: \"N/A\", and declined gmail customers scored domain age 0.",
    },
  },
});

// ── 4. Guest checkouts break a not-null column; Risk wants the trusted old model ─────────────────

const guestNotNull = incident({
  id: "data-t4-guest-checkout-not-null",
  title: "Guests with no name",
  severity: "SEV2",
  opensAt: 11 * HOUR + 35 * MINUTE,
  briefing:
    "order-sentry is declining roughly one checkout in nine. Guest checkout launched yesterday. Risk would rather go back to v5, the version they trusted for months. Find out whether any version would help.",
  roleBriefing: SCORER_BRIEFING("order-sentry"),
  scorer: {
    model: "order-sentry",
    versions: [
      version("v5", -64 * DAY, "baseline (risk-approved)", 0.0058, 0.94),
      version("v6", -23 * DAY, "monthly retrain", 0.005, 0.955),
      version("v7", -5 * DAY, "monthly retrain", 0.0049, 0.96),
    ],
    active: "v7",
    features: [
      feature("customer_returns_90d", "features_returns_daily", -27 * HOUR - 35 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -9 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 5,
  },
  failedRun: {
    dag: "features_returns_daily",
    feature: "customer_returns_90d",
    at: 8 * HOUR + 4 * MINUTE + 51 - (11 * HOUR + 35 * MINUTE),
    runId: "scheduled__2026-10-09T08:00:00+00:00",
    executionDate: "20261009T080000",
    sql: [
      "insert into features.customer_returns_90d (customer_id, returns, as_of)",
      "select r.customer_id, count(*), current_date",
      "from returns.returns r",
      "where r.created_at >= current_date - 90",
      "group by r.customer_id",
    ].join("\n"),
    error: [
      'psycopg2.errors.NotNullViolation: null value in column "customer_id" of relation "customer_returns_90d" violates not-null constraint',
      "DETAIL:  Failing row contains (null, 214, 2026-10-09).",
    ],
  },
  evidence: [
    view("warehouse", "returns-by-account", "Returns in the last 90 days, by whether the order had an account", () =>
      sqlTable(
        ["account_kind", "returns_90d", "first_return_at"],
        [
          ["registered", "612440", "2026-07-12 00:01"],
          ["guest (customer_id null)", "214", "2026-10-09 07:22"],
        ],
      ),
    ),
    view("warehouse", "declines-by-version", "Decline rate per order-sentry version over its time serving, and now", (state) => {
      const w = window(state);
      return [
        ...sqlTable(
          ["version", "served", "decline_pct"],
          [
            ["v5", "Aug 07 - Sep 17", "0.58"],
            ["v6", "Sep 17 - Oct 05", "0.50"],
            ["v7", "Oct 05 - yesterday", "0.49"],
            [scorerOf(state)?.active ?? "?", "last 15 min", (w.declinedShare * 100).toFixed(2)],
          ],
        ),
        "Every version scores the same inputs.",
      ];
    }),
  ],
  suggestions: ["models show order-sentry", "models features order-sentry", "warehouse run declines-by-version", "warehouse run returns-by-account"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈170 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Rina Nakamura · Risk", text: "Can we put order-sentry back on v5? It ran for six weeks without a single complaint." },
    { at: 95, from: "Lena Ortiz · Product", text: "Guest checkout went GA yesterday morning, 07:00. Conversion was looking great until this." },
    { at: 170, from: "Maya Okonkwo · Support", text: "Loyal customers with years of orders are being declined. Not guests: registered people." },
    { at: 260, from: "Ingrid Solberg · Data eng", text: "Merged a filter for guest returns into the returns DAG at 11:10 (DATA-2299). It runs at 08:00 daily." },
  ],
  hints: [
    "If every version would score the same inputs, choosing an older one doesn’t change those inputs.",
    "Yesterday’s launch created rows that one nightly job had never seen before.",
    "The fix for the failing job is merged. Its schedule is the only thing in the way.",
  ],
  solution: [
    { command: "models features order-sentry", why: "customer_returns_90d last succeeded 27 h ago and is STALE: every customer scored as if brand new." },
    { command: "pipelines logs features_returns_daily", why: "The 08:00 run failed on a null customer_id: guest returns from yesterday’s launch." },
    { command: "pipelines run features_returns_daily", why: "The guest filter merged at 11:10; running now rebuilds returns in about a minute." },
    { command: "models list", why: "Declines back near 0.5% on v7. No rollback needed." },
  ],
  postmortem: {
    question: "Why was order-sentry declining registered customers?",
    options: [
      "Guest returns broke the returns DAG, so customer_returns_90d went stale",
      "Guest checkout flooded the scorer with risky accounts it had never seen",
      "v7 drifted from v5’s risk-approved behaviour over two retrains",
      "Registered customers’ returns were merged into guest accounts by mistake",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Guest returns have no customer_id; the returns DAG broke a not-null rule and customer_returns_90d went stale.",
      why: "A stale input is served as a new customer’s default on every version, so v5 would have declined the same people. Registered customers were hurt, not guests, because their history vanished. The filter merged at 11:10, but the DAG only runs at 08:00; a manual run fixed it.",
      tell: "customer_returns_90d was 27 h old and STALE, the DAG log showed NotNullViolation on customer_id, and every version’s decline rate had been about 0.5% until today.",
    },
  },
});

// ── 5. Deadlocked against a backfill; Risk loosens the threshold ─────────────────────────────────

const deviceDeadlock = incident({
  id: "data-t4-device-backfill-deadlock",
  title: "Locked out by the backfill",
  severity: "SEV2",
  opensAt: 12 * HOUR + 40 * MINUTE,
  briefing:
    "device-trust declines are rising through lunchtime. Risk raised the threshold an hour ago, which made no visible difference. A device-graph backfill ran overnight. Find what device-trust is short of.",
  roleBriefing: SCORER_BRIEFING("device-trust"),
  scorer: {
    model: "device-trust",
    versions: [version("v14", -18 * DAY, "weekly retrain", 0.005, 0.96), version("v15", -4 * DAY, "weekly retrain", 0.005, 0.965)],
    active: "v15",
    features: [
      feature("device_age_days", "features_device_nightly", -26 * HOUR - 40 * MINUTE),
      feature("device_accounts_30d", "features_device_nightly", goesStaleAt(3 * MINUTE + 30)),
      feature("card_bin_velocity_1h", "features_card_velocity", -6 * MINUTE),
    ],
    fraudAttemptsPerSecond: 7,
  },
  failedRun: {
    dag: "features_device_nightly",
    feature: "device_age_days",
    at: 2 * HOUR + 31 * MINUTE + 18 - (12 * HOUR + 40 * MINUTE),
    runId: "scheduled__2026-10-09T02:00:00+00:00",
    executionDate: "20261009T020000",
    sql: [
      "insert into features.device_daily (device_id, device_age_days, device_accounts_30d, as_of)",
      "select d.device_id, current_date - d.first_seen::date, count(distinct a.account_id), current_date",
      "from devices.devices d join devices.device_accounts a using (device_id)",
      "group by d.device_id, d.first_seen",
      "on conflict (device_id) do update set device_age_days = excluded.device_age_days, as_of = excluded.as_of",
    ].join("\n"),
    error: [
      "psycopg2.errors.DeadlockDetected: deadlock detected",
      "DETAIL:  Process 81234 waits for ShareLock on transaction 99123456; blocked by process 80211.",
      "Process 80211 waits for ShareLock on transaction 99123455; blocked by process 81234.",
      "HINT:  See server log for query details.",
      'CONTEXT:  while inserting index tuple (1204,7) in relation "device_daily_pkey"',
    ],
  },
  evidence: [
    view("warehouse", "backfill-jobs", "Device-graph jobs that wrote to features.device_daily since yesterday", () =>
      sqlTable(
        ["job", "started", "finished", "rows_written", "state"],
        [
          ["device_graph_backfill (DG-77)", "Oct 09 23:50", "Oct 10 06:20", "41882113", "success"],
          ["features_device_nightly attempt 1", "Oct 10 02:00", "Oct 10 02:09", "0", "deadlock"],
          ["features_device_nightly attempt 2", "Oct 10 02:15", "Oct 10 02:24", "0", "deadlock"],
          ["features_device_nightly attempt 3", "Oct 10 02:31", "Oct 10 02:31", "0", "deadlock"],
        ],
      ),
    ),
    view("models", "threshold-history", "Recent threshold changes to device-trust", (state) => {
      const fraud = scorerOf(state);
      return [
        ...sqlTable(
          ["at", "by", "change", "declines_after"],
          [
            ["11:42", "rina.nakamura", "0.85 → 0.95", "11.9% → 11.6%"],
            ["11:51", "rina.nakamura", "0.95 → 0.85", "11.6% → 11.9%"],
          ],
        ),
        `Serving threshold now ${fraud?.threshold ?? "?"} (tuned ${fraud?.tunedThreshold ?? "?"}).`,
      ];
    }),
  ],
  suggestions: ["models show device-trust", "models features device-trust", "models threshold-history", "warehouse run backfill-jobs"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Rina Nakamura · Risk", text: "I tried 0.95 for ten minutes before lunch and declines barely moved, so I put it back. Something else is going on." },
    { at: 100, from: "Kenji Mori · Data eng", text: "The DG-77 device-graph backfill took longer than planned, it finished around 06:20. It held a lot of locks on device_daily overnight." },
    { at: 190, from: "Maya Okonkwo · Support", text: "Customers on phones they’ve used for years are being declined." },
    { at: 300, from: "Elena Ruiz · VP Engineering", text: "Declines are climbing again. What changed in the last few minutes?" },
  ],
  hints: [
    "A threshold change that barely moves declines tells you the declines aren’t about the threshold.",
    "Two device inputs come from one nightly job. Check both of their ages.",
    "Whatever blocked last night’s job finished hours ago.",
  ],
  solution: [
    { command: "models features device-trust", why: "device_age_days is past the 26 h guard; device_accounts_30d from the same DAG is minutes behind it." },
    { command: "pipelines logs features_device_nightly", why: "All three attempts at 02:00 deadlocked against the DG-77 backfill, which finished at 06:20." },
    { command: "pipelines run features_device_nightly", why: "Nothing holds the locks now; a manual run rebuilds both device features in about a minute." },
    { command: "models features device-trust", why: "Both device features fresh; declines back near 0.5%." },
  ],
  postmortem: {
    question: "Why did device-trust decline customers on long-used devices?",
    options: [
      "Device features went stale when their DAG hit a deadlock",
      "A threshold of 0.85 was too strict for the lunchtime traffic mix",
      "The DG-77 backfill rewrote every device’s first_seen to today",
      "v15 overweights device age and punishes customers who never upgrade",
    ],
    answerIndex: 0,
    explanation: {
      cause: "features_device_nightly deadlocked against the DG-77 backfill three times, so its device features went stale.",
      why: "Stale device_age_days was served as 0, a brand-new device, and device_accounts_30d followed it past the guard minutes into the incident, doubling the extra declines. Raising the threshold only moves the model’s own 0.5%. The backfill was done by 06:20, so a manual run simply succeeded.",
      tell: "Raising the threshold moved declines by 0.3 points, device_age_days was STALE, the DAG log showed DeadlockDetected on device_daily_pkey, and the backfill finished at 06:20.",
    },
  },
});

// ── 6. A DNS record lost in a cluster move; the new version is blamed ────────────────────────────

const replicaDns = incident({
  id: "data-t4-replica-dns-record",
  title: "The replica with no name",
  severity: "SEV2",
  opensAt: 13 * HOUR + 50 * MINUTE,
  briefing:
    "ship-risk is declining a growing share of checkouts, mostly customers shipping to addresses they have used for years. ship-risk v41 shipped this morning. The data platform moved clusters last night. Get those customers paying again.",
  roleBriefing: SCORER_BRIEFING("ship-risk"),
  scorer: {
    model: "ship-risk",
    versions: [version("v40", -13 * DAY, "weekly retrain", 0.0048, 0.97), version("v41", -5 * HOUR - 30 * MINUTE, "weekly retrain", 0.005, 0.972)],
    active: "v41",
    features: [
      feature("address_orders_365d", "features_address_daily", -30 * HOUR - 20 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -10 * HOUR - 50 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 6,
  },
  failedRun: {
    dag: "features_address_daily",
    feature: "address_orders_365d",
    at: HOUR + 41 * MINUTE + 9 - (13 * HOUR + 50 * MINUTE),
    runId: "scheduled__2026-10-09T01:30:00+00:00",
    executionDate: "20261009T013000",
    error: ['psycopg2.OperationalError: could not translate host name "orders-replica.data.svc.cluster.local" to address: Name or service not known'],
  },
  evidence: [
    view("warehouse", "declined-by-address", "Customers ship-risk declined in the last 15 min, by how often they shipped to that address", (state) =>
      scoredVersusActual(state, "address_orders_365d", "address_orders_365d", [
        ["shipped here 10+ times", 0.62, 14],
        ["shipped here 2-9 times", 0.29, 4],
        ["first time here", 0.09, 0],
      ]),
    ),
  ],
  suggestions: ["models show ship-risk", "models features ship-risk", "pipelines list", "warehouse run declined-by-address"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Dev Raman · ML platform", text: "ship-risk v41 went live at 08:20. If it’s the model, rollback is one command." },
    { at: 90, from: "Maya Okonkwo · Support", text: "A customer who has shipped to the same house for eight years was declined three times." },
    { at: 160, from: "Sam Tan · SRE", text: "Platform moved the data namespace to the new cluster last night. One Service got missed, orders-replica; it was recreated at 09:05 (PLAT-640)." },
    { at: 280, from: "Elena Ruiz · VP Engineering", text: "Is rolling back v41 the plan?" },
  ],
  hints: [
    "A version that scores like the previous one on fresh data isn’t the change you’re looking for.",
    "One input describes the shipping address. Check how old it is.",
    "Last night’s job couldn’t even reach its database. That has since been fixed.",
  ],
  solution: [
    { command: "models features ship-risk", why: "address_orders_365d is 30 h old and STALE: every address scored as never used." },
    { command: "pipelines logs features_address_daily", why: "The 01:30 run couldn’t resolve orders-replica.data.svc.cluster.local; the Service came back at 09:05." },
    { command: "pipelines run features_address_daily", why: "The replica resolves again; a run now rebuilds the address feature in about a minute." },
    { command: "models features ship-risk", why: "Every input fresh; declines back near 0.5% without touching v41." },
  ],
  postmortem: {
    question: "Why did ship-risk decline customers shipping to familiar addresses?",
    options: [
      "The address feature went stale: its DAG couldn’t find the replica",
      "v41 was trained on a week of data dominated by first-time addresses",
      "The cluster move changed every address’s ID, so none matched any more",
      "orders-replica served wrong order counts for addresses after the move",
    ],
    answerIndex: 0,
    explanation: {
      cause: "orders-replica’s Service was missed in the move; the address DAG failed and address_orders_365d went stale.",
      why: "Past the guard the scorer served address_orders_365d as 0, so every familiar address looked new. v40 scores the same inputs, so rolling back would have changed nothing. The Service was recreated at 09:05; a manual run rebuilt the feature.",
      tell: "address_orders_365d was 30 h old and STALE, the DAG log failed to translate host name orders-replica, and declined customers had shipped to the same address many times.",
    },
  },
});

// ── 7. Epoch seconds where a timestamp used to be; rollback to the last good day ─────────────────

const LOYALTY_LINE = "select l.customer_id, date_trunc('month', l.enrolled_at), current_date";

const epochTimestamps = incident({
  id: "data-t4-epoch-enrolled-at",
  title: "Members since 1970",
  severity: "SEV2",
  opensAt: 15 * HOUR + 5 * MINUTE,
  briefing:
    "loyalty-risk has been declining loyalty members since this morning. loyalty-risk v19 was promoted yesterday afternoon. The loyalty team shipped a new event format yesterday. Find out why members look risky.",
  roleBriefing: SCORER_BRIEFING("loyalty-risk"),
  scorer: {
    model: "loyalty-risk",
    versions: [version("v18", -14 * DAY, "fortnightly retrain", 0.0047, 0.955), version("v19", -23 * HOUR, "fortnightly retrain", 0.005, 0.96)],
    active: "v19",
    features: [
      feature("loyalty_tenure_months", "features_loyalty_nightly", -28 * HOUR - 5 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -12 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -8 * MINUTE),
    ],
    fraudAttemptsPerSecond: 3,
  },
  failedRun: {
    dag: "features_loyalty_nightly",
    feature: "loyalty_tenure_months",
    at: 3 * HOUR + 7 * MINUTE + 30 - (15 * HOUR + 5 * MINUTE),
    runId: "scheduled__2026-10-09T03:00:00+00:00",
    executionDate: "20261009T030000",
    sql: ["insert into features.loyalty (customer_id, enrolled_month, as_of)", LOYALTY_LINE, "from loyalty.members l"].join("\n"),
    error: [
      "psycopg2.errors.UndefinedFunction: function date_trunc(unknown, bigint) does not exist",
      `LINE 2: ${LOYALTY_LINE}`,
      caretUnder(`LINE 2: ${LOYALTY_LINE}`, "date_trunc"),
      "HINT:  No function matches the given name and argument types. You might need to add explicit type casts.",
    ],
  },
  evidence: [
    view("warehouse", "declined-members", "Customers loyalty-risk declined in the last 15 min, by loyalty tier", (state) =>
      scoredVersusActual(state, "loyalty_tenure_months", "tenure_months", [
        ["gold", 0.41, 38],
        ["silver", 0.37, 17],
        ["not a member", 0.22, 0],
      ]),
    ),
    view("warehouse", "members-schema", "loyalty.members columns changed in the last week", () =>
      sqlTable(
        ["column", "old_type", "new_type", "changed_at", "change"],
        [["enrolled_at", "timestamptz", "bigint", "2026-10-09 14:30", "LOY-118 epoch seconds for the event bus"]],
      ),
    ),
  ],
  suggestions: ["models show loyalty-risk", "models features loyalty-risk", "pipelines list", "warehouse run declined-members", "warehouse run members-schema"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈150 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 25, from: "Kofi Mensah · Data science", text: "loyalty-risk v19 auto-promoted yesterday at 16:05. Want to roll it back to v18 just to rule it out?" },
    { at: 90, from: "Nadia Haddad · Loyalty", text: "We switched enrolled_at to epoch seconds yesterday at 14:30 for the new event bus (LOY-118). Downstream owners were notified." },
    { at: 170, from: "Maya Okonkwo · Support", text: "Gold members are complaining loudest. They’re the ones being declined." },
    { at: 250, from: "Tomas Berg · Data eng", text: "I added to_timestamp() to the loyalty DAG at 14:20 (DATA-2310). It runs at 03:00." },
  ],
  hints: [
    "Your best members are hit hardest. Look at what the scorer knows about membership.",
    "A column changed type yesterday. A nightly job had to read it.",
    "The fix is in. Waiting until tomorrow is a choice, not a requirement.",
  ],
  solution: [
    { command: "models features loyalty-risk", why: "loyalty_tenure_months is 28 h old and STALE: every member scored as joining today." },
    { command: "pipelines logs features_loyalty_nightly", why: "The 03:00 run failed: date_trunc can’t take a bigint. enrolled_at became epoch seconds yesterday." },
    { command: "pipelines run features_loyalty_nightly", why: "The to_timestamp() fix merged at 14:20; a run now rebuilds tenure in about a minute." },
    { command: "models list", why: "Declines back near 0.5% on v19." },
  ],
  postmortem: {
    question: "Why did loyalty-risk decline gold and silver members?",
    options: [
      "Tenure went stale after enrolled_at changed to epoch seconds",
      "v19 learned that long-tenured members are a new fraud pattern",
      "LOY-118 reset every member’s enrolment date to 1970 in the warehouse",
      "Members’ discounts made their baskets look like card testing",
    ],
    answerIndex: 0,
    explanation: {
      cause: "LOY-118 made enrolled_at a bigint; the loyalty DAG’s date_trunc failed and loyalty_tenure_months went stale.",
      why: "Past the guard tenure was served as 0 months, a member who joined today, and those are the riskiest members the model knows. v18 scores the same input, so rolling back would not help. The cast fix merged at 14:20 but runs at 03:00; a manual run rebuilt tenure.",
      tell: "loyalty_tenure_months was 28 h old and STALE, the DAG failed on date_trunc(unknown, bigint), and declines concentrated on gold and silver tiers.",
    },
  },
});

// ── 8. A stale Terraform branch rewrites the threshold; the fresh version is blamed ──────────────

const terraformBranch = incident({
  id: "data-t4-terraform-stale-branch",
  title: "Applied from the wrong branch",
  severity: "SEV2",
  opensAt: 16 * HOUR + 20 * MINUTE,
  briefing:
    "checkout-sentry has declined about one checkout in fifteen since mid-afternoon. A new model version went out at 14:00 and ML platform is ready to roll it back. An infrastructure apply ran around the same time. Find what changed.",
  roleBriefing: SCORER_BRIEFING("checkout-sentry"),
  scorer: {
    model: "checkout-sentry",
    versions: [version("v62", -7 * DAY, "weekly retrain", 0.005, 0.97), version("v63", -2 * HOUR - 20 * MINUTE, "weekly retrain", 0.0049, 0.972)],
    active: "v63",
    threshold: 0.55,
    tunedThreshold: 0.88,
    features: [
      feature("customer_orders_90d", "features_customer_daily", -13 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -2 * MINUTE),
    ],
    fraudAttemptsPerSecond: 8,
  },
  evidence: [
    view("models", "serving-config", "checkout-sentry serving-config changes, newest last", (state) => {
      const fraud = scorerOf(state);
      return [
        ...sqlTable(
          ["at", "by", "source", "change"],
          [
            ["Sep 22 10:12", "atlantis", "infra-ml@main", "decline_threshold 0.55 → 0.88 (v58 recalibration)"],
            ["Oct 10 14:02", "ml-deploy", "registry", "serving v62 → v63"],
            ["Oct 10 14:07", "atlantis", "infra-ml@sam/gpu-quota", "decline_threshold 0.88 → 0.55"],
          ],
        ),
        `Serving: ${fraud?.active ?? "?"} at threshold ${fraud?.threshold ?? "?"} (tuned ${fraud?.tunedThreshold ?? "?"}).`,
      ];
    }),
    view("warehouse", "declines-by-score", "Customers declined in the last 15 min, by score band", (state) => {
      const w = window(state);
      const threshold = scorerOf(state)?.threshold ?? 0;
      const low = threshold < 0.8;
      return sqlTable(
        ["score_band", "customers_declined", "chargebacks_90d"],
        [
          ["0.55-0.88", n(low ? w.declined * 0.93 : 0), "0"],
          ["0.88-1.00", n(low ? w.declined * 0.07 : w.declined), "3"],
        ],
      );
    }),
  ],
  suggestions: ["models show checkout-sentry", "models serving-config", "warehouse run declines-by-score"],
  lostCheckoutsPerPoint: 160,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Dev Raman · ML platform", text: "v63 went out at 14:02. I can roll back to v62 right now if you want." },
    { at: 100, from: "Sam Tan · SRE", text: "Atlantis applied infra-ml from my gpu-quota branch at 14:07. It only bumped GPU quota… I thought. That branch is three weeks old." },
    { at: 190, from: "Maya Okonkwo · Support", text: "Ordinary customers, ordinary baskets, declined since about two." },
    { at: 290, from: "Elena Ruiz · VP Engineering", text: "Roll back or not? I need a decision." },
  ],
  hints: [
    "Rolling back a version leaves its serving config where it is.",
    "Compare the threshold serving now with the one the model was tuned to.",
    "An apply from an old branch writes old values, including ones nobody meant to touch.",
  ],
  solution: [
    { command: "models show checkout-sentry", why: "Threshold 0.55 against a tuned 0.88. v63 and v62 decline about the same at their tuned threshold." },
    { command: "models serving-config", why: "The 14:07 apply from a three-week-old branch put back the pre-recalibration threshold." },
    { command: "models threshold checkout-sentry 0.88", why: "Back to the tuned threshold. A rollback would keep 0.55." },
    { command: "models list", why: "Customers declined back near 0.5%." },
  ],
  postmortem: {
    question: "Why did checkout-sentry decline more customers after 14:07?",
    options: [
      "An apply from a stale branch set the threshold back to 0.55",
      "v63 shifted good customers’ scores upward compared with v62",
      "Atlantis bumped GPU quota and the scorer timed out on half its requests",
      "Afternoon traffic brought riskier baskets than the tuning set",
    ],
    answerIndex: 0,
    explanation: {
      cause: "An Atlantis apply from a three-week-old branch reset checkout-sentry’s threshold from 0.88 to 0.55.",
      why: "The branch predated v58’s recalibration, so its tfvars still held 0.55. Good customers scoring 0.55–0.88 were declined. Serving config stays across a rollback, so v62 would have declined just as many. Setting 0.88 back fixed it; the branch needs rebasing before its next apply.",
      tell: "models show read threshold 0.55, tuned 0.88; the serving-config log showed the 14:07 change from infra-ml@sam/gpu-quota; 93% of declines scored 0.55–0.88.",
    },
  },
});

// ── 9. The review band's lower edge typed as the decline threshold; a late DAG is blamed ─────────

const reviewBand = incident({
  id: "data-t4-review-band-threshold",
  title: "The manual review that wasn’t",
  severity: "SEV2",
  opensAt: 17 * HOUR + 30 * MINUTE,
  briefing:
    "pay-sentinel started declining about one customer in twenty-five at 17:00. Risk ops say they only set up a new manual-review band. A session feature DAG is running behind and data engineering wants to rerun it. Find out what is turning customers away.",
  roleBriefing: SCORER_BRIEFING("pay-sentinel"),
  scorer: {
    model: "pay-sentinel",
    versions: [version("v9", -11 * DAY, "weekly retrain", 0.0045, 0.96), version("v10", -4 * DAY, "weekly retrain", 0.0045, 0.965)],
    active: "v10",
    threshold: 0.62,
    tunedThreshold: 0.9,
    features: [
      feature("session_events_1h", "features_session_hourly", -2 * HOUR - 40 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -14 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -3 * MINUTE),
    ],
    fraudAttemptsPerSecond: 6,
  },
  evidence: [
    view("models", "review-band", "RISK-77 manual-review band change request, as filed and as applied", (state) => {
      const fraud = scorerOf(state);
      return [
        ...sqlTable(
          ["field", "requested", "applied_at_17_00"],
          [
            ["review_band_low", "0.62", "(unset)"],
            ["review_band_high", "0.90", "(unset)"],
            ["decline_threshold", "0.90 (unchanged)", "0.62"],
          ],
        ),
        `pay-sentinel has no review queue wired up; decline_threshold is the only cut it reads. Serving now: ${fraud?.threshold ?? "?"}.`,
      ];
    }),
    view("warehouse", "declines-since-1700", "Customers declined per 10 minutes since 16:00", (state) => {
      const w = window(state);
      return sqlTable(
        ["minute", "checkouts", "declined", "decline_pct"],
        [
          ["16:30", "68210", "301", "0.44"],
          ["16:50", "70114", "318", "0.45"],
          ["17:00", "71902", "2934", "4.08"],
          ["17:20", "73408", "3001", "4.09"],
          ["last 15 min", n(w.customers), n(w.declined), (w.declinedShare * 100).toFixed(2)],
        ],
      );
    }),
  ],
  suggestions: ["models show pay-sentinel", "models features pay-sentinel", "models review-band", "warehouse run declines-since-1700"],
  lostCheckoutsPerPoint: 140,
  externals: [gatewayOk("≈170 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Kenji Mori · Data eng", text: "features_session_hourly is running 2 h behind because of a Kafka rebalance. I can rerun it now." },
    { at: 90, from: "Olivia Grant · Risk ops", text: "We set up a manual-review band at 17:00 (RISK-77): 0.62 to 0.90 goes to the review team. Nothing should be declined that wasn’t before." },
    { at: 180, from: "Maya Okonkwo · Support", text: "Customers are being declined outright. Nobody is reviewing anything, as far as I can tell." },
    { at: 280, from: "Grace Liu · Finance", text: "Evening peak starts in half an hour. Please." },
  ],
  hints: [
    "Late isn’t stale. The freshness guard decides that, not the schedule.",
    "Declines stepped up in one minute. Look for a change made in that minute.",
    "A band meant for human review only works if something reads it.",
  ],
  solution: [
    { command: "models features pay-sentinel", why: "session_events_1h is under 3 h old: late, but fresh. Rerunning its DAG changes nothing." },
    { command: "models show pay-sentinel", why: "Threshold 0.62 against a tuned 0.90: RISK-77’s band edge landed as the decline cut." },
    { command: "models review-band", why: "The request set review_band_low to 0.62; the apply wrote it to decline_threshold." },
    { command: "models threshold pay-sentinel 0.9", why: "Back to the tuned decline threshold. The review band waits for a queue that can read it." },
    { command: "models list", why: "Customers declined back near 0.45%." },
  ],
  postmortem: {
    question: "Why did pay-sentinel decline more customers from 17:00?",
    options: [
      "RISK-77’s review band edge, 0.62, was applied as the decline threshold",
      "features_session_hourly ran two hours late and served stale session data",
      "The review team rejected every checkout in the new band",
      "v10 began scoring evening traffic higher than its training data",
    ],
    answerIndex: 0,
    explanation: {
      cause: "RISK-77’s change wrote the review band’s lower edge, 0.62, into decline_threshold.",
      why: "pay-sentinel has no review queue; the only cut it reads is decline_threshold. Every good customer scoring 0.62–0.90 was declined. session_events_1h was late but well inside the 26 h guard, so rerunning its DAG did nothing. Restoring 0.90 fixed it.",
      tell: "Declines stepped from 0.45% to 4.1% in the 17:00 minute, models show read 0.62 against a tuned 0.90, and the review-band record showed decline_threshold applied as 0.62.",
    },
  },
});

// ── 10. The auto-tuner fits to a card-testing day; Risk rolls back to a trusted version ──────────

const autoTuner = incident({
  id: "data-t4-auto-tuner-attack-day",
  title: "Tuned on the worst day",
  severity: "SEV2",
  opensAt: 18 * HOUR + 45 * MINUTE,
  briefing:
    "txn-sentinel has been declining roughly one checkout in thirty since 18:00. Risk is sure it’s the model and wants v33 back, the version from before the last card-testing wave. Find out whether that would help.",
  roleBriefing: SCORER_BRIEFING("txn-sentinel"),
  scorer: {
    model: "txn-sentinel",
    versions: [
      version("v33", -20 * DAY, "weekly retrain", 0.005, 0.96),
      version("v34", -13 * DAY, "weekly retrain", 0.0048, 0.965),
      version("v35", -6 * DAY, "weekly retrain", 0.0048, 0.97),
    ],
    active: "v35",
    threshold: 0.66,
    tunedThreshold: 0.91,
    features: [
      feature("customer_orders_90d", "features_customer_daily", -15 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -5 * MINUTE),
    ],
    fraudAttemptsPerSecond: 9,
  },
  evidence: [
    view("models", "auto-tune-log", "threshold-autotuner runs for txn-sentinel", (state) => {
      const fraud = scorerOf(state);
      return [
        ...sqlTable(
          ["run_at", "label_window", "fraud_rate_in_window", "proposed", "applied"],
          [
            ["Oct 03 18:00", "Sep 26 - Oct 02", "0.6%", "0.91", "yes"],
            ["Oct 10 18:00", "Oct 03 - Oct 09", "7.9%", "0.66", "yes"],
          ],
        ),
        `Oct 03-09 includes last Tuesday’s card-testing wave. Serving threshold: ${fraud?.threshold ?? "?"}.`,
      ];
    }),
  ],
  suggestions: ["models show txn-sentinel", "models features txn-sentinel", "models auto-tune-log"],
  lostCheckoutsPerPoint: 150,
  externals: [gatewayOk("≈170 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Rina Nakamura · Risk", text: "Put txn-sentinel back on v33. That one was trained before the card testers poisoned everything." },
    { at: 110, from: "Kofi Mensah · Data science", text: "The weekly threshold auto-tuner runs Fridays at 18:00. It fits to last week’s labels." },
    { at: 200, from: "Maya Okonkwo · Support", text: "Declines since six, all ordinary-looking orders." },
    { at: 300, from: "Elena Ruiz · VP Engineering", text: "Evening rush. What are we doing?" },
  ],
  hints: [
    "Every version is scored against the same cut. Check whether the cut moved.",
    "Declines began on the hour, on a schedule.",
    "Last week was not a normal week to learn from.",
  ],
  solution: [
    { command: "models show txn-sentinel", why: "Threshold 0.66 against a tuned 0.91; each version declines about 0.5% at its tuned cut." },
    { command: "models auto-tune-log", why: "The 18:00 auto-tune fitted to a week with the card-testing wave and proposed 0.66." },
    { command: "models threshold txn-sentinel 0.91", why: "Back to the tuned value. Any rollback would keep 0.66." },
    { command: "models list", why: "Customers declined back near 0.5%." },
  ],
  postmortem: {
    question: "Why did txn-sentinel decline more customers from 18:00?",
    options: [
      "The auto-tuner fitted the threshold to a card-testing week",
      "v35 was trained on labels poisoned by the card-testing wave",
      "Card testers returned at 18:00 and crowded out real customers",
      "Friday evening shoppers have riskier baskets than the tuning set",
    ],
    answerIndex: 0,
    explanation: {
      cause: "The Friday auto-tuner fitted txn-sentinel’s threshold to a week dominated by card testing and set 0.66.",
      why: "A week with 7.9% fraud pulls the optimal cut down, so the tuner declined every good customer scoring 0.66–0.91. Serving config stays across a rollback, so v33 at 0.66 would decline just as many. Restoring 0.91 fixed it; the tuner should exclude attack windows.",
      tell: "models show read 0.66 against a tuned 0.91, the auto-tune log’s 18:00 run used a window with 7.9% fraud, and declines started on the hour.",
    },
  },
});

// ── 11. A CI job moves the champion alias; last week's runbook reruns the features ───────────────

const championAlias = incident({
  id: "data-t4-champion-alias-moved",
  title: "The runbook from last week",
  severity: "SEV2",
  opensAt: 19 * HOUR + 55 * MINUTE,
  briefing:
    "cart-risk is declining about one checkout in fourteen. Last week’s incident was stale features, and the runbook written afterwards says to rerun the customer DAG; data engineering has done that. Declines haven’t moved. Find out what’s really changed.",
  roleBriefing: SCORER_BRIEFING("cart-risk"),
  scorer: {
    model: "cart-risk",
    versions: [
      version("v57", -8 * DAY, "weekly retrain (champion)", 0.0045, 0.965),
      version("v58-challenger", -40 * MINUTE, "experiment EXP-131: basket text embedding", 0.07, 0.975),
    ],
    active: "v58-challenger",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -25 * MINUTE),
      feature("basket_text_embedding", "features_basket_text", -3 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 5,
  },
  evidence: [
    view("models", "registry-aliases", "Model-registry alias moves for cart-risk today", (state) => [
      ...sqlTable(
        ["at", "by", "alias", "from", "to"],
        [["19:15", "ci/exp-131-promote", "champion", "v57", "v58-challenger"]],
      ),
      `Scoring traffic follows the champion alias; serving now: ${scorerOf(state)?.active ?? "?"}.`,
    ]),
  ],
  suggestions: ["models show cart-risk", "models features cart-risk", "pipelines list", "models registry-aliases"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈170 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 25, from: "Tomas Berg · Data eng", text: "Following RB-31 from last week: reran features_customer_daily at 19:30. All green. Declines didn’t move." },
    { at: 100, from: "Ana Petrova · Data science", text: "EXP-131’s CI job was supposed to register v58-challenger for shadow scoring only. I’ll check what it did." },
    { at: 180, from: "Maya Okonkwo · Support", text: "Declined baskets have things like “gift for mum” and “birthday” in the notes. Weird." },
    { at: 280, from: "Elena Ruiz · VP Engineering", text: "Same playbook as last week? Why isn’t it working?" },
  ],
  hints: [
    "Every input is fresh. Last week’s cause is not this week’s.",
    "Check what is serving, and who put it there.",
    "A shadow experiment should never take real traffic.",
  ],
  solution: [
    { command: "models features cart-risk", why: "Every input fresh, customer_orders_90d 25 min old: the runbook rerun already happened and changed nothing." },
    { command: "models show cart-risk", why: "v58-challenger is serving and declines about 7%; v57 declined 0.45% while it served." },
    { command: "models registry-aliases", why: "EXP-131’s CI job moved the champion alias at 19:15 instead of registering a shadow." },
    { command: "models rollback cart-risk", why: "Serves v57 again." },
    { command: "models list", why: "Customers declined back near 0.45%." },
  ],
  postmortem: {
    question: "Why did cart-risk decline customers this evening?",
    options: [
      "EXP-131’s CI job made its challenger the serving champion",
      "customer_orders_90d went stale again, as it did last week",
      "Gift notes in baskets are a genuine new fraud signal",
      "basket_text_embedding was three hours old when the scoring began",
    ],
    answerIndex: 0,
    explanation: {
      cause: "EXP-131’s promote job moved cart-risk’s champion alias to v58-challenger instead of registering a shadow.",
      why: "The challenger’s basket text embedding scored gift notes as fraud and declined about 7% of customers. Every input was fresh, so last week’s runbook step, rerunning the customer DAG, could not help. Rolling back put v57 on the alias.",
      tell: "models features showed every input fresh, models show had v58-challenger serving at 7% declines, and the alias log showed the CI job moving champion at 19:15.",
    },
  },
});

// ── 12. A circuit breaker left the scorer open; Risk tightens the threshold ──────────────────────

const breakerOpen = incident({
  id: "data-t4-breaker-left-open",
  title: "Tighter, and nothing changed",
  severity: "SEV1",
  opensAt: 20 * HOUR + 50 * MINUTE,
  briefing:
    "Checkout is timing out at payment and the gateway’s status page shows elevated latency. A card-testing ring started this evening and Risk has already tightened fraud-sentinel’s threshold, with no effect. Get customers paying again.",
  roleBriefing: QUEUE_BRIEFING("fraud-sentinel", 150),
  scorer: {
    model: "fraud-sentinel",
    versions: [version("v21", -15 * DAY, "weekly retrain", 0.0045, 0.97), version("v22", -8 * DAY, "weekly retrain", 0.0045, 0.975)],
    active: "v22",
    mode: "fail-open",
    threshold: 0.6,
    features: [
      feature("customer_orders_90d", "features_customer_daily", -16 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -3 * MINUTE),
    ],
    fraudAttemptsPerSecond: 38,
  },
  gatewayChargesPerSecond: 150,
  gatewayBacklogSeconds: 2,
  evidence: [
    view("models", "breaker-events", "fraud-sentinel circuit-breaker events today", (state) => [
      ...sqlTable(
        ["at", "event", "detail"],
        [
          ["14:12", "OPEN", "feature store p99 1900 ms > 800 ms for 60 s; failing open"],
          ["14:31", "half-open probe", "skipped: manual override set by oncall.jwu (FS-88)"],
          ["20:44", "threshold", "0.85 → 0.6 by rina.nakamura"],
        ],
      ),
      isFailOpen(state) ? "Breaker state: OPEN (manual override). Scores are logged, never acted on." : "Breaker state: CLOSED. Scores are enforced.",
    ]),
    view("warehouse", "gateway-charges", "Charges sent to payment-gateway in the last 15 min, by amount", (state) => {
      const w = window(state);
      return sqlTable(
        ["amount_usd", "charges_sent", "score_p50"],
        [
          ["0.50-2.00", n(w.fraudApproved), "0.98"],
          ["(customer orders)", n(w.customers - w.declined), "0.05"],
        ],
      );
    }),
  ],
  suggestions: ["models list", "models show fraud-sentinel", "models breaker-events", "warehouse run gateway-charges"],
  lostCheckoutsPerPoint: 350,
  externals: [gatewaySlow("≈150 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% (payment timeouts). Data on-call paged." },
    { at: 25, from: "Rina Nakamura · Risk", text: "Card testers since 20:40, $0.50–$2 auths. I lowered fraud-sentinel’s threshold to 0.6 at 20:44 and the gateway is still drowning." },
    { at: 80, from: "Sam Tan · SRE", text: "Gateway status page says elevated latency for some merchants. Their latency is our queue, I think." },
    { at: 150, from: "Jia Wu · ML platform", text: "The feature store had a slow spell at 14:12 and fraud-sentinel’s breaker opened. I pinned it open while we fixed the store (FS-88). Store’s been fine since 15:00." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout is falling over. What’s the call?" },
  ],
  hints: [
    "A tighter threshold only matters if the scorer is acting on its scores.",
    "Something switched the scorer’s decisions off this afternoon and nobody switched them back.",
  ],
  solution: [
    { command: "models show fraud-sentinel", why: "Mode fail-open: every checkout approved, scores logged and ignored. The 0.6 threshold does nothing." },
    { command: "models breaker-events", why: "The breaker opened at 14:12 and was pinned open; the feature store recovered at 15:00." },
    { command: "models mode fraud-sentinel enforce", why: "Scores are acted on again; card testers are declined before the gateway." },
    { command: "models threshold fraud-sentinel 0.85", why: "Undo Risk’s 0.6: enforcing at 0.6 would decline far too many good customers." },
    { command: "models list", why: "Enforcing at the tuned threshold; the gateway queue drains." },
  ],
  postmortem: {
    question: "Why did lowering the threshold do nothing for the card testers?",
    options: [
      "fraud-sentinel was still failing open from this afternoon",
      "The card testers’ scores sat below 0.6, so they still passed",
      "The gateway was degraded for every merchant, not just for us",
      "v22 can’t score sub-$2 authorisations, so they were never declined",
    ],
    answerIndex: 0,
    explanation: {
      cause: "fraud-sentinel’s breaker was pinned open at 14:12 and never closed, so it approved every checkout.",
      why: "In fail-open the scorer logs scores and decides nothing, so a lower threshold changed nothing. The card testers went straight to a gateway capped at 150 charges a second, and the queue pushed real customers past checkout-api’s 3 s timeout. Enforcing at the tuned 0.85 stopped them.",
      tell: "models show read fail-open, breaker events showed the 14:31 manual override, and the testers’ auths scored a median 0.98.",
    },
  },
});

// ── 13. Failed open during a deploy; refunds first does nothing for the queue ────────────────────

const deployFailOpen = incident({
  id: "data-t4-fail-open-refunds-first",
  title: "Refunding into a flood",
  severity: "SEV1",
  opensAt: 21 * HOUR + 40 * MINUTE,
  briefing:
    "Customers are timing out at payment and Payments Ops is asking for a refund batch for the charges captured after checkout gave up. A card-testing ring is hitting checkout. payguard was redeployed at 21:00. Stop the damage, then make the customers whole.",
  roleBriefing: QUEUE_BRIEFING("payguard", 162),
  scorer: {
    model: "payguard",
    versions: [version("v5", -12 * DAY, "weekly retrain", 0.0045, 0.97), version("v6", -40 * MINUTE, "weekly retrain", 0.0046, 0.972)],
    active: "v6",
    mode: "fail-open",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -17 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -2 * MINUTE),
    ],
    fraudAttemptsPerSecond: 46,
  },
  gatewayChargesPerSecond: 162,
  gatewayBacklogSeconds: 2.2,
  refunds: { label: "Refund batch covers the orphaned charges once the queue has drained", maxUnrefundedShare: 0.1 },
  evidence: [
    view("models", "deploy-events", "payguard deploy events tonight", (state) => [
      ...sqlTable(
        ["at", "event", "by"],
        [
          ["21:00", "deploy v6 start: mode enforce → fail-open (RB-12 step 1)", "ml-deploy"],
          ["21:04", "deploy v6 healthy", "ml-deploy"],
          ["21:04", "RB-12 step 4 skipped: restore mode (pipeline timeout)", "ml-deploy"],
        ],
      ),
      isFailOpen(state) ? "Mode now: fail-open." : "Mode now: enforce.",
    ]),
    view("warehouse", "orphaned-by-minute", "Charges captured after checkout gave up, per minute since 21:30", (state) => {
      const queued = state.commerce ? state.commerce.gateway.backlog / state.commerce.gateway.chargesPerSecond : 0;
      return [
        ...sqlTable(
          ["minute", "orphaned_captures"],
          [
            ["21:30", "1180"],
            ["21:35", "1240"],
            ["21:39", "1310"],
          ],
        ),
        `Gateway queue now ${queued.toFixed(1)} s deep; anything over about 2.2 s keeps adding orphaned charges.`,
      ];
    }),
  ],
  suggestions: ["models list", "models deploy-events", "warehouse run orphaned-by-minute", "reconcile preview"],
  lostCheckoutsPerPoint: 300,
  externals: [gatewaySlow("≈162 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% (payment timeouts). Data on-call paged." },
    { at: 20, from: "Grace Liu · Finance", text: "Customers are charged without orders again. Can we get a refund batch out right now?" },
    { at: 70, from: "Rina Nakamura · Risk", text: "$1 card-testing auths since 21:30, about 45 a second. The scorer should be eating them." },
    { at: 140, from: "Dev Raman · ML platform", text: "payguard v6 deployed at 21:00. RB-12 fails open for the swap. The pipeline timed out at the end, but the deploy itself is healthy." },
    { at: 260, from: "Grace Liu · Finance", text: "Did the refunds go out? Are more charges still coming in?" },
  ],
  hints: [
    "A refund batch covers charges that already happened. Ask what keeps creating new ones.",
    "Look at who fills the gateway queue, and why the scorer lets them.",
    "A deploy runbook that switches something off has to switch it back on.",
  ],
  solution: [
    { command: "models show payguard", why: "Mode fail-open: the card testers go straight to the gateway and fill its queue." },
    { command: "models deploy-events", why: "RB-12’s restore step was skipped when the deploy pipeline timed out at 21:04." },
    { command: "models mode payguard enforce", why: "Declines the card testers before the gateway; the queue drains and orphaned charges stop." },
    { command: "models list", why: "Enforcing at the tuned threshold; fraud no longer reaches the gateway." },
    { command: "warehouse run orphaned-by-minute", why: "The queue is draining under the 2.2 s line." },
    { command: "reconcile preview", why: "Orphaned charges visible in the warehouse; few new ones arriving." },
    { command: "reconcile status", why: "No batch yet. Wait until the warehouse catches up with the last orphaned charges." },
    { command: "warehouse run orphaned-by-minute", why: "The queue is empty; no new orphaned charges since the scorer started enforcing." },
    { command: "reconcile preview", why: "The warehouse, 45 s behind, now shows nearly every orphaned charge." },
    { command: "reconcile submit", why: "Refund every orphaned charge now visible, after the flood stopped, so one batch covers nearly all of them." },
  ],
  postmortem: {
    question: "Why were customers timing out and charged without orders?",
    options: [
      "payguard stayed in fail-open after its deploy",
      "The gateway was degraded across all merchants after 21:30",
      "v6 scored the $1 card-testing auths as safe",
      "Payments Ops refunded the wrong batch and customers paid twice",
    ],
    answerIndex: 0,
    explanation: {
      cause: "payguard’s deploy failed open per RB-12 and the restore step was skipped, so card testers flooded the gateway.",
      why: "The testers’ auths queued ahead of real customers past checkout-api’s 3 s timeout; customers failed and were still captured. A refund batch while still failing open only covers charges that already exist, and more keep arriving. Enforcing stopped the flood; one batch after the queue drained made customers whole.",
      tell: "models show read fail-open, deploy events showed RB-12 step 4 skipped, and the orphaned charges stopped once the scorer enforced.",
    },
  },
});

// ── 14. Failed open to hide a stale feature; switching enforce back on alone brings the declines ──

const coveredUp = incident({
  id: "data-t4-fail-open-over-stale",
  title: "Two wrongs, one queue",
  severity: "SEV1",
  opensAt: 22 * HOUR + 55 * MINUTE,
  briefing:
    "Checkout is timing out at payment and card testers are getting through. Product put shopper-trust in fail-open this morning because it was declining loyal customers. Turning it back on is the obvious move, but the morning’s declines will come straight back. Fix both.",
  roleBriefing: QUEUE_BRIEFING("shopper-trust", 150),
  scorer: {
    model: "shopper-trust",
    versions: [version("v11", -16 * DAY, "weekly retrain", 0.0046, 0.97), version("v12", -9 * DAY, "weekly retrain", 0.0046, 0.973)],
    active: "v12",
    mode: "fail-open",
    features: [
      feature("customer_tenure_days", "features_tenure_daily", -42 * HOUR - 50 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 36,
  },
  gatewayChargesPerSecond: 150,
  gatewayBacklogSeconds: 2.05,
  failedRun: {
    dag: "features_tenure_daily",
    feature: "customer_tenure_days",
    at: 4 * HOUR + 3 * MINUTE + 2 - (22 * HOUR + 55 * MINUTE),
    runId: "scheduled__2026-10-09T04:00:00+00:00",
    executionDate: "20261009T040000",
    sql: [
      "insert into features.customer_tenure (customer_id, customer_tenure_days, as_of)",
      "select a.id, current_date - a.created_at::date, current_date",
      "from accounts.accounts a",
    ].join("\n"),
    error: ["psycopg2.errors.InsufficientPrivilege: permission denied for schema accounts"],
  },
  evidence: [
    view("models", "mode-history", "shopper-trust mode changes today", (state) => [
      ...sqlTable(
        ["at", "by", "change", "note"],
        [["08:10", "jonah.reyes", "enforce → fail-open", "PROD-411 stop declining loyal customers until data fixes features"]],
      ),
      isFailOpen(state) ? "Mode now: fail-open. Scores are logged, never acted on." : "Mode now: enforce.",
    ]),
  ],
  suggestions: ["models show shopper-trust", "models features shopper-trust", "pipelines list", "models mode-history"],
  lostCheckoutsPerPoint: 400,
  externals: [gatewaySlow("≈150 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% (payment timeouts). Data on-call paged." },
    { at: 25, from: "Rina Nakamura · Risk", text: "Card testers since 22:45, about 35 auths a second, and shopper-trust is waving them through. Turn enforcement back on!" },
    { at: 90, from: "Jonah Reyes · Product", text: "I failed it open at 08:10 because loyal customers were getting declined. If you turn it back on, they’ll be declined again." },
    { at: 170, from: "Hana Kobayashi · Platform", text: "We rotated the warehouse service accounts at 03:30 and missed a grant on schema accounts. Restored at 14:00 (PLAT-702)." },
    { at: 270, from: "Elena Ruiz · VP Engineering", text: "I need checkout working, and I don’t want loyal customers declined. Both." },
  ],
  hints: [
    "Failing open hid a problem; it didn’t fix it.",
    "Find out what was wrong this morning, and whether it’s still wrong now.",
    "Make the scorer fit to enforce before you ask it to enforce.",
  ],
  solution: [
    { command: "models features shopper-trust", why: "customer_tenure_days is 43 h old and STALE; enforcing now would decline about one customer in nine." },
    { command: "pipelines logs features_tenure_daily", why: "The 04:00 run failed on permission denied for schema accounts; the grant came back at 14:00." },
    { command: "pipelines run features_tenure_daily", why: "Rebuilds customer tenure in about a minute, now that the grant is back." },
    { command: "models mode shopper-trust enforce", why: "Tenure is a minute from fresh; every second in fail-open lets more testers into the queue, so enforce now." },
    { command: "models features shopper-trust", why: "Tenure fresh again: card testers declined, loyal customers approved, and the gateway queue drains." },
  ],
  postmortem: {
    question: "Why did shopper-trust let card testers through tonight?",
    options: [
      "It was failed open to hide a stale feature that nobody rebuilt",
      "v12 can’t recognise card testers who use brand-new accounts",
      "Platform’s key rotation broke the scorer’s connection to the gateway",
      "The card testers’ low amounts slipped under the decline threshold",
    ],
    answerIndex: 0,
    explanation: {
      cause: "shopper-trust was failed open at 08:10 to hide a stale tenure feature, and the feature was never rebuilt.",
      why: "The 04:00 tenure run failed after a missed grant. Failing open stopped the declines but approved everything, and tonight’s card testers filled the gateway queue. Enforcing alone brings back the stale-tenure declines; rebuilding the feature first, then enforcing, fixes both.",
      tell: "models show read fail-open since 08:10, customer_tenure_days was 43 h old and STALE, and the DAG failed on permission denied for schema accounts.",
    },
  },
});

/** Data tier 4: the usual fix does nothing, because the cause is somewhere it doesn't touch. */
export const DATA_TIER4_INCIDENTS: readonly Scenario[] = [
  schemaMove,
  erasureDivision,
  domainAgeVendor,
  guestNotNull,
  deviceDeadlock,
  replicaDns,
  epochTimestamps,
  terraformBranch,
  reviewBand,
  autoTuner,
  championAlias,
  breakerOpen,
  deployFailOpen,
  coveredUp,
];
