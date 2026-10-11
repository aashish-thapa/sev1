import type { AlertMetric, CommsMessage, Evidence, EvidenceTool, ExternalService, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count } from "../shell/commerce-command.ts";
import { airflowCompact, airflowLine, type AirflowLevel } from "../shell/commands/pipelines.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { table } from "../shell/types.ts";
import type { FraudFeature, FraudModelVersion, FraudScoring } from "../sim/commerce.ts";
import { activeVersion, fraudDeclines, isFeatureStale } from "../sim/fraud.ts";
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

/** A scorer is healthy when it enforces at its tuned threshold, on a version that turns away few good customers, with every input fresh. */
export function isScorerHealthy(state: ClusterState): boolean {
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

/** Share of the charges reaching the gateway that are fraud the scorer let through. */
const FRAUD_SHARE_OF_CHARGES: AlertMetric = {
  label: "fraud share of gateway charges",
  rate: (state) => {
    const { commerce } = state;
    if (!commerce) return 0;
    const fraudCalls = fraudDeclines(commerce, state.t).gatewayCallsPerSecond;
    const calls = commerce.pulse.gatewayCallsPerSecond + fraudCalls;
    return calls > 0 ? fraudCalls / calls : 0;
  },
};

/** The last scheduled run's failed task, as Airflow 2.10 logged it. */
type FailedRun = {
  readonly dag: string;
  readonly feature: string;
  /** Second of the incident (negative: before the page) the last attempt started. */
  readonly at: number;
  readonly runId: string;
  readonly executionDate: string;
  readonly sql?: string;
  /** The exception as Python printed it, from the class name on. */
  readonly error: readonly string[];
};

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
  /** Seconds of charges already queued at the gateway when the warm-up before the page starts. */
  readonly gatewayBacklogSeconds?: number;
  readonly failedRun?: FailedRun;
  readonly alertMetric?: AlertMetric;
  /** Fraud captures since the page the business can absorb; an objective when set. */
  readonly fraudCaptureBound?: number;
  readonly evidence: readonly Evidence[];
  readonly suggestions: readonly string[];
  readonly lostCheckoutsPerPoint: number;
  readonly externals?: readonly ExternalService[];
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function failedRunLog(opensAt: number, run: FailedRun): readonly LogEntry[] {
  const task = `build_${run.feature}`;
  const entry = (offset: number, origin: string, level: AirflowLevel, message: string): LogEntry => ({
    t: run.at + offset,
    source: run.dag,
    level: level === "ERROR" ? "ERROR" : "INFO",
    text: airflowLine(opensAt, run.at + offset, origin, level, message),
  });
  const ranFor = run.sql ? 3 : 1;
  return [
    entry(0, "taskinstance.py:2867", "INFO", "Starting attempt 3 of 3"),
    entry(0, "standard_task_runner.py:72", "INFO", `Started process ${43_000 + (Math.abs(run.at) % 9000)} to run task`),
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
  const state = checkoutCluster({
    seed: row.id,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({
      gateway: {
        ...(row.gatewayChargesPerSecond ? { chargesPerSecond: row.gatewayChargesPerSecond } : {}),
        backlog: (row.gatewayChargesPerSecond ?? 0) * (row.gatewayBacklogSeconds ?? 0),
      },
      fraud: fraudScorer(row.scorer),
    }),
  });
  const { commerce } = state;
  if (!commerce) return state;
  return {
    ...state,
    logs: row.failedRun ? { ...state.logs, [row.failedRun.dag]: failedRunLog(row.opensAt, row.failedRun) } : state.logs,
    // Objectives count fraud captured from the page on.
    commerce: { ...commerce, ledger: { ...commerce.ledger, fraudulentCaptures: 0 } },
  };
}

function incident(row: Row): Scenario {
  const bound = row.fraudCaptureBound;
  const objectives =
    bound === undefined
      ? undefined
      : (state: ClusterState): readonly Objective[] => {
          const captured = Math.round(state.commerce?.ledger.fraudulentCaptures ?? 0);
          return [
            {
              role: "data",
              label: `Fraudulent charges captured since the page: ${captured.toLocaleString("en-US")} (keep under ${bound.toLocaleString("en-US")})`,
              isMet: captured < bound,
            },
          ];
        };
  return {
    id: row.id,
    tier: 2,
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
    externals: row.externals ?? [],
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

const isServing = (state: ClusterState, version: string) => scorerOf(state)?.active === version;
const isFailOpen = (state: ClusterState) => scorerOf(state)?.mode === "fail-open";
const isStale = (state: ClusterState, feature: string) => {
  const found = scorerOf(state)?.features.find((candidate) => candidate.name === feature);
  return !!found && isFeatureStale(found, state.t);
};
const n = (value: number) => String(Math.round(value));
const pct = (part: number, whole: number) => (whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0");

/** The trailing 24 hours as a gateway sees them: green, apart from the latency our own traffic causes. */
const gatewayOk = (throughput: string): ExternalService => ({
  id: "payment-gateway",
  status: "ok",
  facts: [
    { key: "Status page", value: "All systems operational" },
    { key: "Throughput for us", value: throughput },
    { key: "Declines", value: "Card-network declines normal; the 402s come from our scorer, before any charge" },
  ],
});

const version = (v: string, deployedAt: number, note: string, falseDeclineShare: number, catchShare: number): FraudModelVersion => ({
  version: v,
  deployedAt,
  note,
  falseDeclineShare,
  catchShare,
});
const feature = (name: string, pipeline: string, lastSuccessAt: number): FraudFeature => ({ name, pipeline, lastSuccessAt, refresh: null });

const PAGE_LOST = "SEV2 triggered — checkout customers lost above 5% for 5m (scorer declines, HTTP 402). Data on-call paged.";
const SCORER_BRIEFING = (model: string) =>
  `Data on-call: models (${model}, the scorer in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge: no 5xx, just a lost customer.`;

// ── 1. Weekly retrain adds isotonic calibration; a TV spot and a late DAG take the blame ──────────

const isotonic = incident({
  id: "data-t2-isotonic-recalibration",
  title: "The recalibrated scorer",
  severity: "SEV2",
  opensAt: 7 * HOUR + 45 * MINUTE,
  briefing:
    "Since a little after 07:15 about one checkout in eleven ends in “Your payment was declined”. A TV spot aired at 07:30 and the shop is full of first-time visitors. A feature DAG is running late. checkout-risk retrained overnight. Work out which of these is turning customers away.",
  roleBriefing: SCORER_BRIEFING("checkout-risk"),
  scorer: {
    model: "checkout-risk",
    versions: [
      version("v21", -19 * DAY, "weekly retrain", 0.0045, 0.95),
      version("v22", -7 * DAY, "weekly retrain", 0.004, 0.955),
      version("v23", -27 * MINUTE, "weekly retrain + isotonic recalibration (ML-881)", 0.094, 0.968),
    ],
    active: "v23",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -5 * HOUR - 10 * MINUTE),
      feature("session_pages_1h", "features_session_hourly", -HOUR - 52 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -6 * MINUTE),
    ],
    fraudAttemptsPerSecond: 3,
  },
  evidence: [
    view("warehouse", "score-bands", "Customers declined in the last 15 min, by score band and order history", (state) => {
      const w = window(state);
      const shifted = isServing(state, "v23");
      const rows: [string, number, string][] = shifted
        ? [
            ["0.85-0.93", 0.81, "9"],
            ["0.93-0.97", 0.13, "4"],
            ["0.97-1.00", 0.06, "0"],
          ]
        : [
            ["0.85-0.93", 0.18, "2"],
            ["0.93-0.97", 0.27, "1"],
            ["0.97-1.00", 0.55, "0"],
          ];
      return [
        ...sqlTable(
          ["score_band", "customers_declined", "median_prior_paid_orders"],
          rows.map(([band, share, orders]) => [band, n(w.declined * share), orders]),
        ),
        `Scores from checkout-risk ${scorerOf(state)?.active ?? "?"}. Last week v22 put 1.9% of customers with 5+ paid orders above 0.85.`,
      ];
    }),
    view("warehouse", "first-time-shoppers", "Checkouts and declines in the last 15 min, first-time vs returning", (state) => {
      const w = window(state);
      const firstTime = 0.41;
      const declinedFirst = shiftedShare(state, 0.12, 0.62);
      return sqlTable(
        ["shopper", "checkouts", "pct_of_checkouts", "declined", "decline_rate_pct"],
        [
          ["first-time", n(w.customers * firstTime), "41.0", n(w.declined * declinedFirst), pct(w.declined * declinedFirst, w.customers * firstTime)],
          ["returning", n(w.customers * (1 - firstTime)), "59.0", n(w.declined * (1 - declinedFirst)), pct(w.declined * (1 - declinedFirst), w.customers * (1 - firstTime))],
        ],
      );
    }),
  ],
  suggestions: ["models show checkout-risk", "models features checkout-risk", "pipelines list", "warehouse run first-time-shoppers", "warehouse run score-bands"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 25, from: "Maya Okonkwo · Support", text: "Customers with years of orders are told their payment was declined. Their banks see no attempt at all." },
    { at: 55, from: "Lena Ortiz · Marketing", text: "FYI our TV spot aired at 07:30. Expect a lot of first-time shoppers this morning, the landing page is packed." },
    { at: 95, from: "Tomas Berg · Data eng", text: "features_session_hourly is behind: the 06:00 run took 50 minutes because of the clickstream backfill. It’s catching up." },
    { at: 150, from: "Dev Raman · ML platform", text: "checkout-risk v23 auto-promoted at 07:18. This week’s change is isotonic calibration, so scores finally read as probabilities. It beat v22 on holdout recall." },
    { at: 260, from: "Grace Liu · Finance", text: "The campaign money is wasted if the people it brings in can’t pay. What’s the plan?" },
  ],
  hints: [
    "Campaign traffic is new shoppers. Check whether they are the ones being declined.",
    "A late input is not a stale one: the freshness guard decides that, not the schedule.",
    "Look at where declined customers’ scores sit now, against how last week’s version scored them.",
  ],
  solution: [
    { command: "models show checkout-risk", why: "v23 went live at 07:18 and declines about 9% of customers; v22 declined 0.4% while it served." },
    { command: "warehouse run score-bands", why: "Most declines sit just above 0.85 and belong to customers with years of orders, not to the TV spot’s first-timers." },
    { command: "models features checkout-risk", why: "session_pages_1h is late but well inside the freshness guard; every input is fresh." },
    { command: "models rollback checkout-risk", why: "Serves v22 again, at the threshold it was tuned for." },
    { command: "models list", why: "Customers declined back near 0.4%." },
  ],
  postmortem: {
    question: "Why were returning customers declined this morning?",
    options: [
      "v23’s recalibration pushed good customers’ scores past 0.85",
      "The TV spot brought a wave of risky first-time shoppers to checkout",
      "features_session_hourly ran late and served stale session data",
      "Card testers raised the base fraud rate the scorer was trained on",
    ],
    answerIndex: 0,
    explanation: {
      cause: "checkout-risk v23’s isotonic recalibration moved good customers’ scores above the 0.85 threshold.",
      why: "Recalibrating changes what every score means, but the threshold was tuned for v22’s scale. A band of loyal customers who used to score around 0.6 now scored 0.86–0.92 and were declined. Holdout recall rose, so the gate promoted it. Rolling back to v22 restores scores the threshold fits.",
      tell: "Declines began at v23’s 07:18 deploy, 81% of them scored 0.85–0.93 with a median of 9 prior orders, first-time shoppers were declined less than returning ones, and every input was fresh.",
    },
  },
});

/** Share of declines on first-time shoppers: low while a version declines loyal customers, normal otherwise. */
function shiftedShare(state: ClusterState, whileBroken: number, normal: number): number {
  const fraud = scorerOf(state);
  const v = fraud && activeVersion(fraud);
  return v && v.falseDeclineShare > 0.01 ? whileBroken : normal;
}

// ── 2. The version before the bad one is bad too ──────────────────────────────────────────────────

const twoBadVersions = incident({
  id: "data-t2-two-bad-versions",
  title: "Declines since yesterday afternoon",
  severity: "SEV2",
  opensAt: 9 * HOUR + 5 * MINUTE,
  briefing:
    "txn-risk shipped a new version at 08:27 and declines are up: about one checkout in fourteen, mostly gift and flower orders. Support says some customers were declined last night too, before the new version existed. Get the scorer back to a version that doesn’t do this.",
  roleBriefing: SCORER_BRIEFING("txn-risk"),
  scorer: {
    model: "txn-risk",
    versions: [
      version("v29", -9 * DAY, "weekly retrain", 0.005, 0.95),
      version("v30", -17 * HOUR - 20 * MINUTE, "daily retrain + merchant_category_embedding (ML-902)", 0.071, 0.958),
      version("v31", -38 * MINUTE, "daily retrain", 0.074, 0.96),
    ],
    active: "v31",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -6 * HOUR - 20 * MINUTE),
      feature("merchant_category_embedding", "features_catalog_daily", -5 * HOUR - 41 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -9 * MINUTE),
    ],
    fraudAttemptsPerSecond: 2.2,
  },
  evidence: [
    view("warehouse", "declines-by-hour", "Customers declined per hour since yesterday 15:00, with the version serving", (state) => {
      const w = window(state);
      const fraud = scorerOf(state);
      const rows = [
        ["15:00", "v29", "412218", "2061", "0.5"],
        ["16:00", "v29", "398004", "1990", "0.5"],
        ["17:00", "v30", "371530", "26379", "7.1"],
        ["20:00", "v30", "301277", "21391", "7.1"],
        ["23:00", "v30", "88140", "6258", "7.1"],
        ["03:00", "v30", "21904", "1555", "7.1"],
        ["07:00", "v30", "296551", "21055", "7.1"],
        ["08:00", "v30→v31", "389012", "28398", "7.3"],
      ];
      return [
        ...sqlTable(
          ["hour", "serving", "checkouts", "declined", "decline_pct"],
          [...rows, ["now (15 min)", fraud?.active ?? "?", n(w.customers), n(w.declined), (w.declinedShare * 100).toFixed(1)]],
        ),
        "v30 went live at 15:45 yesterday. The decline monitor needs 50 declines in 5 minutes per region; overnight volume stayed under it.",
      ];
    }),
    view("warehouse", "declines-by-category", "Customers declined in the last 15 min, by what was in the basket", (state) => {
      const w = window(state);
      const broken = shiftedShare(state, 1, 0) === 1;
      const rows: [string, number][] = broken
        ? [
            ["gift cards", 0.44],
            ["flowers & gifting", 0.31],
            ["apparel", 0.14],
            ["home", 0.11],
          ]
        : [
            ["gift cards", 0.29],
            ["flowers & gifting", 0.18],
            ["apparel", 0.31],
            ["home", 0.22],
          ];
      return sqlTable(["category", "customers_declined", "chargebacks_last_90d"], rows.map(([category, share]) => [category, n(w.declined * share), "0"]));
    }),
  ],
  suggestions: ["models show txn-risk", "models features txn-risk", "warehouse run declines-by-category", "warehouse run declines-by-hour"],
  lostCheckoutsPerPoint: 180,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Gift and flower orders are getting declined. Two customers say it happened last night too, around 21:00." },
    { at: 70, from: "Dev Raman · ML platform", text: "txn-risk v31 auto-promoted at 08:27. Rolling back is one command if it’s the model." },
    { at: 140, from: "Rina Nakamura · Risk", text: "Gift cards are our most-defrauded category, so some extra friction there is expected. Don’t open the floodgates." },
    { at: 230, from: "Kofi Mensah · Data science", text: "v31 is the same feature set as v30, just a day more data. The embedding came in with v30." },
    { at: 330, from: "Elena Ruiz · VP Engineering", text: "Are we rolling back or not?" },
  ],
  hints: [
    "The newest version is the obvious suspect. Check when declines actually started.",
    "Rolling back goes one version at a time unless you say where to.",
    "Find the last version whose decline rate looked like normal, and what changed after it.",
  ],
  solution: [
    { command: "models show txn-risk", why: "v31 declines 7.4% live, but v30 declined 7.1% while it served; v29 declined 0.5%." },
    { command: "warehouse run declines-by-hour", why: "Declines jumped at v30’s 15:45 deploy yesterday and stayed there overnight, under the monitor’s volume floor." },
    { command: "models rollback txn-risk --to v29", why: "Skips v30, which carries the same embedding, and serves v29." },
    { command: "models list", why: "Customers declined back near 0.5%." },
  ],
  postmortem: {
    question: "What was declining gift and flower buyers?",
    options: [
      "The merchant_category_embedding that v30 and v31 both use",
      "v31’s extra day of training data overfit to last night’s fraud",
      "Risk’s deliberate extra friction on the gift-card category",
      "A stale catalog feature served as a brand-new customer default",
    ],
    answerIndex: 0,
    explanation: {
      cause: "merchant_category_embedding, added in v30 and kept in v31, scored gifting baskets as fraud.",
      why: "Gift cards are the most-defrauded category, so the embedding learned to push every gifting basket toward 1. v30 shipped it at 15:45 yesterday; overnight volume stayed under the monitor’s floor, so nobody was paged until v31 met the morning rush. Rolling back one step lands on v30, which declines just as many. v29 predates the embedding.",
      tell: "models show: v30 7.1% while serving, v29 0.5%. Declines jumped at 17:00 yesterday, not at 08:27, and the declined baskets were gifting with no chargebacks.",
    },
  },
});

// ── 3. Refunds relabelled as fraud; "just raise the threshold" ────────────────────────────────────

const relabelled = incident({
  id: "data-t2-refunds-labelled-fraud",
  title: "Returners look like fraudsters",
  severity: "SEV2",
  opensAt: 13 * HOUR + 10 * MINUTE,
  briefing:
    "Since about 11:00 customers who sent something back recently can’t check out: card-risk declines them. Risk retrained the model this morning to catch friendly fraud, and chargebacks are genuinely up this month. Product wants the threshold raised. Find what is actually declining them.",
  roleBriefing: SCORER_BRIEFING("card-risk"),
  scorer: {
    model: "card-risk",
    versions: [version("v7", -20 * DAY, "monthly retrain", 0.004, 0.94), version("v8", -2 * HOUR - 12 * MINUTE, "retrain on relabelled chargebacks (RISK-602)", 0.088, 0.975)],
    active: "v8",
    features: [
      feature("customer_refunds_90d", "features_refunds_daily", -9 * HOUR - 50 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -10 * HOUR - 5 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 4,
  },
  evidence: [
    view("warehouse", "declined-by-returns", "Customers declined in the last 15 min, by refunds and chargebacks on their account", (state) => {
      const w = window(state);
      const broken = shiftedShare(state, 1, 0) === 1;
      const rows: [string, number][] = broken
        ? [
            ["0 refunds", 0.29],
            ["1 refund", 0.38],
            ["2+ refunds", 0.33],
          ]
        : [
            ["0 refunds", 0.71],
            ["1 refund", 0.19],
            ["2+ refunds", 0.1],
          ];
      return sqlTable(["refunds_90d", "customers_declined", "chargebacks_lifetime"], rows.map(([bucket, share]) => [bucket, n(w.declined * share), "0"]));
    }),
    view("warehouse", "chargebacks-90d", "Chargebacks and refunds per week, last 12 weeks", () =>
      sqlTable(
        ["week", "orders", "refunds", "chargebacks", "chargeback_pct"],
        [
          ["2026-07-20", "1902211", "95110", "1141", "0.06"],
          ["2026-08-17", "1877306", "93865", "1164", "0.06"],
          ["2026-09-14", "1921480", "96074", "1268", "0.07"],
          ["2026-10-05", "1950322", "97516", "1365", "0.07"],
        ],
      ),
    ),
  ],
  suggestions: ["models show card-risk", "models features card-risk", "warehouse run chargebacks-90d", "warehouse run declined-by-returns"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Every declined customer I’ve looked at returned something in the last month or two. One returned a jacket that didn’t fit." },
    { at: 80, from: "Rina Nakamura · Risk", text: "Chargebacks are up 18% on last quarter. v8 shipped at 10:58 retrained on labels where refunds count as friendly fraud (RISK-602). That was deliberate." },
    { at: 150, from: "Jonah Reyes · Product", text: "Can we just raise the threshold to 0.95? Fewer people declined, same model, everybody’s happy." },
    { at: 240, from: "Kofi Mensah · Data science", text: "For what it’s worth, a refund means we got the goods back. A chargeback means we didn’t." },
    { at: 340, from: "Elena Ruiz · VP Engineering", text: "Loyal customers who returned a sweater are being treated as criminals. Where are we?" },
  ],
  hints: [
    "Look at what the declined customers have in common, and at what they don’t have.",
    "A higher bar declines fewer of everyone. It doesn’t change who the scorer thinks is risky.",
    "Something changed what the scorer was taught this morning.",
  ],
  solution: [
    { command: "models show card-risk", why: "v8 went live at 10:58 and declines about 9% of customers; v7 declined 0.4%." },
    { command: "warehouse run declined-by-returns", why: "71% of declined customers have a recent refund and none has ever charged back: v8 learned refunds as fraud." },
    { command: "models rollback card-risk", why: "Serves v7, trained on real chargebacks, at its tuned threshold." },
    { command: "models list", why: "Customers declined back near 0.4%." },
  ],
  postmortem: {
    question: "Why were customers with recent returns declined?",
    options: [
      "card-risk v8 was trained to treat refunds as fraud",
      "The threshold sat too low for this month’s higher chargeback rate",
      "Chargebacks rose 18% and the scorer was reacting to real fraud",
      "customer_refunds_90d went stale and served its default to everyone",
    ],
    answerIndex: 0,
    explanation: {
      cause: "card-risk v8 was retrained on labels that counted every refund as friendly fraud.",
      why: "A refund returns the goods; a chargeback doesn’t. Labelling refunds as fraud taught v8 that a recent return means risk, so customers who sent back a jacket scored above 0.85. Raising the threshold to 0.95 would still decline about 4% and let more card fraud through. v7 was trained on chargebacks alone.",
      tell: "Declines began at v8’s 10:58 deploy, 71% of declined customers had refunds and none a chargeback, and every input was fresh.",
    },
  },
});

// ── 4. An experiment ramp sends every checkout to the challenger ──────────────────────────────────

const challenger = incident({
  id: "data-t2-challenger-at-full-ramp",
  title: "The challenger took every checkout",
  severity: "SEV2",
  opensAt: 15 * HOUR + 40 * MINUTE,
  briefing:
    "Declines jumped to about one checkout in fifteen twenty minutes ago. Risk says card testing is up this afternoon, and the card-velocity feature has been lagging since lunch. order-risk has a challenger model in an experiment. Decide which of these is costing customers.",
  roleBriefing: SCORER_BRIEFING("order-risk"),
  scorer: {
    model: "order-risk",
    versions: [version("v14", -11 * DAY, "weekly retrain", 0.0045, 0.96), version("v15", -19 * MINUTE, "challenger promoted: EXP-77 ramp set to 100%", 0.066, 0.982)],
    active: "v15",
    features: [
      feature("device_age_days", "features_device_daily", -4 * HOUR - 6 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -48 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -12 * HOUR - 30 * MINUTE),
    ],
    fraudAttemptsPerSecond: 25,
  },
  evidence: [
    view("warehouse", "champion-vs-challenger", "Decline rates per arm of EXP-77 since it started", (state) => {
      const w = window(state);
      const serving = scorerOf(state)?.active ?? "?";
      return [
        ...sqlTable(
          ["window", "arm", "traffic_pct", "customers", "declined", "decline_pct"],
          [
            ["09:00-15:20", "v14 (champion)", "95", "2601144", "11705", "0.45"],
            ["09:00-15:20", "v15 (challenger)", "5", "136901", "9035", "6.60"],
            ["last 15 min", serving, "100", n(w.customers), n(w.declined), (w.declinedShare * 100).toFixed(2)],
          ],
        ),
        "EXP-77 ramp changed 5% → 100% at 15:21 (experiments-api, by experiments-bot).",
      ];
    }),
    view("warehouse", "card-testing", "Small authorizations in the last 15 min, by card BIN", (state) => {
      const w = window(state);
      const bins: [string, number][] = [
        ["457173", 0.52],
        ["531106", 0.48],
      ];
      return sqlTable(
        ["card_bin", "amount_usd", "attempts", "approved"],
        bins.map(([bin, share]) => [bin, "0.50", n(w.fraudAttempts * share), n(w.fraudApproved * share)]),
      );
    }),
  ],
  suggestions: ["models show order-risk", "models features order-risk", "pipelines list", "warehouse run card-testing", "warehouse run champion-vs-challenger"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Rina Nakamura · Risk", text: "Card testers are back: about 25 fifty-cent auths a second since 15:00. Expect the scorer to be busy." },
    { at: 75, from: "Tomas Berg · Data eng", text: "features_card_velocity has been running slow since lunch, its last good run was 14:52. Kafka consumer lag, we’re on it." },
    { at: 130, from: "Maya Okonkwo · Support", text: "Normal customers declined. None of them look like card testers to me." },
    { at: 210, from: "Priya Shah · Growth", text: "EXP-77 was meant to go to 25% today, not 100%. Who changed the ramp?" },
    { at: 320, from: "Elena Ruiz · VP Engineering", text: "Is this the testers or is this us?" },
  ],
  hints: [
    "Count how many fraud attempts there are against how many customers are being declined.",
    "An input that lags by an hour is still inside the freshness guard.",
    "Compare the decline rates of the two arms of the experiment before this afternoon.",
  ],
  solution: [
    { command: "models show order-risk", why: "The challenger v15 went to 100% at 15:21 and declines 6.6% of customers; v14 declined 0.45%." },
    { command: "warehouse run champion-vs-challenger", why: "At 5% of traffic all day the challenger declined fifteen times as many customers as the champion; the ramp went to 100% at 15:21." },
    { command: "models rollback order-risk", why: "Serves the champion v14 again. The card testers are still caught." },
    { command: "models list", why: "Customers declined back near 0.45%." },
  ],
  postmortem: {
    question: "Why did declines jump this afternoon?",
    options: [
      "EXP-77’s ramp sent every checkout to the v15 challenger",
      "The card-testing wave crowded real customers out of the scorer",
      "features_card_velocity lagged and served stale velocity counts",
      "Risk tightened the threshold to stop the fifty-cent card testers",
    ],
    answerIndex: 0,
    explanation: {
      cause: "EXP-77’s ramp went from 5% to 100%, so the challenger v15 scored every checkout.",
      why: "At 5% the challenger’s 6.6% decline rate cost a few hundred customers a day and nobody noticed. At 100% it was one checkout in fifteen. The card testers were caught by both arms, and the velocity feature was late but well inside its 26 h guard. Rolling back serves the champion.",
      tell: "The jump lined up with the 15:21 ramp change, the challenger had declined 6.6% against the champion’s 0.45% all day, and fraud attempts were a fraction of the declines.",
    },
  },
});

// ── 5. A statement timeout on the replica fails the customer DAG; a new version takes the blame ───

const LTV_SQL = [
  "insert into features.customer_daily (customer_id, customer_ltv_365d, as_of)",
  "select o.customer_id, sum(o.total_cents), current_date",
  "from orders.orders o",
  "where o.status = 'paid'",
  "  and o.created_at >= current_date - 365",
  "group by o.customer_id",
].join("\n");

const statementTimeout = incident({
  id: "data-t2-statement-timeout",
  title: "The replica that said stop",
  severity: "SEV2",
  opensAt: 8 * HOUR + 20 * MINUTE,
  briefing:
    "fraud-scorer is declining one returning customer in ten, and it started before anyone was awake. A new model version went out at 18:10 last night. The DBAs changed something on the orders replica yesterday. Find out which one, before the morning rush doubles it.",
  roleBriefing: SCORER_BRIEFING("fraud-scorer"),
  scorer: {
    model: "fraud-scorer",
    versions: [version("v14", -15 * DAY, "weekly retrain", 0.004, 0.97), version("v15", -14 * HOUR - 10 * MINUTE, "weekly retrain", 0.005, 0.975)],
    active: "v15",
    features: [
      feature("customer_ltv_365d", "features_customer_daily", -29 * HOUR - 50 * MINUTE),
      // Its task waits for the 06:00 CDC snapshot, so yesterday it finished at 06:24.
      feature("customer_orders_90d", "features_customer_daily", goesStaleAt(240)),
      feature("device_age_days", "features_device_daily", -6 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -8 * MINUTE),
    ],
    staleFeatureDeclineShare: 0.1,
    fraudAttemptsPerSecond: 8,
  },
  failedRun: {
    dag: "features_customer_daily",
    feature: "customer_ltv_365d",
    at: 2 * HOUR + 47 * MINUTE + 12 - (8 * HOUR + 20 * MINUTE),
    runId: "scheduled__2026-10-09T02:00:00+00:00",
    executionDate: "20261009T020000",
    sql: LTV_SQL,
    error: ["psycopg2.errors.QueryCanceled: canceling statement due to statement timeout"],
  },
  evidence: [
    view("warehouse", "declined-checkouts", "Customers declined in the last 15 min, with the lifetime value the scorer saw and the real one", (state) => {
      const w = window(state);
      const stale = isStale(state, "customer_ltv_365d");
      const rows: [string, number, string][] = [
        ["3+ years", 0.58, "2140.00"],
        ["1-3 years", 0.3, "610.00"],
        ["< 1 year", 0.12, "85.00"],
      ];
      return sqlTable(
        ["tenure", "customers_declined", "ltv_365d_scored", "ltv_365d_actual"],
        rows.map(([tenure, share, ltv]) => [tenure, n(w.declined * share), stale ? "0.00" : ltv, ltv]),
      );
    }),
  ],
  suggestions: ["models show fraud-scorer", "models features fraud-scorer", "pipelines list", "warehouse run declined-checkouts"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Long-time customers declined since early this morning. Newer accounts seem fine." },
    { at: 70, from: "Dev Raman · ML platform", text: "fraud-scorer v15 went out at 18:10 last night. If it’s the model, rollback is one command." },
    { at: 150, from: "Hana Kim · DBA", text: "We set statement_timeout = '10min' on orders-replica at 17:00 yesterday to stop runaway BI queries (DBA-330). Reverted it at 07:55 when Data eng asked. Shouldn’t matter now." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Declines just went up again. What changed?" },
  ],
  hints: [
    "The scorer is only as good as what it’s fed. Check how old each input is.",
    "One version went out last night, but the first declines came hours later.",
    "Whatever stopped last night’s job has already been undone; the job just hasn’t run since.",
  ],
  solution: [
    { command: "models features fraud-scorer", why: "customer_ltv_365d last refreshed 29 h ago, past the 26 h guard: loyal customers are scored with zero lifetime value. customer_orders_90d is next." },
    { command: "pipelines logs features_customer_daily", why: "Last night’s run was cancelled by the replica’s statement timeout. The DBAs reverted the timeout at 07:55." },
    { command: "pipelines run features_customer_daily", why: "Rebuilds both customer features now instead of at 02:00 tomorrow." },
    { command: "models features fraud-scorer", why: "Both features go from refreshing to fresh within a minute; declines fall back to 0.5%." },
  ],
  postmortem: {
    question: "Why were long-standing customers declined this morning?",
    options: [
      "customer_ltv_365d went stale after its DAG hit a statement timeout",
      "fraud-scorer v15 learned to distrust customers with high spend",
      "The DBAs’ timeout made the scorer’s live lookups time out at checkout",
      "Card testers were using long-standing customers’ stolen cards",
    ],
    answerIndex: 0,
    explanation: {
      cause: "orders-replica’s new 10-minute statement timeout cancelled last night’s customer feature build.",
      why: "The 365-day LTV query runs about 25 minutes. Cancelled three times, it left customer_ltv_365d to age past the scorer’s 26 h guard, so it served the default 0: every loyal customer looked brand new. The timeout was reverted at 07:55 but the DAG only runs at 02:00; a manual run rebuilt both features. v15 had served fine all evening.",
      tell: "pipelines logs: QueryCanceled: canceling statement due to statement timeout. customer_ltv_365d was STALE, declines started hours after v15, and declined customers were scored on 0.00.",
    },
  },
});

// ── 6. A migration drops the grants on payments.refunds; a late DAG takes the blame ───────────────

const REFUNDS_SQL = [
  "insert into features.refunds_daily (customer_id, customer_refunds_90d, refund_amount_90d, as_of)",
  "select r.customer_id, count(*), sum(r.amount_cents), current_date",
  "from refunds r",
  "where r.created_at >= current_date - 90",
  "group by r.customer_id",
].join("\n");

const revokedGrant = incident({
  id: "data-t2-revoked-grant",
  title: "Permission denied, customers declined",
  severity: "SEV2",
  opensAt: 9 * HOUR + 30 * MINUTE,
  briefing:
    "payments-risk has declined about one checkout in ten since the small hours. The customer features DAG ran four hours late this morning. Payments partitioned the refunds table overnight. Work out which input the scorer is missing, and get it back before mid-morning traffic.",
  roleBriefing: SCORER_BRIEFING("payments-risk"),
  scorer: {
    model: "payments-risk",
    versions: [version("v8", -21 * DAY, "monthly retrain", 0.0045, 0.96), version("v9", -6 * DAY, "weekly retrain", 0.004, 0.965)],
    active: "v9",
    features: [
      feature("customer_refunds_90d", "features_refunds_daily", -27 * HOUR - 40 * MINUTE),
      // Built by the second task, after the dedupe step; yesterday it landed at 07:35.
      feature("refund_amount_90d", "features_refunds_daily", goesStaleAt(300)),
      feature("customer_orders_90d", "features_customer_daily", -2 * HOUR - 55 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -7 * MINUTE),
    ],
    staleFeatureDeclineShare: 0.09,
    fraudAttemptsPerSecond: 6,
  },
  failedRun: {
    dag: "features_refunds_daily",
    feature: "customer_refunds_90d",
    at: 3 * HOUR + 12 * MINUTE + 41 - (9 * HOUR + 30 * MINUTE),
    runId: "scheduled__2026-10-09T03:00:00+00:00",
    executionDate: "20261009T030000",
    sql: REFUNDS_SQL,
    error: ["psycopg2.errors.InsufficientPrivilege: permission denied for table refunds"],
  },
  evidence: [
    view("warehouse", "declined-checkouts", "Customers declined in the last 15 min, with the refunds the scorer saw and the real ones", (state) => {
      const w = window(state);
      const stale = isStale(state, "customer_refunds_90d");
      const rows: [string, number, string][] = [
        ["never refunded", 0.66, "0"],
        ["refunded once", 0.24, "1"],
        ["refunded 2+", 0.1, "3"],
      ];
      return [
        ...sqlTable(
          ["refund_history", "customers_declined", "refunds_90d_scored", "refunds_90d_actual"],
          rows.map(([history, share, actual]) => [history, n(w.declined * share), stale ? "-1" : actual, actual]),
        ),
        "-1 is the scorer’s missing-value sentinel: a customer whose refund history it couldn’t see.",
      ];
    }),
  ],
  suggestions: ["models show payments-risk", "models features payments-risk", "pipelines list", "warehouse run declined-checkouts"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 35, from: "Tomas Berg · Data eng", text: "features_customer_daily ran four hours late this morning because of the clickstream backfill. It finished at 06:35, all green now." },
    { at: 90, from: "Maya Okonkwo · Support", text: "Declines all morning, including customers who’ve never returned anything." },
    { at: 160, from: "Hana Kim · DBA", text: "Payments’ migration 0212 recreated payments.refunds as a partitioned table at 23:40. I re-granted SELECT to airflow_features at 09:12 after someone pinged." },
    { at: 280, from: "Elena Ruiz · VP Engineering", text: "Declines went up again in the last minute. Is anything getting better?" },
  ],
  hints: [
    "One DAG ran late this morning and one didn’t run at all. Only one of those matters to the scorer.",
    "An input past the freshness guard is served as if the customer had no history at all.",
    "The access problem that stopped the job has been fixed since. Nothing has rerun it.",
  ],
  solution: [
    { command: "models features payments-risk", why: "customer_refunds_90d is 27 h old and STALE; refund_amount_90d from the same DAG crosses the guard in minutes. customer_orders_90d is late but fresh." },
    { command: "pipelines logs features_refunds_daily", why: "Last night’s run: permission denied for table refunds, from the migration that recreated it. The grant was restored at 09:12." },
    { command: "pipelines run features_refunds_daily", why: "Rebuilds both refund features now." },
    { command: "models features payments-risk", why: "Both refund features go fresh within a minute; declines fall back to 0.4%." },
  ],
  postmortem: {
    question: "Why did payments-risk decline so many customers this morning?",
    options: [
      "The refunds DAG lost its grant on payments.refunds and went stale",
      "features_customer_daily ran four hours late and served stale orders",
      "Partitioning payments.refunds made the scorer’s lookups time out",
      "payments-risk v9 overweighted refunds after its weekly retrain",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Migration 0212 recreated payments.refunds without the airflow_features grant, failing the refunds DAG.",
      why: "Recreating a table drops its grants. The 03:00 run hit permission denied, customer_refunds_90d aged past the 26 h guard, and the scorer served its missing-value default to everyone, which it treats as risky. The grant came back at 09:12, but nothing reran the DAG until a manual run.",
      tell: "pipelines logs: InsufficientPrivilege: permission denied for table refunds. customer_refunds_90d was STALE, customer_orders_90d was late but fresh, and declined customers were scored on -1 refunds.",
    },
  },
});

// ── 7. Vault rotates the replica password; a new version takes the blame ──────────────────────────

const rotatedPassword = incident({
  id: "data-t2-rotated-password",
  title: "Every account is a new account",
  severity: "SEV2",
  opensAt: 10 * HOUR + 15 * MINUTE,
  briefing:
    "account-trust is declining customers who have shopped with us for years, about one in nine, and it’s getting worse. A new version went out at 17:00 yesterday. Vault rotated database credentials overnight. Decide what the scorer is missing.",
  roleBriefing: SCORER_BRIEFING("account-trust"),
  scorer: {
    model: "account-trust",
    versions: [version("v8", -13 * DAY, "weekly retrain", 0.0045, 0.955), version("v9", -17 * HOUR - 15 * MINUTE, "weekly retrain + email_domain_age (ML-917)", 0.005, 0.96)],
    active: "v9",
    features: [
      feature("account_orders_lifetime", "features_account_daily", -32 * HOUR - 5 * MINUTE),
      // Its task waits for the chargebacks export at 08:00, so yesterday it finished at 10:18.
      feature("account_chargebacks_lifetime", "features_account_daily", goesStaleAt(180)),
      feature("email_domain_age_days", "features_identity_daily", -7 * HOUR - 20 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -5 * MINUTE),
    ],
    staleFeatureDeclineShare: 0.1,
    fraudAttemptsPerSecond: 5,
  },
  failedRun: {
    dag: "features_account_daily",
    feature: "account_orders_lifetime",
    at: 2 * HOUR + 10 * MINUTE + 3 - (10 * HOUR + 15 * MINUTE),
    runId: "scheduled__2026-10-09T02:00:00+00:00",
    executionDate: "20261009T020000",
    error: [
      'psycopg2.OperationalError: connection to server at "orders-replica.internal" (10.20.4.17), port 5432 failed: FATAL:  password authentication failed for user "airflow_features"',
    ],
  },
  evidence: [
    view("warehouse", "declined-checkouts", "Customers declined in the last 15 min, with the lifetime orders the scorer saw and the real ones", (state) => {
      const w = window(state);
      const stale = isStale(state, "account_orders_lifetime");
      const rows: [string, number, string][] = [
        ["2020 or earlier", 0.47, "61"],
        ["2021-2024", 0.39, "17"],
        ["2025-2026", 0.14, "3"],
      ];
      return sqlTable(
        ["account_created", "customers_declined", "orders_lifetime_scored", "orders_lifetime_actual"],
        rows.map(([cohort, share, actual]) => [cohort, n(w.declined * share), stale ? "0" : actual, actual]),
      );
    }),
  ],
  suggestions: ["models show account-trust", "models features account-trust", "pipelines list", "warehouse run declined-checkouts"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Customers with accounts from 2019 declined. The account page says they’ve placed dozens of orders." },
    { at: 75, from: "Dev Raman · ML platform", text: "account-trust v9 went out yesterday at 17:00 with the new email_domain_age feature. Happy to roll back if you want." },
    { at: 140, from: "Ola Nordmann · Platform", text: "Vault rotated the orders-replica credentials at 01:00 (SEC-ROT-14). We updated the airflow_features connection in Airflow at 08:40 when we noticed." },
    { at: 230, from: "Elena Ruiz · VP Engineering", text: "Declines just climbed again. What’s the call?" },
  ],
  hints: [
    "The new version served all evening without complaint. Check what the scorer is fed this morning.",
    "An input past the freshness guard is served as zero, the value a brand-new account has.",
    "The credential problem was fixed hours ago. The job that needed it hasn’t run since.",
  ],
  solution: [
    { command: "models features account-trust", why: "account_orders_lifetime is 32 h old and STALE, account_chargebacks_lifetime from the same DAG crosses the guard any minute." },
    { command: "pipelines logs features_account_daily", why: "Last night’s run couldn’t log in to orders-replica: password authentication failed. Platform fixed the connection at 08:40." },
    { command: "pipelines run features_account_daily", why: "Rebuilds both account features now instead of at 02:00 tomorrow." },
    { command: "models features account-trust", why: "Both go fresh within a minute; declines fall back to 0.5%." },
  ],
  postmortem: {
    question: "Why did account-trust treat old accounts as new?",
    options: [
      "account_orders_lifetime went stale when a rotated password broke it",
      "account-trust v9’s email_domain_age feature penalised old email domains",
      "Vault’s rotation logged the scorer itself out of the feature store",
      "Fraudsters had taken over a batch of long-standing customer accounts",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Vault rotated orders-replica’s password at 01:00, so the 02:00 account features run couldn’t log in.",
      why: "With no successful run, account_orders_lifetime aged past the 26 h guard and was served as 0: a 2019 customer with 61 orders looked like a first-time account. Platform fixed the Airflow connection at 08:40, but the DAG wouldn’t run again until 02:00. v9 had served normally all evening.",
      tell: "pipelines logs: password authentication failed for user \"airflow_features\". account_orders_lifetime was STALE and declined customers were scored on 0 lifetime orders.",
    },
  },
});

// ── 8. A backfill leaves duplicate keys; a lagging velocity DAG takes the blame ───────────────────

const CARD_SQL = [
  "insert into features.card_daily (card_fingerprint, card_fingerprint_orders_30d, as_of)",
  "select c.card_fingerprint, count(*), current_date - 1",
  "from payments.charges c",
  "where c.status = 'captured'",
  "  and c.captured_at >= current_date - 30",
  "group by c.card_fingerprint",
].join("\n");

const duplicateKey = incident({
  id: "data-t2-backfill-duplicate-key",
  title: "Known cards, unknown to the scorer",
  severity: "SEV2",
  opensAt: 11 * HOUR,
  briefing:
    "basket-risk declines about one checkout in nine, almost all on cards we have charged many times before. The card-velocity DAG is lagging, and Data eng ran a backfill last night. Find which input the scorer has lost and restore it.",
  roleBriefing: SCORER_BRIEFING("basket-risk"),
  scorer: {
    model: "basket-risk",
    versions: [version("v3", -30 * DAY, "monthly retrain", 0.005, 0.95), version("v4", -4 * DAY, "monthly retrain", 0.0045, 0.955)],
    active: "v4",
    features: [
      feature("card_fingerprint_orders_30d", "features_card_daily", -32 * HOUR - 40 * MINUTE),
      // Built after the dedupe task, which waits for the 08:00 chargebacks file; yesterday it finished at 11:04.
      feature("card_distinct_accounts_30d", "features_card_daily", goesStaleAt(270)),
      feature("card_bin_velocity_1h", "features_card_velocity", -52 * MINUTE),
      feature("customer_orders_90d", "features_customer_daily", -8 * HOUR - 15 * MINUTE),
    ],
    staleFeatureDeclineShare: 0.1,
    fraudAttemptsPerSecond: 7,
  },
  failedRun: {
    dag: "features_card_daily",
    feature: "card_fingerprint_orders_30d",
    at: 2 * HOUR + 31 * MINUTE + 18 - 11 * HOUR,
    runId: "scheduled__2026-10-09T02:15:00+00:00",
    executionDate: "20261009T021500",
    sql: CARD_SQL,
    error: [
      'psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint "card_daily_pkey"',
      "DETAIL:  Key (card_fingerprint, as_of)=(fp_3e91c0a7d2, 2026-10-09) already exists.",
    ],
  },
  evidence: [
    view("warehouse", "declined-checkouts", "Customers declined in the last 15 min, by how often we’ve charged their card", (state) => {
      const w = window(state);
      const stale = isStale(state, "card_fingerprint_orders_30d");
      const rows: [string, number, string][] = [
        ["10+ charges", 0.52, "14"],
        ["2-9 charges", 0.37, "4"],
        ["first charge", 0.11, "0"],
      ];
      return sqlTable(
        ["card_history_30d", "customers_declined", "card_orders_30d_scored", "card_orders_30d_actual"],
        rows.map(([history, share, actual]) => [history, n(w.declined * share), stale ? "0" : actual, actual]),
      );
    }),
  ],
  suggestions: ["models show basket-risk", "models features basket-risk", "pipelines list", "warehouse run declined-checkouts"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Customers declined on cards they’ve used with us for years. Switching cards doesn’t always help." },
    { at: 80, from: "Sam Tan · SRE", text: "features_card_velocity is lagging, last success about 50 minutes ago. Kafka rebalance this morning. Could that be it?" },
    { at: 150, from: "Ingrid Solberg · Data eng", text: "I backfilled features.card_daily for last week at 23:00 (DATA-2291). It also wrote rows for 2026-10-09 by mistake; I deleted those at 08:50." },
    { at: 290, from: "Elena Ruiz · VP Engineering", text: "Declines are climbing. Do we know which feature yet?" },
  ],
  hints: [
    "One input lags by an hour; another hasn’t refreshed in more than a day. The freshness guard only cares about one of them.",
    "Read how last night’s run of the failing job ended.",
    "The rows that broke the job were cleaned up this morning. Nothing has retried it since.",
  ],
  solution: [
    { command: "models features basket-risk", why: "card_fingerprint_orders_30d is 32 h old and STALE; card_distinct_accounts_30d crosses the guard in minutes. Card velocity is late but fresh." },
    { command: "pipelines logs features_card_daily", why: "Last night’s run hit duplicate key on card_daily_pkey: the backfill had already written that day. Those rows were deleted at 08:50." },
    { command: "pipelines run features_card_daily", why: "Rebuilds both card features now." },
    { command: "models features basket-risk", why: "Both card features go fresh within a minute; declines fall back to 0.45%." },
  ],
  postmortem: {
    question: "Why were customers declined on cards we’d charged many times?",
    options: [
      "A backfill’s rows broke the card DAG and card features went stale",
      "features_card_velocity lagged after the Kafka rebalance this morning",
      "basket-risk v4 learned to distrust cards used on many accounts",
      "A card-testing ring was cycling through our customers’ saved cards",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Last night’s backfill wrote 2026-10-09 rows, so the scheduled card features run hit a duplicate key.",
      why: "The insert collided with the backfilled rows on card_daily_pkey and failed three times. card_fingerprint_orders_30d aged past the 26 h guard and was served as 0, so every known card looked new. The rows were deleted at 08:50, but nothing reran the DAG. Card velocity was late but fresh.",
      tell: "pipelines logs: UniqueViolation on \"card_daily_pkey\" for 2026-10-09. card_fingerprint_orders_30d was STALE, and declined cards were scored on 0 orders while the warehouse showed many.",
    },
  },
});

// ── 9. The feature store's disk fills; someone wants a higher threshold ───────────────────────────

const RETURNS_SQL = [
  "insert into features.returns_daily (customer_id, customer_returns_90d, as_of)",
  "select r.customer_id, count(*), current_date",
  "from orders.returns r",
  "where r.received_at >= current_date - 90",
  "group by r.customer_id",
].join("\n");

const diskFull = incident({
  id: "data-t2-feature-store-disk-full",
  title: "No space left for good customers",
  severity: "SEV2",
  opensAt: 7 * HOUR + 50 * MINUTE,
  briefing:
    "checkout-guard is declining about one checkout in nine this morning and the early shoppers are noticing. Risk suggests raising the decline threshold until it settles. SRE had a disk alert on features-db overnight. Work out what changed for the scorer.",
  roleBriefing: SCORER_BRIEFING("checkout-guard"),
  scorer: {
    model: "checkout-guard",
    versions: [version("v5", -16 * DAY, "weekly retrain", 0.005, 0.95), version("v6", -2 * DAY, "weekly retrain", 0.005, 0.955)],
    active: "v6",
    features: [
      feature("customer_returns_90d", "features_returns_daily", -28 * HOUR),
      // Its task runs after the warehouse returns export lands at 07:00; yesterday it finished at 07:53.
      feature("return_rate_90d", "features_returns_daily", goesStaleAt(200)),
      feature("customer_orders_90d", "features_customer_daily", -5 * HOUR - 5 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -6 * MINUTE),
    ],
    staleFeatureDeclineShare: 0.11,
    fraudAttemptsPerSecond: 6,
  },
  failedRun: {
    dag: "features_returns_daily",
    feature: "customer_returns_90d",
    at: 2 * HOUR + 52 * MINUTE + 30 - (7 * HOUR + 50 * MINUTE),
    runId: "scheduled__2026-10-09T02:30:00+00:00",
    executionDate: "20261009T023000",
    sql: RETURNS_SQL,
    error: ['psycopg2.errors.DiskFull: could not extend file "base/16384/48211": No space left on device', "HINT:  Check free disk space."],
  },
  evidence: [
    view("warehouse", "declined-checkouts", "Customers declined in the last 15 min, with the returns the scorer saw and the real ones", (state) => {
      const w = window(state);
      const stale = isStale(state, "customer_returns_90d");
      const rows: [string, number, string][] = [
        ["never returned", 0.69, "0"],
        ["returned 1-2", 0.25, "1"],
        ["returned 3+", 0.06, "4"],
      ];
      return [
        ...sqlTable(
          ["return_history", "customers_declined", "returns_90d_scored", "returns_90d_actual"],
          rows.map(([history, share, actual]) => [history, n(w.declined * share), stale ? "null" : actual, actual]),
        ),
        "A null input scores as the riskiest bucket the model knows.",
      ];
    }),
  ],
  suggestions: ["models show checkout-guard", "models features checkout-guard", "pipelines list", "warehouse run declined-checkouts"],
  lostCheckoutsPerPoint: 220,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Declines since we opened. Customers who’ve never returned a thing." },
    { at: 70, from: "Rina Nakamura · Risk", text: "If it’s too strict, raise the threshold to 0.9 for the morning. We can tune it back later." },
    { at: 140, from: "Sam Tan · SRE", text: "features-db hit 100% disk at 02:41: an old Debezium replication slot was holding WAL. Dropped the slot at 07:10, disk is at 41% now." },
    { at: 250, from: "Elena Ruiz · VP Engineering", text: "It just got worse. What are we doing?" },
  ],
  hints: [
    "Loosening the bar declines fewer of everyone. Find out why these customers score high in the first place.",
    "Look at how old each of the scorer’s inputs is.",
    "The disk has room again. Whatever failed on it hasn’t had another go.",
  ],
  solution: [
    { command: "models features checkout-guard", why: "customer_returns_90d is 28 h old and STALE; return_rate_90d from the same DAG crosses the guard in a few minutes." },
    { command: "pipelines logs features_returns_daily", why: "Last night’s run died with No space left on device on features-db. SRE freed the disk at 07:10." },
    { command: "pipelines run features_returns_daily", why: "Rebuilds both return features on the disk that now has room." },
    { command: "models features checkout-guard", why: "Both go fresh within a minute; declines fall back to 0.5%." },
  ],
  postmortem: {
    question: "Why did checkout-guard decline so many customers this morning?",
    options: [
      "customer_returns_90d went stale when features-db ran out of disk",
      "checkout-guard’s threshold was too strict for the morning traffic",
      "checkout-guard v6 learned to treat any past return as fraud",
      "The full disk made the scorer time out and decline by default",
    ],
    answerIndex: 0,
    explanation: {
      cause: "features-db filled up at 02:41, so the returns features run failed writing its table.",
      why: "A forgotten replication slot held WAL until the disk was full. The returns DAG failed with No space left on device, customer_returns_90d aged past the 26 h guard, and the scorer served null, its riskiest bucket. Raising the threshold to 0.9 would still decline about one in nine. A manual run after the disk was freed rebuilt both features.",
      tell: "pipelines logs: DiskFull: could not extend file … No space left on device. customer_returns_90d was STALE and declined customers who had never returned anything were scored on null.",
    },
  },
});

// ── 10. A config push swaps two digits of the threshold; the morning's retrain takes the blame ────

const digitSwap = incident({
  id: "data-t2-threshold-digit-swap",
  title: "Point three eight",
  severity: "SEV2",
  opensAt: 12 * HOUR,
  briefing:
    "Since 11:42 risk-engine declines about one checkout in seven. A new version retrained overnight went live this morning, and fraud is running a little above normal. Nobody admits to changing anything. Find what moved.",
  roleBriefing: SCORER_BRIEFING("risk-engine"),
  scorer: {
    model: "risk-engine",
    versions: [version("v40", -8 * DAY, "weekly retrain", 0.0045, 0.965), version("v41", -6 * HOUR - 4 * MINUTE, "weekly retrain", 0.004, 0.97)],
    active: "v41",
    threshold: 0.38,
    tunedThreshold: 0.83,
    features: [
      feature("customer_orders_90d", "features_customer_daily", -9 * HOUR - 30 * MINUTE),
      feature("device_age_days", "features_device_daily", -8 * HOUR - 50 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -5 * MINUTE),
    ],
    fraudAttemptsPerSecond: 6,
  },
  evidence: [
    view("models", "audit", "Serving-config changes to risk-engine in the last 24 h", (state) => {
      const fraud = scorerOf(state);
      return [
        ...table([
          ["TIME", "BY", "CHANGE", "TICKET"],
          ["06:04", "ml-release-bot", "serving v40 → v41", "ML-930"],
          ["11:42", "r.nakamura", "review_queue_size 400 → 600; decline_threshold 0.83 → 0.38", "CFG-1188"],
          ...(fraud && fraud.threshold !== 0.38 ? [["now", "you", `decline_threshold 0.38 → ${fraud.threshold}`, "-"]] : []),
        ]),
        "CFG-1188 description: “Raise the manual review queue to 600 for the weekend.”",
      ];
    }),
    view("warehouse", "declines-by-minute", "Customers declined per minute around 11:42", (state) => {
      const w = window(state);
      return sqlTable(
        ["minute", "customers", "declined", "decline_pct"],
        [
          ["11:40", "7212", "29", "0.4"],
          ["11:41", "7180", "31", "0.4"],
          ["11:42", "7244", "498", "6.9"],
          ["11:43", "7198", "1001", "13.9"],
          ["last 15 min avg", n(w.customers / 15), n(w.declined / 15), (w.declinedShare * 100).toFixed(1)],
        ],
      );
    }),
  ],
  suggestions: ["models show risk-engine", "models audit", "models features risk-engine", "warehouse run declines-by-minute"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Maya Okonkwo · Support", text: "Huge wave of declines just before noon, all kinds of customers." },
    { at: 70, from: "Dev Raman · ML platform", text: "v41 went live at 06:04 this morning. It’s the only model change today." },
    { at: 130, from: "Rina Nakamura · Risk", text: "I pushed CFG-1188 at 11:42, but that only raised the manual review queue for the weekend. Nothing to do with declines." },
    { at: 220, from: "Grace Liu · Finance", text: "Lunch is our second-biggest hour. Please tell me this is nearly fixed." },
  ],
  hints: [
    "The new version served for almost six hours without trouble. Look at the minute it started.",
    "A config change can carry more than its description says.",
    "Rolling back a version doesn’t touch serving config.",
  ],
  solution: [
    { command: "models show risk-engine", why: "Threshold 0.38, tuned to 0.83. A score at or above it is declined, so about 14% of good customers are." },
    { command: "models audit", why: "CFG-1188 at 11:42 changed the review queue, and decline_threshold 0.83 → 0.38: two digits swapped." },
    { command: "models threshold risk-engine 0.83", why: "Back where it was tuned." },
    { command: "models list", why: "Customers declined back near 0.4%." },
  ],
  postmortem: {
    question: "Why did declines jump at 11:42?",
    options: [
      "A config push changed the decline threshold from 0.83 to 0.38",
      "risk-engine v41 began declining customers as lunch traffic grew",
      "Raising the manual review queue sent more checkouts to decline",
      "Fraud above normal levels pushed more customers over the threshold",
    ],
    answerIndex: 0,
    explanation: {
      cause: "CFG-1188 set risk-engine’s decline threshold to 0.38 instead of 0.83, a digit swap.",
      why: "The push meant to raise the review queue also rewrote the threshold. Every good customer scoring between 0.38 and 0.83 was declined, about one in seven. v41 had been serving fine since 06:04, and rolling it back would keep the threshold, since serving config stays put. Restoring 0.83 fixed it.",
      tell: "Declines jumped in the 11:42 minute, models show read threshold 0.38 against a tuned 0.83, and the audit showed CFG-1188 changing decline_threshold.",
    },
  },
});

// ── 11. An experiment's cleanup leaves the last arm's threshold; the runbook number is wrong too ──

const sweepLeftBehind = incident({
  id: "data-t2-sweep-left-behind",
  title: "The sweep that never swept up",
  severity: "SEV2",
  opensAt: 14 * HOUR + 25 * MINUTE,
  briefing:
    "Since about 13:50 cnp-scorer declines roughly one checkout in thirteen. Data science ran a threshold sweep this afternoon and says it’s finished. The ops runbook lists a standard threshold. Get the scorer back where it belongs.",
  roleBriefing: SCORER_BRIEFING("cnp-scorer"),
  scorer: {
    model: "cnp-scorer",
    versions: [version("v11", -24 * DAY, "monthly retrain", 0.0065, 0.97), version("v12", -10 * DAY, "monthly retrain + recalibration", 0.0062, 0.975)],
    active: "v12",
    threshold: 0.6,
    tunedThreshold: 0.92,
    features: [
      feature("customer_orders_90d", "features_customer_daily", -11 * HOUR - 10 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -3 * MINUTE),
    ],
    fraudAttemptsPerSecond: 10,
  },
  evidence: [
    view("warehouse", "declines-by-arm", "EXP-90 threshold sweep: decline and fraud-catch rate per arm", (state) => {
      const w = window(state);
      const threshold = scorerOf(state)?.threshold ?? 0;
      return [
        ...sqlTable(
          ["arm", "threshold", "window", "decline_pct", "fraud_caught_pct"],
          [
            ["A (control)", "0.92", "12:00-13:50", "0.62", "97.5"],
            ["B", "0.80", "12:00-13:50", "1.61", "98.4"],
            ["C", "0.70", "12:00-13:50", "3.55", "98.9"],
            ["D", "0.60", "12:00-13:50", "7.80", "99.3"],
            ["all traffic", threshold.toFixed(2), "last 15 min", (w.declinedShare * 100).toFixed(2), pct(w.fraudAttempts - w.fraudApproved, w.fraudAttempts)],
          ],
        ),
        "Sweep cleanup (exp-runner) at 13:50: “restore threshold” wrote the value of the last arm it iterated over.",
      ];
    }),
  ],
  suggestions: ["models show cnp-scorer", "models list", "warehouse run declines-by-arm"],
  lostCheckoutsPerPoint: 140,
  externals: [gatewayOk("≈180 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_LOST },
    { at: 30, from: "Kofi Mensah · Data science", text: "EXP-90 threshold sweep finished at 13:50. The runner restores the threshold automatically, so we should be back to normal." },
    { at: 90, from: "Sam Tan · SRE", text: "Runbook RB-7 says the standard decline threshold is 0.85. Want me to set it?" },
    { at: 160, from: "Maya Okonkwo · Support", text: "Declines have been elevated since about two o’clock. Ordinary customers." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Can we get this back to exactly how it was this morning?" },
  ],
  hints: [
    "An experiment that changed a setting has to put it back. Check that it did.",
    "Runbooks go stale. The number that matters is the one this version was tuned to.",
    "Control arms show what normal looked like an hour ago.",
  ],
  solution: [
    { command: "models show cnp-scorer", why: "Threshold 0.6 against a tuned 0.92: the sweep’s last arm, not the control." },
    { command: "warehouse run declines-by-arm", why: "Arm D at 0.60 declined 7.8%; the control at 0.92 declined 0.62%. The cleanup restored the wrong arm." },
    { command: "models threshold cnp-scorer 0.92", why: "Back to the tuned value the control ran on. RB-7’s 0.85 predates v12’s recalibration." },
    { command: "models list", why: "Customers declined back near 0.6%." },
  ],
  postmortem: {
    question: "Why were more customers declined after 13:50?",
    options: [
      "EXP-90’s cleanup left the threshold at arm D’s 0.60",
      "The runbook’s standard 0.85 threshold was too strict for cnp-scorer",
      "cnp-scorer v12’s recalibration began to drift during the experiment",
      "The sweep’s arms split traffic and starved the control of good data",
    ],
    answerIndex: 0,
    explanation: {
      cause: "EXP-90’s cleanup wrote the last arm’s threshold, 0.60, instead of the control’s 0.92.",
      why: "The runner’s restore step kept the value of the last arm it iterated over. Every good customer scoring 0.60–0.92 was declined. RB-7’s 0.85 was tuned for v11; at 0.85 v12 still declines over 1% and isn’t where the model was tuned. 0.92, the control arm, is.",
      tell: "models show: threshold 0.6, tuned 0.92. declines-by-arm: arm D at 0.60 declined 7.8%, the 0.92 control 0.62%, and all traffic now matched arm D.",
    },
  },
});

// ── 12. Left in fail-open after a node-pool move; card testers saturate the gateway ───────────────

const failOpenMigration = incident({
  id: "data-t2-fail-open-after-migration",
  title: "Nobody switched it back on",
  severity: "SEV1",
  opensAt: 9 * HOUR + 50 * MINUTE,
  briefing:
    "Checkout is timing out at the payment step and payment-gateway’s status page shows elevated latency. A card-testing ring started a few minutes ago. An iOS release went out this morning. checkout-shield moved to a new node pool at dawn. Get customers paying again.",
  roleBriefing:
    "Data on-call: models (checkout-shield, the scorer in front of the payment gateway), pipelines and the warehouse. Whatever the scorer approves goes to the gateway, which caps us at 160 charges a second; a call queued past checkout-api’s 3 s timeout fails the customer.",
  scorer: {
    model: "checkout-shield",
    versions: [version("v18", -12 * DAY, "weekly retrain", 0.004, 0.97), version("v19", -5 * DAY, "weekly retrain", 0.0045, 0.98)],
    active: "v19",
    mode: "fail-open",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -7 * HOUR),
      feature("card_bin_velocity_1h", "features_card_velocity", -4 * MINUTE),
    ],
    fraudAttemptsPerSecond: 42,
  },
  gatewayChargesPerSecond: 160,
  gatewayBacklogSeconds: 2.1,
  evidence: [
    view("warehouse", "gateway-traffic", "Charges sent to payment-gateway in the last 15 min, by amount and BIN", (state) => {
      const w = window(state);
      const rows: [string, string, number][] = [
        ["1.00", "434256", 0.55],
        ["1.00", "414720", 0.45],
      ];
      return [
        ...sqlTable(
          ["amount_usd", "card_bin", "charges_sent", "score_p50"],
          [...rows.map(([amount, bin, share]) => [amount, bin, n(w.fraudApproved * share), "0.99"]), ["(customer orders)", "various", n(w.customers - w.declined), "0.04"]],
        ),
        isFailOpen(state) ? "Scored but not acted on: the scorer is approving everything." : "Scores at or above the threshold are declined before the gateway.",
      ];
    }),
  ],
  suggestions: ["models list", "models show checkout-shield", "warehouse run gateway-traffic"],
  lostCheckoutsPerPoint: 300,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Elevated latency for some merchants" },
        { key: "Throughput for us", value: "≈160 charges/s contracted; excess queues FIFO" },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% (payment timeouts). Data on-call paged." },
    { at: 25, from: "Sam Tan · SRE", text: "payment-gateway’s status page says elevated latency for some merchants. Could be them." },
    { at: 60, from: "Rina Nakamura · Risk", text: "A card-testing ring started firing $1 auths at 09:48, about 40 a second. The scorer should be eating them." },
    { at: 100, from: "Jonah Reyes · Product", text: "iOS 7.3.1 rolled out this morning, maybe it’s that?" },
    { at: 150, from: "Dev Raman · ML platform", text: "We moved checkout-shield to the new node pool at 05:30 (MLP-415). Health checks flapped so we put it in fail-open per the runbook. It’s been green since 05:45." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout is falling over. What’s the call?" },
  ],
  hints: [
    "Look at who is sending charges to the gateway right now.",
    "A scorer can score every request and still decide nothing.",
    "A safety switch flipped during maintenance has to be flipped back.",
  ],
  solution: [
    { command: "models list", why: "checkout-shield is in fail-open: every checkout approved, card testers included." },
    { command: "warehouse run gateway-traffic", why: "About 40 $1 charges a second from two BINs, scored 0.99 and sent on anyway, on a gateway with 40 a second of headroom." },
    { command: "models mode checkout-shield enforce", why: "Declines the ring before the gateway again; the queue drains in seconds." },
    { command: "models show checkout-shield", why: "Enforcing at 0.85; fraud attempts caught, customers declined near 0.45%." },
  ],
  postmortem: {
    question: "Why were customers timing out at payment?",
    options: [
      "checkout-shield was left in fail-open and approved card testers",
      "payment-gateway had an outage that slowed every merchant’s charges",
      "iOS 7.3.1 retried payment calls and doubled the gateway’s load",
      "The card testers overloaded checkout-shield’s new node pool",
    ],
    answerIndex: 0,
    explanation: {
      cause: "checkout-shield stayed in fail-open after its 05:30 node-pool move, so it approved the card-testing ring.",
      why: "Fail-open was harmless until something worth declining arrived. At 09:48 a ring began sending 40 $1 auths a second; the scorer flagged them at 0.99 and approved them anyway. With 120 customer charges a second the gateway ran over its 160 cap, its queue grew past checkout-api’s 3 s timeout, and real customers failed.",
      tell: "models list showed fail-open, the gateway queue held $1 charges from two BINs scored 0.99, and the status page’s latency was our own queue.",
    },
  },
});

// ── 13. Failed open overnight; chargeback exposure, and "lower the threshold" ─────────────────────

const failOpenOvernight = incident({
  id: "data-t2-fail-open-overnight",
  title: "Approved all night",
  severity: "SEV2",
  opensAt: 8 * HOUR + 5 * MINUTE,
  briefing:
    "The chargeback-exposure monitor paged: about one charge in five reaching payment-gateway is a card tester’s. Risk thinks a new BIN attack is beating payment-risk and wants it tightened. Customers aren’t complaining. Stop the fraud without declining good customers.",
  roleBriefing:
    "Data on-call: models (payment-risk, the scorer in front of the payment gateway), pipelines and the warehouse. Whatever the scorer approves is charged. Each fraudulent capture comes back as a chargeback and a $15 fee within weeks.",
  scorer: {
    model: "payment-risk",
    versions: [version("v17", -16 * DAY, "weekly retrain", 0.0045, 0.975), version("v18", -2 * DAY, "weekly retrain", 0.004, 0.98)],
    active: "v18",
    mode: "fail-open",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -5 * HOUR - 45 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -7 * MINUTE),
    ],
    fraudAttemptsPerSecond: 28,
  },
  gatewayChargesPerSecond: 220,
  alertMetric: FRAUD_SHARE_OF_CHARGES,
  fraudCaptureBound: 4000,
  evidence: [
    view("warehouse", "captured-by-score", "Charges captured in the last 15 min, by fraud score", (state) => {
      const w = window(state);
      const customers = w.customers - w.declined;
      return [
        ...sqlTable(
          ["score_band", "captured", "distinct_cards", "avg_amount_usd"],
          [
            ["0.00-0.50", n(customers * 0.97), n(customers * 0.95), "58.40"],
            ["0.50-0.85", n(customers * 0.03), n(customers * 0.03), "61.10"],
            ["0.85-1.00", n(w.fraudApproved), n(w.fraudApproved * 0.98), "2.00"],
          ],
        ),
        isFailOpen(state) ? "Every 0.85+ capture would have been declined in enforce mode." : "0.85+ captures are what the scorer still misses while enforcing.",
      ];
    }),
    view("models", "audit", "Mode and threshold changes to payment-risk in the last 24 h", (state) => {
      const fraud = scorerOf(state);
      return table([
        ["TIME", "BY", "CHANGE", "NOTE"],
        ["23:10", "oncall.mtan", "mode enforce → fail-open", "scorer 503s during v18 node drain; RB-12 says fail open"],
        ["23:25", "deploy-bot", "drain complete, 0 errors", "-"],
        ...(fraud && fraud.mode === "enforce" ? [["now", "you", "mode fail-open → enforce", "-"]] : []),
      ]);
    }),
  ],
  suggestions: ["models show payment-risk", "models audit", "warehouse run captured-by-score"],
  lostCheckoutsPerPoint: 200,
  externals: [gatewayOk("≈220 charges/s contracted; excess queues FIFO")],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — fraud share of gateway charges above 5% for 10m (chargeback exposure). Data on-call paged." },
    { at: 30, from: "Rina Nakamura · Risk", text: "New BIN attack, $2 auths, about 28 a second. payment-risk is clearly not catching it. Can you drop the threshold to 0.6?" },
    { at: 90, from: "Grace Liu · Finance", text: "Every one of those is a chargeback plus a $15 fee in a few weeks. Overnight it’s already six figures." },
    { at: 150, from: "Mia Tan · SRE", text: "Morning. I failed payment-risk open at 23:10 when it threw 503s during the node drain. Runbook says to. Did anyone flip it back?" },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Do we know why the fraud model isn’t stopping fraud?" },
  ],
  hints: [
    "Check what the scorer thinks of the charges getting through.",
    "A stricter bar only matters if the scorer is acting on its scores.",
    "Something was switched off overnight for a good reason that no longer holds.",
  ],
  solution: [
    { command: "models show payment-risk", why: "Mode fail-open: every checkout approved, scores logged and ignored." },
    { command: "warehouse run captured-by-score", why: "The card testers score 0.85+ and are captured anyway: the model catches them, nothing acts on it." },
    { command: "models mode payment-risk enforce", why: "Declines them again at the tuned threshold; good customers barely notice." },
    { command: "models list", why: "Enforcing; fraud share of charges falls under 1%." },
  ],
  postmortem: {
    question: "Why was card-testing fraud reaching the gateway?",
    options: [
      "payment-risk was left in fail-open after the node drain",
      "The new $2 BIN attack scored below payment-risk’s threshold",
      "payment-risk v18 was retrained without last month’s fraud labels",
      "The threshold of 0.85 was too lenient for this week’s fraud rate",
    ],
    answerIndex: 0,
    explanation: {
      cause: "payment-risk was failed open at 23:10 during a node drain and never switched back to enforce.",
      why: "Fail-open approves every checkout and only logs the score. The drain finished at 23:25 with no errors, but the mode stayed. The card testers scored 0.85–1.00 all night and were captured anyway. Lowering the threshold would change nothing while nothing enforces it; enforcing at 0.85 catches 98% of them.",
      tell: "models show read fail-open, the audit showed the 23:10 switch and a clean 23:25 drain, and the fraudulent captures all scored above 0.85.",
    },
  },
});

// ── 14. A game-day drill leaves the scorer failed open; a paused DAG takes the blame ──────────────

const drillNeverReverted = incident({
  id: "data-t2-drill-never-reverted",
  title: "The drill that kept going",
  severity: "SEV1",
  opensAt: 11 * HOUR + 35 * MINUTE,
  briefing:
    "Payments are timing out and the gateway’s queue is climbing. This morning’s game day simulated a scorer outage and paused a feature DAG. Card testers showed up a few minutes ago. Get customers paying again.",
  roleBriefing:
    "Data on-call: models (fraud-gate, the scorer in front of the payment gateway), pipelines and the warehouse. Whatever the scorer approves goes to the gateway, which caps us at 150 charges a second; a call queued past checkout-api’s 3 s timeout fails the customer.",
  scorer: {
    model: "fraud-gate",
    versions: [version("v26", -14 * DAY, "weekly retrain", 0.0045, 0.97), version("v27", -7 * DAY, "weekly retrain", 0.004, 0.975)],
    active: "v27",
    mode: "fail-open",
    features: [
      feature("customer_orders_90d", "features_customer_daily", -9 * HOUR - 20 * MINUTE),
      feature("card_bin_velocity_1h", "features_card_velocity", -HOUR - 35 * MINUTE),
      feature("device_age_days", "features_device_daily", -8 * HOUR - 40 * MINUTE),
    ],
    fraudAttemptsPerSecond: 33,
  },
  gatewayChargesPerSecond: 150,
  gatewayBacklogSeconds: 1.95,
  evidence: [
    view("warehouse", "charges-by-amount", "Charges sent to payment-gateway in the last 15 min, by amount", (state) => {
      const w = window(state);
      return [
        ...sqlTable(
          ["amount_band_usd", "charges_sent", "distinct_cards", "new_accounts_pct"],
          [
            ["0-5", n(w.fraudApproved), n(w.fraudApproved * 0.96), "100.0"],
            ["5-50", n((w.customers - w.declined) * 0.44), n((w.customers - w.declined) * 0.43), "6.2"],
            ["50+", n((w.customers - w.declined) * 0.56), n((w.customers - w.declined) * 0.55), "4.8"],
          ],
        ),
        `Gateway queue: ${count((state.commerce?.gateway.backlog ?? 0) / (state.commerce?.gateway.chargesPerSecond ?? 1))} s deep.`,
      ];
    }),
    view("models", "audit", "Mode and threshold changes to fraud-gate today", (state) =>
      table([
        ["TIME", "BY", "CHANGE", "NOTE"],
        ["10:00", "gameday-runner", "mode enforce → fail-open", "GD-14 step 2: simulate scorer outage"],
        ["10:02", "gameday-runner", "pause DAG features_card_velocity", "GD-14 step 3"],
        ["10:30", "gameday-runner", "unpause DAG features_card_velocity", "GD-14 rollback (step 3)"],
        ["10:31", "gameday-runner", "GD-14 closed", "rollback of step 2 skipped: no handler for mode"],
        ...(scorerOf(state)?.mode === "enforce" ? [["now", "you", "mode fail-open → enforce", "-"]] : []),
      ]),
    ),
  ],
  suggestions: ["models list", "models features fraud-gate", "pipelines list", "warehouse run charges-by-amount", "models audit"],
  lostCheckoutsPerPoint: 300,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "All systems operational" },
        { key: "Throughput for us", value: "≈150 charges/s contracted; excess queues FIFO" },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% (payment timeouts). Data on-call paged." },
    { at: 30, from: "Tomas Berg · Data eng", text: "The game day paused features_card_velocity at 10:02. It’s unpaused but still catching up, last success 10:00. Could the velocity feature be the hole?" },
    { at: 80, from: "Rina Nakamura · Risk", text: "Card testers since 11:33, $1–$3 auths, roughly 30 a second." },
    { at: 140, from: "Amara Obi · SRE lead", text: "GD-14 closed at 10:31 and the runner said rollback complete. I didn’t check every step by hand." },
    { at: 250, from: "Elena Ruiz · VP Engineering", text: "Customers are failing at payment on a Saturday lunchtime. Status?" },
  ],
  hints: [
    "Look at what is filling the gateway queue.",
    "An input an hour and a half old is still inside the freshness guard.",
    "Check every step a drill changed, not just the ones its rollback mentions.",
  ],
  solution: [
    { command: "models list", why: "fraud-gate is in fail-open: the drill’s simulated outage is still on." },
    { command: "models audit", why: "GD-14 failed the scorer open at 10:00 and its rollback skipped that step." },
    { command: "models mode fraud-gate enforce", why: "Declines the card testers before the gateway again; the queue drains." },
    { command: "warehouse run charges-by-amount", why: "The $0–5 band empties; customer charges flow and the queue is back under a second." },
  ],
  postmortem: {
    question: "Why were customers timing out at payment?",
    options: [
      "The game day left fraud-gate in fail-open for the card testers",
      "features_card_velocity was paused and the scorer couldn’t see velocity",
      "payment-gateway slowed down for every merchant at lunchtime",
      "fraud-gate v27 stopped recognising $1 authorizations as fraud",
    ],
    answerIndex: 0,
    explanation: {
      cause: "GD-14 failed fraud-gate open at 10:00 and its rollback skipped restoring enforce mode.",
      why: "The drill’s rollback had no handler for mode, so fraud-gate kept approving everything. That cost nothing until card testers arrived at 11:33; then 33 extra charges a second pushed the gateway past its 150 cap and its queue past checkout-api’s 3 s timeout. The velocity feature was late but within its 26 h guard.",
      tell: "models list read fail-open, the audit showed the drill’s skipped rollback step, and the gateway queue was full of $0–5 charges from brand-new accounts.",
    },
  },
});

/** Data's tier 2: one cause among several plausible suspects, each found by reading the scorer's inputs, versions and settings. */
export const DATA_TIER2_INCIDENTS: readonly Scenario[] = [
  isotonic,
  twoBadVersions,
  relabelled,
  challenger,
  statementTimeout,
  revokedGrant,
  rotatedPassword,
  duplicateKey,
  diskFull,
  digitSwap,
  sweepLeftBehind,
  failOpenMigration,
  failOpenOvernight,
  drillNeverReverted,
];

