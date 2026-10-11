import type { CommsMessage, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { airflowCompact, airflowLine, type AirflowLevel } from "../shell/commands/pipelines.ts";
import { sqlTable } from "../shell/sql-table.ts";
import type { FraudFeature, FraudModelVersion, FraudScoring } from "../sim/commerce.ts";
import { activeVersion, isFeatureStale } from "../sim/fraud.ts";
import type { ClusterState, LogEntry } from "../sim/model.ts";
import { checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, fraudScorer, lastQuarterHour } from "./fraud-scorer.ts";

/**
 * Data tier 3: a scorer in front of the payment gateway is turning customers away (or letting a ring
 * through), and the move everyone reaches for backfires. Three traps the scorer already models:
 * failing open sends a live fraud ring to a gateway with no room for it, a plain rollback lands on a
 * version that never caught the ring, and moving the threshold trades one kind of loss for another.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;
const WORKER_HOST = "airflow-worker-1.airflow-worker.data.svc.cluster.local";

/** The healthy scorer every fix converges on: enforcing near its tuned threshold, on a sound version, fed fresh features. */
const MAX_HEALTHY_FALSE_DECLINES = 0.01;
const MIN_HEALTHY_CATCH = 0.9;

/** One failed scheduled run kept in the DAG's log: the task, when it gave up, and the frame and error it died on. */
type FailedRun = {
  readonly dag: string;
  readonly feature: string;
  /** Logical date of the scheduled run, ISO with offset, as Airflow prints it in run ids. */
  readonly logicalDate: string;
  /** Incident second the last attempt started; negative is before the page. */
  readonly at: number;
  readonly statement?: string;
  readonly frame: readonly [file: string, code: string];
  readonly error: readonly string[];
};

/** Customers declined in the last 15 minutes, by a segment the row picks, with one row-specific fact per segment. */
type DeclineView = {
  readonly name: string;
  readonly description: string;
  readonly segmentColumn: string;
  readonly detailColumn: string;
  readonly rows: readonly (readonly [segment: string, share: number, detail: string])[];
  /** A feature column shown beside the detail: the default while `feature` is stale, the detail once fresh. */
  readonly scored?: { readonly column: string; readonly feature: string; readonly whileStale: string };
};

/** The fraud in the last 15 minutes, split by a key the ring shares. */
type RingView = {
  readonly name: string;
  readonly description: string;
  readonly keyColumn: string;
  readonly amountUsd: string;
  readonly rows: readonly (readonly [key: string, share: number])[];
};

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly model: string;
  readonly opensAtSecondOfDay: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly scorer: Pick<FraudScoring, "versions" | "active" | "threshold" | "tunedThreshold" | "features" | "fraudAttemptsPerSecond"> &
    Partial<Pick<FraudScoring, "staleFeatureDeclineShare">>;
  readonly gateway: { readonly chargesPerSecond: number; readonly backlog?: number };
  readonly failedRuns?: readonly FailedRun[];
  /** What the fraud is, for the objective's label. */
  readonly fraudLabel: string;
  /** Fraudulent captures since the page that Payments can absorb in chargebacks. */
  readonly fraudBound: number;
  readonly declines: DeclineView;
  readonly ring: RingView;
  readonly suggestions: readonly string[];
  readonly lostCheckoutsPerPoint: number;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

const at = (hours: number, minutes: number) => hours * HOUR + minutes * 60;

function version(name: string, deployedAt: number, note: string, falseDeclineShare: number, catchShare: number): FraudModelVersion {
  return { version: name, deployedAt, note, falseDeclineShare, catchShare };
}

function feature(name: string, pipeline: string, lastSuccessAt: number): FraudFeature {
  return { name, pipeline, lastSuccessAt, refresh: null };
}

/** The failed task's log as Airflow 2.10 prints it, ending on the exception the operator raised. */
function failedRunLog(opensAt: number, run: FailedRun): readonly LogEntry[] {
  const task = `build_${run.feature}`;
  const runId = `scheduled__${run.logicalDate}`;
  const entry = (offset: number, origin: string, level: AirflowLevel, message: string): LogEntry => ({
    t: run.at + offset,
    source: run.dag,
    level: level === "ERROR" ? "ERROR" : "INFO",
    text: airflowLine(opensAt, run.at + offset, origin, level, message),
  });
  const executionDate = run.logicalDate.slice(0, 19).replaceAll("-", "").replaceAll(":", "");
  const [file, code] = run.frame;
  return [
    entry(0, "taskinstance.py:2867", "INFO", "Starting attempt 3 of 3"),
    entry(0, "standard_task_runner.py:72", "INFO", `Started process ${40_000 + (Math.abs(run.at) % 9_000)} to run task`),
    entry(1, "task_command.py:467", "INFO", `Running <TaskInstance: ${run.dag}.${task} ${runId} [running]> on host ${WORKER_HOST}`),
    ...(run.statement ? [entry(2, "sql.py:509", "INFO", `Running statement: ${run.statement}, parameters: None`)] : []),
    entry(3, "taskinstance.py:3313", "ERROR", ["Task failed with exception", "Traceback (most recent call last):", file, code, ...run.error].join("\n")),
    entry(
      3,
      "taskinstance.py:1226",
      "INFO",
      `Marking task as FAILED. dag_id=${run.dag}, task_id=${task}, run_id=${runId}, execution_date=${executionDate}, start_date=${airflowCompact(opensAt, run.at)}, end_date=${airflowCompact(opensAt, run.at + 3)}`,
    ),
    entry(4, "local_task_job_runner.py:266", "INFO", "Task exited with return code 1"),
  ];
}

function scorerIn(state: ClusterState): FraudScoring | undefined {
  return state.commerce?.fraud;
}

/** Enforcing near where it was tuned, on a version that neither turns customers away nor waves fraud through, on fresh inputs. */
function isScorerHealthy(state: ClusterState): boolean {
  const fraud = scorerIn(state);
  const serving = fraud && activeVersion(fraud);
  if (!fraud || !serving || fraud.mode !== "enforce") return false;
  const isNearTuned = fraud.threshold >= fraud.tunedThreshold - 0.05 && fraud.threshold <= fraud.tunedThreshold + 0.1;
  return (
    isNearTuned &&
    serving.falseDeclineShare <= MAX_HEALTHY_FALSE_DECLINES &&
    serving.catchShare >= MIN_HEALTHY_CATCH &&
    fraud.features.every((input) => !isFeatureStale(input, state.t))
  );
}

function declineEvidence(view: DeclineView) {
  return (state: ClusterState): readonly string[] => {
    const window = lastQuarterHour(state);
    if (!window) return [];
    const scored = view.scored;
    const input = scored && scorerIn(state)?.features.find((candidate) => candidate.name === scored.feature);
    const isStale = !!input && isFeatureStale(input, state.t);
    const headers = [view.segmentColumn, "customers_declined", view.detailColumn, ...(scored ? [scored.column] : [])];
    const rows = view.rows.map(([segment, share, detail]) => [
      segment,
      String(Math.round(window.declined * share)),
      detail,
      ...(scored ? [isStale ? scored.whileStale : detail] : []),
    ]);
    return sqlTable(headers, rows);
  };
}

function ringEvidence(view: RingView) {
  return (state: ClusterState): readonly string[] => {
    const window = lastQuarterHour(state);
    if (!window) return [];
    return sqlTable(
      [view.keyColumn, "amount_usd", "attempts", "approved"],
      view.rows.map(([key, share]) => [key, view.amountUsd, String(Math.round(window.fraudAttempts * share)), String(Math.round(window.fraudApproved * share))]),
    );
  };
}

function incident(row: Row): Scenario {
  const seed = `data-t3-${row.slug}`;
  const initialState = (): ClusterState => {
    const state = checkoutCluster({
      seed,
      revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
      revision: 6,
      commerce: checkoutCommerce({
        gateway: { chargesPerSecond: row.gateway.chargesPerSecond, backlog: row.gateway.backlog ?? 0 },
        fraud: fraudScorer({ model: row.model, ...row.scorer }),
      }),
    });
    const logs = Object.fromEntries((row.failedRuns ?? []).map((run) => [run.dag, failedRunLog(row.opensAtSecondOfDay, run)]));
    const { commerce } = state;
    // The objective counts fraud captured from the page on.
    const counted = commerce ? { ...state, commerce: { ...commerce, ledger: { ...commerce.ledger, fraudulentCaptures: 0 } } } : state;
    return { ...counted, logs: { ...counted.logs, ...logs } };
  };
  const objectives = (state: ClusterState): readonly Objective[] => {
    const captured = Math.round(state.commerce?.ledger.fraudulentCaptures ?? 0);
    return [
      {
        role: "data",
        label: `${row.fraudLabel} captured since the page: ${captured.toLocaleString("en-US")} (keep under ${row.fraudBound.toLocaleString("en-US")})`,
        isMet: captured < row.fraudBound,
      },
    ];
  };
  return {
    id: seed,
    tier: 3,
    title: row.title,
    severity: row.severity,
    service: row.model,
    briefing: row.briefing,
    roles: ["data"],
    roleBriefings: { data: row.roleBriefing },
    opensAtSecondOfDay: row.opensAtSecondOfDay,
    seed,
    initialState,
    alertMetric: CUSTOMERS_LOST,
    isRootCauseFixed: isScorerHealthy,
    objectives,
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    evidence: [
      { tool: "warehouse", name: row.declines.name, description: row.declines.description, run: declineEvidence(row.declines) },
      { tool: "warehouse", name: row.ring.name, description: row.ring.description, run: ringEvidence(row.ring) },
    ],
    suggestions: { data: row.suggestions },
    externals: [
      {
        id: "payment-gateway",
        status: "ok",
        facts: [
          { key: "Throughput for us", value: `≈${row.gateway.chargesPerSecond} charges/s contracted; excess queues FIFO` },
          { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
        ],
      },
    ],
    comms: row.comms,
    postmortem: row.postmortem,
    hints: row.hints,
    solution: { data: row.solution },
  };
}

const PSYCOPG_FRAME = [
  '  File "/home/airflow/.local/lib/python3.12/site-packages/airflow/providers/common/sql/hooks/sql.py", line 514, in _run_command',
  "    cur.execute(sql_statement)",
] as const;

const ROWS: readonly Row[] = [
  {
    slug: "staging-threshold-promoted",
    title: "Staging's threshold in production",
    severity: "SEV2",
    model: "order-risk",
    opensAtSecondOfDay: at(11, 20),
    briefing:
      "Since 10:55 roughly one checkout in thirteen is declined as fraud, and support says they are ordinary repeat buyers. A reshipping-mule ring has been placing orders with stolen cards all week. Get customers paying again without handing the ring the gateway.",
    roleBriefing:
      "Data on-call: models (order-risk, the scorer in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; whatever order-risk approves goes on to the gateway, mules included.",
    scorer: {
      versions: [
        version("v40", -20 * DAY, "monthly retrain", 0.005, 0.98),
        version("v41", -6 * DAY, "weekly retrain", 0.005, 0.985),
      ],
      active: "v41",
      threshold: 0.45,
      tunedThreshold: 0.8,
      features: [
        feature("shipping_address_reuse_30d", "features_address_daily", -9 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -8 * HOUR - 20 * 60),
        feature("card_bin_velocity_1h", "features_card_velocity", -6 * 60),
      ],
      fraudAttemptsPerSecond: 45,
    },
    gateway: { chargesPerSecond: 150 },
    fraudLabel: "Mule-ring charges",
    fraudBound: 2500,
    declines: {
      name: "declined-by-score",
      description: "Customers order-risk declined in the last 15 min, by score band",
      segmentColumn: "score_band",
      detailColumn: "median_paid_orders",
      rows: [
        ["0.45-0.60", 0.58, "9"],
        ["0.60-0.80", 0.36, "6"],
        ["0.80-1.00", 0.06, "0"],
      ],
    },
    ring: {
      name: "mule-orders",
      description: "Orders shipping to known reshipping addresses in the last 15 min",
      keyColumn: "ship_to_zip",
      amountUsd: "412.00",
      rows: [
        ["19720", 0.41],
        ["33166", 0.34],
        ["97230", 0.25],
      ],
    },
    suggestions: ["models show order-risk", "warehouse run declined-by-score", "warehouse run mule-orders", "models mode order-risk fail-open"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 35, from: "Maya Okonkwo · Support", text: "Repeat buyers are getting “payment declined” on orders they place every month. Their banks see nothing." },
      { at: 80, from: "Owen Price · ML platform", text: "Config sync ran at 10:55 (MLP-3310). It was supposed to copy feature flags from staging, not serving config. Checking what else came along." },
      { at: 140, from: "Rina Nakamura · Risk", text: "The mule ring is still going, about 45 orders a second shipping to the same three ZIPs. order-risk catches nearly all of them." },
      { at: 210, from: "Jonah Reyes · Product", text: "Can we turn order-risk off for an hour? We’ll eat a few bad orders." },
      { at: 320, from: "Sam Tan · SRE", text: "payment-gateway gives us 150 charges a second. We do about 120 on our own right now." },
    ],
    hints: [
      "No model shipped today. Something about how the scorer decides changed this morning.",
      "Staging is tuned to decline far more than production ever should.",
      "Approving everything would wave the mules through to a gateway with little headroom.",
    ],
    solution: [
      { command: "models show order-risk", why: "Threshold 0.45 against a tuned 0.8: staging's value, copied by the 10:55 config sync. v41 is the same model as yesterday." },
      { command: "warehouse run mule-orders", why: "The ring is real, 45 orders a second. Failing open would send every one of them to a gateway with 30 a second to spare." },
      { command: "models threshold order-risk 0.8", why: "Back to production's tuned value: 0.5% declined, and the mules still caught." },
      { command: "models list", why: "Customers declined back near 0.5%." },
    ],
    postmortem: {
      question: "Why did order-risk start declining repeat buyers at 10:55?",
      options: [
        "v41 learned to distrust customers who reuse a shipping address",
        "A config sync copied staging's 0.45 threshold into production",
        "The mule ring's volume overloaded the scoring endpoint",
        "shipping_address_reuse_30d went stale overnight",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A staging-to-production config sync overwrote order-risk’s threshold with staging’s 0.45.",
        why: "A score at or above the threshold is declined. Staging runs at 0.45 to surface edge cases; in production that declined everyone scoring between 0.45 and 0.8, about one customer in thirteen. Failing open would have sent 45 mule orders a second to a gateway with room for 30.",
        tell: "Threshold 0.45 against a tuned 0.8, declines starting at the 10:55 sync, v41 unchanged for six days, and nearly every decline scoring between 0.45 and 0.8.",
      },
    },
  },
  {
    slug: "distilled-shadow-rollback",
    title: "The version behind the bad one",
    severity: "SEV2",
    model: "card-risk",
    opensAtSecondOfDay: at(9, 35),
    briefing:
      "The weekly retrain promoted card-risk v20 at 08:45 and since then more than one customer in ten is declined. A card-testing crew is firing $2 authorizations at checkout. Roll the damage back without letting the crew in.",
    roleBriefing:
      "Data on-call: models (card-risk in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge. Anything card-risk approves is charged.",
    scorer: {
      versions: [
        version("v19", -12 * DAY, "weekly retrain", 0.004, 0.97),
        version("v19.5-distilled", -3 * DAY, "distilled latency candidate, shadow only (ML-881)", 0.0045, 0.58),
        version("v20", -50 * 60, "weekly retrain + merchant_text_embedding", 0.11, 0.985),
      ],
      active: "v20",
      threshold: 0.85,
      tunedThreshold: 0.85,
      features: [
        feature("merchant_text_embedding", "features_merchant_text", -4 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -7 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -4 * 60),
      ],
      fraudAttemptsPerSecond: 40,
    },
    gateway: { chargesPerSecond: 170 },
    fraudLabel: "Card-testing charges",
    fraudBound: 3000,
    declines: {
      name: "declined-by-reason",
      description: "Customers card-risk declined in the last 15 min, by top score reason",
      segmentColumn: "top_reason",
      detailColumn: "median_account_age_days",
      rows: [
        ["merchant_text_embedding", 0.83, "910"],
        ["card_bin_velocity_1h > 40", 0.12, "2"],
        ["new_device_and_new_card", 0.05, "0"],
      ],
    },
    ring: {
      name: "two-dollar-auths",
      description: "$2.00 authorizations in the last 15 min, by card BIN",
      keyColumn: "card_bin",
      amountUsd: "2.00",
      rows: [
        ["458109", 0.52],
        ["535316", 0.48],
      ],
    },
    suggestions: ["models show card-risk", "warehouse run declined-by-reason", "warehouse run two-dollar-auths", "models rollback card-risk"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Owen Price · ML platform", text: "v20 auto-promoted at 08:45 after beating v19 on holdout recall. Rollback is one command." },
      { at: 90, from: "Rina Nakamura · Risk", text: "Card testers are on us again, about 40 $2 auths a second on two BINs. Please don’t open the door." },
      { at: 150, from: "Hiro Tanaka · ML platform", text: "FYI we registered a distilled card-risk on Tuesday for the latency project. It only ever ran in shadow; recall was bad." },
      { at: 240, from: "Grace Liu · Finance", text: "Every declined order is lost revenue. What’s the ETA?" },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Status? Is this the model or the fraud?" },
    ],
    hints: [
      "The new version is the problem. Where a rollback lands is the question.",
      "The registry lists every version by deploy time, including ones that never enforced.",
      "A version that never caught the testers would let them all through.",
    ],
    solution: [
      { command: "models show card-risk", why: "v20 declines 11% of customers. The version deployed before it is v19.5-distilled: 58% recall, shadow only." },
      { command: "warehouse run two-dollar-auths", why: "40 card-testing auths a second. v19.5-distilled would approve four in ten of them." },
      { command: "models rollback card-risk --to v19", why: "Skips the shadow candidate: v19 declined 0.4% and caught 97% of the testers." },
      { command: "models list", why: "card-risk serves v19; declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why would a plain rollback of card-risk have made things worse?",
      options: [
        "v19 was trained before the card testers appeared",
        "Rolling back also resets the threshold to its old value",
        "The version deployed before v20 was a shadow-only candidate",
        "v20's merchant text feature can't be served by older versions",
      ],
      answerIndex: 2,
      explanation: {
        cause: "A rollback goes to the version deployed just before v20, which was a distilled shadow-only candidate.",
        why: "v19.5-distilled was registered for latency tests and never enforced; it catches only 58% of fraud. Rolling back to it would have stopped the false declines and approved about 17 card-testing auths a second. v19, two deploys back, had the old trade-off.",
        tell: "models show listed v19.5-distilled between v19 and v20 with 58% holdout recall and a shadow-only note, while v19 declined 0.4% at 97% recall.",
      },
    },
  },
  {
    slug: "velocity-dag-timeout",
    title: "Loosening won't feed it",
    severity: "SEV2",
    model: "txn-guard",
    opensAtSecondOfDay: at(8, 15),
    briefing:
      "txn-guard has been declining about one customer in ten since the 07:00 rush began. Nobody changed the model or its threshold. Product wants the threshold loosened until declines look normal. A slow card-cracking bot is still probing checkout.",
    roleBriefing:
      "Data on-call: models (txn-guard in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge.",
    scorer: {
      versions: [
        version("v7", -30 * DAY, "monthly retrain", 0.005, 0.88),
        version("v8", -9 * DAY, "monthly retrain + card_velocity_24h", 0.004, 0.9),
      ],
      active: "v8",
      threshold: 0.85,
      tunedThreshold: 0.85,
      features: [
        feature("card_velocity_24h", "features_card_velocity_daily", -29 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -5 * HOUR - 40 * 60),
        feature("device_age_days", "features_device_daily", -4 * HOUR - 10 * 60),
      ],
      staleFeatureDeclineShare: 0.095,
      fraudAttemptsPerSecond: 50,
    },
    gateway: { chargesPerSecond: 180 },
    failedRuns: [
      {
        dag: "features_card_velocity_daily",
        feature: "card_velocity_24h",
        logicalDate: "2026-10-09T03:00:00+00:00",
        at: -(5 * HOUR + 2 * 60 + 11),
        frame: [
          '  File "/home/airflow/.local/lib/python3.12/site-packages/airflow/utils/timeout.py", line 69, in handle_timeout',
          "    raise AirflowTaskTimeout(self.error_message)",
        ],
        error: ["airflow.exceptions.AirflowTaskTimeout: Timeout, PID: 44317"],
      },
    ],
    fraudLabel: "Card-cracking charges",
    fraudBound: 6000,
    declines: {
      name: "declined-velocity",
      description: "Customers txn-guard declined in the last 15 min, with the card velocity it scored",
      segmentColumn: "customer_history",
      detailColumn: "cards_used_24h_actual",
      rows: [
        ["3+ paid orders", 0.61, "1"],
        ["1-2 paid orders", 0.27, "1"],
        ["no paid orders", 0.12, "2"],
      ],
      scored: { column: "cards_used_24h_scored", feature: "card_velocity_24h", whileStale: "-1 (default)" },
    },
    ring: {
      name: "card-cracking",
      description: "Attempts cycling expiry dates on the same card numbers, last 15 min",
      keyColumn: "card_bin",
      amountUsd: "1.00",
      rows: [
        ["400022", 0.55],
        ["510510", 0.45],
      ],
    },
    suggestions: ["models features txn-guard", "pipelines list", "warehouse run declined-velocity", "warehouse run card-cracking", "models threshold txn-guard 0.99"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 40, from: "Maya Okonkwo · Support", text: "Same complaint over and over: card declined, bank says it never saw a charge." },
      { at: 100, from: "Jonah Reyes · Product", text: "Just raise txn-guard’s threshold to 0.99 until declines look normal. We can tune it back tomorrow." },
      { at: 170, from: "Rina Nakamura · Risk", text: "The card crackers are still at it, about 50 tries a second. A looser threshold is exactly what they want." },
      { at: 250, from: "Kofi Mensah · Data eng", text: "Last night the warehouse ran its weekly VACUUM FULL from 03:00 to 04:30. It’s finished, if that matters to anyone." },
      { at: 340, from: "Elena Ruiz · VP Engineering", text: "Declines still at one in ten. What are we doing?" },
    ],
    hints: [
      "The scorer’s logic didn’t change. Look at what it was fed this morning.",
      "An input older than its freshness guard is served as a default value.",
      "Whatever blocked the overnight job has since cleared.",
    ],
    solution: [
      { command: "models features txn-guard", why: "card_velocity_24h last refreshed 29 h ago, past the 26 h guard: every customer scored on the default." },
      { command: "pipelines logs features_card_velocity_daily", why: "The 03:00 run timed out three times while the weekly VACUUM FULL held its table. The vacuum finished at 04:30." },
      { command: "pipelines run features_card_velocity_daily", why: "Rebuilds the feature now; it goes fresh in about a minute." },
      { command: "models features txn-guard", why: "card_velocity_24h fresh again; declines fall to 0.4%." },
    ],
    postmortem: {
      question: "Why was txn-guard declining one customer in ten?",
      options: [
        "card_velocity_24h went stale after its DAG timed out",
        "Its threshold was too strict for the morning rush",
        "The card-cracking bot pushed v8's scores up for everyone",
        "v8 was trained on a sample from last year's holiday peak",
      ],
      answerIndex: 0,
      explanation: {
        cause: "The 03:00 features_card_velocity_daily run timed out while a VACUUM FULL locked its table.",
        why: "card_velocity_24h aged past txn-guard’s 26 h guard and was served as its default, which the model reads as risky. The extra declines don’t depend on the threshold, so loosening it to 0.99 would barely have helped customers and would have let more card cracking through. Rerunning the DAG fixed the input.",
        tell: "card_velocity_24h was 29 h old and STALE, the DAG log ended in AirflowTaskTimeout, and declined customers were scored with the default velocity.",
      },
    },
  },
  {
    slug: "device-graph-throttled",
    title: "Takeover crew at the gate",
    severity: "SEV2",
    model: "ato-scorer",
    opensAtSecondOfDay: at(10, 50),
    briefing:
      "ato-scorer, which blocks checkouts from taken-over accounts, has been declining more than one customer in eight since mid-morning. An account-takeover crew is checking out on stolen logins with their saved cards. Support wants the scorer switched off.",
    roleBriefing:
      "Data on-call: models (ato-scorer, the account-takeover model in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; anything approved is charged to the saved card.",
    scorer: {
      versions: [
        version("v5", -40 * DAY, "quarterly retrain", 0.004, 0.97),
        version("v6", -9 * DAY, "monthly retrain", 0.004, 0.98),
      ],
      active: "v6",
      threshold: 0.8,
      tunedThreshold: 0.8,
      features: [
        feature("device_accounts_30d", "features_device_graph", -28 * HOUR - 15 * 60),
        feature("login_country_change_7d", "features_login_daily", -6 * HOUR),
        feature("password_reset_age_h", "features_login_stream", -3 * 60),
      ],
      staleFeatureDeclineShare: 0.13,
      fraudAttemptsPerSecond: 40,
    },
    gateway: { chargesPerSecond: 145 },
    failedRuns: [
      {
        dag: "features_device_graph",
        feature: "device_accounts_30d",
        logicalDate: "2026-10-09T01:00:00+00:00",
        at: -(8 * HOUR + 31 * 60 + 40),
        frame: ['  File "/home/airflow/.local/lib/python3.12/site-packages/botocore/client.py", line 1023, in _make_api_call', "    raise error_class(parsed_response, operation_name)"],
        error: ["botocore.exceptions.ClientError: An error occurred (SlowDown) when calling the PutObject operation (reached max retries: 4): Please reduce your request rate."],
      },
    ],
    fraudLabel: "Takeover charges",
    fraudBound: 2500,
    declines: {
      name: "declined-devices",
      description: "Customers ato-scorer declined in the last 15 min, with the device graph it scored",
      segmentColumn: "account_age",
      detailColumn: "accounts_on_device_actual",
      rows: [
        ["over 2 years", 0.57, "1"],
        ["3 months - 2 years", 0.31, "1"],
        ["under 3 months", 0.12, "2"],
      ],
      scored: { column: "accounts_on_device_scored", feature: "device_accounts_30d", whileStale: "0 (default)" },
    },
    ring: {
      name: "takeover-checkouts",
      description: "Checkouts within an hour of a password reset from a new country, last 15 min",
      keyColumn: "login_asn",
      amountUsd: "238.00",
      rows: [
        ["AS9009 M247", 0.48],
        ["AS60068 Datacamp", 0.31],
        ["AS212238 Datacamp", 0.21],
      ],
    },
    suggestions: ["models features ato-scorer", "pipelines list", "warehouse run declined-devices", "warehouse run takeover-checkouts", "models mode ato-scorer fail-open"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Long-time customers are being declined on their own saved cards. Can we just switch the takeover check off?" },
      { at: 90, from: "Lena Park · Trust & Safety", text: "The takeover crew is live, roughly 40 checkouts a second on stolen logins. ato-scorer is the only thing stopping them." },
      { at: 160, from: "Kofi Mensah · Data eng", text: "Our S3 bucket was throttled overnight while Growth backfilled two years of clickstream into it. The backfill finished around 06:00." },
      { at: 230, from: "Sam Tan · SRE", text: "Gateway headroom is thin today: 145 charges a second contracted, ~120 in use." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Where are we on declines?" },
    ],
    hints: [
      "Nothing about the model changed. One of its inputs did.",
      "A device that looks brand new to the scorer looks like a takeover.",
      "The thing that broke the job overnight has since gone away.",
    ],
    solution: [
      { command: "models features ato-scorer", why: "device_accounts_30d last refreshed 28 h ago and is STALE: every customer looks like a new device." },
      { command: "pipelines logs features_device_graph", why: "The 01:00 run died on S3 SlowDown while Growth's backfill hammered the bucket. That backfill is done." },
      { command: "pipelines run features_device_graph", why: "Rebuilds the device graph now; fresh in about a minute." },
      { command: "models features ato-scorer", why: "device_accounts_30d fresh; declines fall to 0.4% and the crew is still caught." },
    ],
    postmortem: {
      question: "What made ato-scorer decline long-time customers?",
      options: [
        "The takeover crew's logins overloaded the scorer's login stream",
        "v6 started treating saved cards as a takeover signal",
        "Its decline threshold was lowered for the takeover crew",
        "device_accounts_30d went stale after S3 throttled its DAG",
      ],
      answerIndex: 3,
      explanation: {
        cause: "features_device_graph failed overnight on S3 SlowDown, so device_accounts_30d went stale.",
        why: "Past the 26 h guard the scorer serves the feature’s default, a device with no history, which looks like a takeover. Failing open would have approved 40 takeover checkouts a second on a gateway with 25 to spare, timing out everyone. A rerun after the backfill finished refreshed the graph.",
        tell: "device_accounts_30d was 28 h old and STALE, the DAG log ended in SlowDown on PutObject, and declined customers were scored on 0 accounts per device.",
      },
    },
  },
  {
    slug: "quantized-model-tighten",
    title: "Tightening the wrong model",
    severity: "SEV1",
    model: "payment-risk",
    opensAtSecondOfDay: at(13, 5),
    briefing:
      "Checkout is timing out at the payment gateway and the queue is growing. Risk says card testers are getting through payment-risk at a rate they've never seen, and wants the threshold dropped hard to choke them off. ML platform promoted a faster payment-risk build at 11:00.",
    roleBriefing:
      "Data on-call: models (payment-risk in front of the payment gateway), pipelines and the warehouse. What payment-risk approves joins the gateway queue beside real customers; the gateway does about 148 charges a second for us.",
    scorer: {
      versions: [
        version("v7", -14 * DAY, "weekly retrain", 0.004, 0.985),
        version("v8-int8", -2 * HOUR - 5 * 60, "int8 quantized v7 for p99 latency (ML-902)", 0.003, 0.5),
      ],
      active: "v8-int8",
      threshold: 0.85,
      tunedThreshold: 0.85,
      features: [
        feature("customer_orders_90d", "features_customer_daily", -10 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -8 * 60),
        feature("ip_distance_km", "features_geo_stream", -2 * 60),
      ],
      fraudAttemptsPerSecond: 60,
    },
    gateway: { chargesPerSecond: 148, backlog: 300 },
    fraudLabel: "Card-testing charges",
    fraudBound: 9000,
    declines: {
      name: "declined-customers",
      description: "Customers payment-risk declined in the last 15 min, by customer history",
      segmentColumn: "customer_history",
      detailColumn: "chargebacks_last_year",
      rows: [
        ["3+ paid orders", 0.4, "0"],
        ["1-2 paid orders", 0.3, "0"],
        ["no paid orders", 0.3, "2"],
      ],
    },
    ring: {
      name: "card-testing",
      description: "Card-testing authorizations in the last 15 min, by card BIN",
      keyColumn: "card_bin",
      amountUsd: "1.00",
      rows: [
        ["476173", 0.44],
        ["542418", 0.36],
        ["601100", 0.2],
      ],
    },
    suggestions: ["models show payment-risk", "warehouse run card-testing", "warehouse run declined-customers", "models threshold payment-risk 0.5"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% for 5m (payment-gateway timeouts). Data on-call paged." },
      { at: 25, from: "Sam Tan · SRE", text: "payment-gateway queue is climbing; calls wait past checkout-api’s 3 s timeout. We send it ~150 a second against 148 contracted." },
      { at: 70, from: "Rina Nakamura · Risk", text: "Testers are sailing through payment-risk. Drop the threshold to 0.5 and choke them off." },
      { at: 130, from: "Hiro Tanaka · ML platform", text: "We promoted v8-int8 at 11:00 to fix p99 latency. Same weights as v7, just quantized. Should score identically." },
      { at: 220, from: "Maya Okonkwo · Support", text: "Customers see a spinner then “something went wrong”. Some were charged anyway." },
      { at: 320, from: "Elena Ruiz · VP Engineering", text: "This is a SEV1. I need a plan, not a guess." },
    ],
    hints: [
      "The gateway isn't slow; it's being fed more than it can take. Who is feeding it?",
      "Compare how each version scores the testers, not just how fast it scores.",
      "A stricter threshold catches more fraud and declines more customers too.",
    ],
    solution: [
      { command: "models show payment-risk", why: "v8-int8 catches 50% of fraud; v7 caught 98.5%. Quantization flattened the scores near the threshold." },
      { command: "warehouse run card-testing", why: "60 testers a second; half get through, so the gateway gets ~150 calls a second for 148 slots." },
      { command: "models rollback payment-risk --to v7", why: "Back to v7's scores: the testers are caught, the queue drains, and declines stay at 0.4%." },
      { command: "models list", why: "payment-risk serves v7; the gateway queue empties within seconds." },
    ],
    postmortem: {
      question: "Why was dropping payment-risk's threshold to 0.5 the wrong fix?",
      options: [
        "It would decline ~5% of customers to patch a bad build",
        "The gateway ignores payment-risk's decisions above 0.5",
        "The threshold only applies to customers with saved cards",
        "The testers' scores sit above 0.9, so 0.5 changes nothing",
      ],
      answerIndex: 0,
      explanation: {
        cause: "v8-int8, a quantized build of v7, caught only half the card testers it was meant to stop.",
        why: "Quantization compressed the scores, so the testers landed below 0.85 and their approvals filled the gateway. A 0.5 threshold would have caught most testers but declined roughly 5% of real customers. Serving v7 restored its scores and its 98.5% recall.",
        tell: "Timeouts began after the 11:00 promotion, v8-int8 showed 50% holdout recall against v7's 98.5%, and the approved testers scored between 0.5 and 0.8.",
      },
    },
  },
  {
    slug: "tenure-disk-full",
    title: "Rolling back past the testers",
    severity: "SEV2",
    model: "checkout-risk",
    opensAtSecondOfDay: at(9, 10),
    briefing:
      "checkout-risk v52 went out yesterday afternoon with a new feature for a BIN-range attack, and this morning one customer in nine is declined. The BIN-range crew is still trying. Everyone assumes v52 is to blame.",
    roleBriefing:
      "Data on-call: models (checkout-risk in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; anything approved is charged.",
    scorer: {
      versions: [
        version("v51", -20 * DAY, "weekly retrain", 0.004, 0.72),
        version("v52", -18 * HOUR, "weekly retrain + bin_range_novelty (RISK-640)", 0.0045, 0.985),
      ],
      active: "v52",
      threshold: 0.85,
      tunedThreshold: 0.85,
      features: [
        feature("customer_tenure_days", "features_customer_profile", -31 * HOUR),
        feature("bin_range_novelty", "features_bin_stream", -5 * 60),
        feature("device_age_days", "features_device_daily", -6 * HOUR - 30 * 60),
      ],
      staleFeatureDeclineShare: 0.105,
      fraudAttemptsPerSecond: 35,
    },
    gateway: { chargesPerSecond: 180 },
    failedRuns: [
      {
        dag: "features_customer_profile",
        feature: "customer_tenure_days",
        logicalDate: "2026-10-09T02:30:00+00:00",
        at: -(6 * HOUR + 22 * 60 + 9),
        statement: "insert into features.customer_profile select customer_id, current_date - min(created_at)::date, current_date from orders.orders group by customer_id",
        frame: PSYCOPG_FRAME,
        error: ['psycopg2.errors.DiskFull: could not extend file "base/16384/2619": No space left on device', "HINT:  Check free disk space.", ""],
      },
    ],
    fraudLabel: "BIN-range charges",
    fraudBound: 3000,
    declines: {
      name: "declined-tenure",
      description: "Customers checkout-risk declined in the last 15 min, with the tenure it scored",
      segmentColumn: "customer_since",
      detailColumn: "tenure_days_actual",
      rows: [
        ["before 2024", 0.55, "1204"],
        ["2024-2025", 0.33, "402"],
        ["this year", 0.12, "61"],
      ],
      scored: { column: "tenure_days_scored", feature: "customer_tenure_days", whileStale: "0 (default)" },
    },
    ring: {
      name: "bin-range-attack",
      description: "Attempts walking an unissued BIN range in the last 15 min",
      keyColumn: "bin_range",
      amountUsd: "4.99",
      rows: [
        ["4147 20xx", 0.6],
        ["4147 21xx", 0.4],
      ],
    },
    suggestions: ["models show checkout-risk", "models features checkout-risk", "warehouse run declined-tenure", "warehouse run bin-range-attack", "models rollback checkout-risk"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Jonah Reyes · Product", text: "v52 shipped yesterday and today we decline loyal customers. Roll it back?" },
      { at: 90, from: "Rina Nakamura · Risk", text: "v52 exists because of the BIN-range crew. They’re still at it, ~35 attempts a second. v51 let a quarter of them through last week." },
      { at: 160, from: "Ana Silva · DBA", text: "The feature-store Postgres ran out of disk around 02:50 when someone’s temp table ballooned. We freed 400 GB at 07:30." },
      { at: 240, from: "Maya Okonkwo · Support", text: "The declined ones are our oldest customers. People who’ve shopped here for years." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Do we know what changed?" },
    ],
    hints: [
      "Ask whether the older version would decline these customers too.",
      "The customers being declined all look newer to the scorer than they are.",
      "Whatever filled up overnight was cleared this morning.",
    ],
    solution: [
      { command: "models features checkout-risk", why: "customer_tenure_days is 31 h old and STALE: every customer scored as signed up today. v52 isn't the cause." },
      { command: "pipelines logs features_customer_profile", why: "The 02:30 run failed on DiskFull. The DBA freed space at 07:30, so a rerun will succeed." },
      { command: "pipelines run features_customer_profile", why: "Rebuilds tenure now; fresh in about a minute. v52 keeps catching the BIN-range crew." },
      { command: "models features checkout-risk", why: "customer_tenure_days fresh; declines fall to 0.45%." },
    ],
    postmortem: {
      question: "Why would rolling back to v51 have backfired?",
      options: [
        "v51 can't read bin_range_novelty and would error on every score",
        "The declines came from a stale feature that v51 reads as well",
        "v51 was trained on a sample with too few loyal customers",
        "Rolling back clears the feature cache and restarts the DAGs",
      ],
      answerIndex: 1,
      explanation: {
        cause: "features_customer_profile failed on a full disk overnight, so customer_tenure_days went stale.",
        why: "Every version reads customer_tenure_days, so v51 would have declined the same customers, and it catches only 72% of the BIN-range crew, about 10 approved attempts a second. Rerunning the DAG after the disk was freed fixed the declines and kept v52's catch rate.",
        tell: "customer_tenure_days was 31 h old and STALE, the DAG log ended in DiskFull, and declined customers were scored with 0 days of tenure.",
      },
    },
  },
  {
    slug: "loosened-threshold-floods-gateway",
    title: "Loose enough to flood",
    severity: "SEV1",
    model: "chargeback-guard",
    opensAtSecondOfDay: at(14, 25),
    briefing:
      "payment-gateway calls are timing out and customers are getting charged for orders that fail. A gift-card reseller ring is buying gift cards with stolen cards at 100 attempts a second. chargeback-guard v4 has served for eleven days.",
    roleBriefing:
      "Data on-call: models (chargeback-guard in front of the payment gateway), pipelines and the warehouse. What chargeback-guard approves joins the gateway queue beside real customers; the gateway takes about 150 charges a second for us.",
    scorer: {
      versions: [
        version("v3", -30 * DAY, "quarterly retrain", 0.004, 0.8),
        version("v4", -11 * DAY, "quarterly retrain + gift_card_share", 0.0045, 0.9),
      ],
      active: "v4",
      threshold: 0.99,
      tunedThreshold: 0.7,
      features: [
        feature("gift_card_share", "features_basket_daily", -7 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -6 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -5 * 60),
      ],
      fraudAttemptsPerSecond: 100,
    },
    gateway: { chargesPerSecond: 150, backlog: 320 },
    fraudLabel: "Gift-card fraud charges",
    fraudBound: 20000,
    declines: {
      name: "declined-since-raise",
      description: "Customers chargeback-guard declined in the last 15 min, by score band",
      segmentColumn: "score_band",
      detailColumn: "chargebacks_last_year",
      rows: [["0.99-1.00", 1, "14"]],
    },
    ring: {
      name: "gift-card-buys",
      description: "Gift-card purchases on cards with chargebacks elsewhere, last 15 min, by denomination",
      keyColumn: "denomination_usd",
      amountUsd: "varies",
      rows: [
        ["100.00", 0.52],
        ["200.00", 0.33],
        ["500.00", 0.15],
      ],
    },
    suggestions: ["models show chargeback-guard", "warehouse run gift-card-buys", "warehouse run declined-since-raise", "models rollback chargeback-guard"],
    lostCheckoutsPerPoint: 300,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% for 5m (payment-gateway timeouts). Data on-call paged." },
      { at: 30, from: "Sam Tan · SRE", text: "Gateway queue is past 2 s and growing. We’re sending more than our 150 a second." },
      { at: 80, from: "Priya Shah · Risk", text: "Yesterday I raised chargeback-guard’s threshold to 0.99 (RISK-702). Support was drowning in false-decline tickets. That can’t be it, declines are basically zero now." },
      { at: 150, from: "Jonah Reyes · Product", text: "v4 is eleven days old, maybe it’s drifted? Roll back to v3?" },
      { at: 230, from: "Grace Liu · Finance", text: "We’re capturing charges for orders that fail. That’s refunds and angry customers." },
      { at: 320, from: "Elena Ruiz · VP Engineering", text: "SEV1. What is filling the gateway?" },
    ],
    hints: [
      "The gateway isn't broken. Count who is calling it.",
      "Something about how the scorer decides changed yesterday, not which version decides.",
      "An older version catches less fraud than the current one at any threshold.",
    ],
    solution: [
      { command: "models show chargeback-guard", why: "Threshold 0.99 against a tuned 0.7: almost no fraud scores that high, so a third of the ring is approved." },
      { command: "warehouse run gift-card-buys", why: "About 32 ring purchases a second reach the gateway: 120 customers plus 32 is more than 150." },
      { command: "models threshold chargeback-guard 0.7", why: "Back where it was tuned: v4 catches 90% of the ring, the gateway queue drains." },
      { command: "models list", why: "Approved fraud down to ~10 a second; customers declined at 0.45%." },
    ],
    postmortem: {
      question: "What filled the payment gateway's queue?",
      options: [
        "chargeback-guard v4 had drifted and stopped catching the ring",
        "Ring purchases approved once the threshold rose to 0.99",
        "payment-gateway cut our contracted rate without notice",
        "Customers retried timed-out checkouts and doubled the load",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Risk raised chargeback-guard’s threshold from 0.7 to 0.99 to cut false-decline tickets.",
        why: "A score at or above the threshold is declined, so at 0.99 a third of the ring’s purchases were approved, about 32 a second, pushing the gateway past its 150. Rolling back to v3, with worse recall, would have approved even more. Restoring 0.7 drained the queue.",
        tell: "Threshold 0.99 against a tuned 0.7, timeouts starting after RISK-702, near-zero declines, and ring purchases making up the excess at the gateway.",
      },
    },
  },
  {
    slug: "basket-entropy-regression",
    title: "Split payments, split customers",
    severity: "SEV2",
    model: "bnpl-risk",
    opensAtSecondOfDay: at(12, 40),
    briefing:
      "bnpl-risk v61 went live at 12:05 and since then about one customer in eleven is declined at checkout. A synthetic-identity ring is opening pay-later plans with fake applicants. Product wants fraud checks off until it's sorted.",
    roleBriefing:
      "Data on-call: models (bnpl-risk, which scores every checkout before the payment gateway), pipelines and the warehouse. A decline is an HTTP 402; whatever bnpl-risk approves goes on to the gateway.",
    scorer: {
      versions: [
        version("v59", -22 * DAY, "weekly retrain", 0.0045, 0.97),
        version("v60", -8 * DAY, "weekly retrain", 0.004, 0.975),
        version("v61", -35 * 60, "weekly retrain + basket_entropy (BNPL-118)", 0.09, 0.98),
      ],
      active: "v61",
      threshold: 0.8,
      tunedThreshold: 0.8,
      features: [
        feature("basket_entropy", "features_basket_stream", -3 * 60),
        feature("applicant_identity_age_days", "features_identity_daily", -9 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -8 * HOUR),
      ],
      fraudAttemptsPerSecond: 45,
    },
    gateway: { chargesPerSecond: 150 },
    fraudLabel: "Synthetic-identity charges",
    fraudBound: 2500,
    declines: {
      name: "declined-baskets",
      description: "Customers bnpl-risk declined in the last 15 min, by basket size",
      segmentColumn: "basket_items",
      detailColumn: "decline_rate_v60_same_baskets",
      rows: [
        ["6+ items", 0.64, "0.3%"],
        ["3-5 items", 0.29, "0.4%"],
        ["1-2 items", 0.07, "0.5%"],
      ],
    },
    ring: {
      name: "synthetic-applicants",
      description: "Pay-later applications with identities under 30 days old, last 15 min",
      keyColumn: "ssn_issue_state",
      amountUsd: "640.00",
      rows: [
        ["unissued range", 0.71],
        ["deceased-file match", 0.29],
      ],
    },
    suggestions: ["models show bnpl-risk", "warehouse run declined-baskets", "warehouse run synthetic-applicants", "models mode bnpl-risk fail-open"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Jonah Reyes · Product", text: "Big baskets are getting declined. Can we fail open bnpl-risk until it’s fixed? It’s the busiest hour of the week." },
      { at: 85, from: "Lena Park · Trust & Safety", text: "Do not fail open. The synthetic-identity ring is running ~45 applications a second." },
      { at: 150, from: "Owen Price · ML platform", text: "v61 promoted at 12:05 with basket_entropy (BNPL-118). Offline AUC was up." },
      { at: 230, from: "Sam Tan · SRE", text: "Reminder: gateway contract is 150 charges a second; we’re at ~120." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Is this the new model? Yes or no." },
    ],
    hints: [
      "Declines started at a specific minute. What went live then?",
      "The ring is real and the scorer is the only thing stopping it.",
      "Approving everything would hand the ring the gateway's last free slots.",
    ],
    solution: [
      { command: "models show bnpl-risk", why: "v61 went live at 12:05 and declines 9% of customers; v60 declined 0.4%." },
      { command: "warehouse run declined-baskets", why: "The declines are big baskets that v60 approved: basket_entropy reads a full cart as risky." },
      { command: "models rollback bnpl-risk --to v60", why: "Back to v60's trade-off: 0.4% declined, 97.5% of the ring caught." },
      { command: "models list", why: "Declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why were big-basket customers declined after 12:05?",
      options: [
        "The synthetic-identity ring targeted large baskets",
        "Risk lowered bnpl-risk's threshold for the ring",
        "v61's basket_entropy feature scored full carts as risky",
        "applicant_identity_age_days went stale and defaulted to 0",
      ],
      answerIndex: 2,
      explanation: {
        cause: "bnpl-risk v61 added basket_entropy, which treats large varied baskets as risky.",
        why: "Offline AUC rose because the ring’s baskets are varied, but so are many good customers’ carts, and v61 declined about 9% of them. Failing open would have approved 45 synthetic applications a second on a gateway with 30 free. Rolling back to v60 kept the ring out.",
        tell: "Declines began at v61’s 12:05 promotion, v61 declined 9% against v60’s 0.4%, and declined baskets were large ones v60 approved.",
      },
    },
  },
  {
    slug: "autotuner-lowered-threshold",
    title: "The autotuner's 3 a.m. decision",
    severity: "SEV2",
    model: "fraud-gbm",
    opensAtSecondOfDay: at(8, 50),
    briefing:
      "fraud-gbm has declined about one customer in sixteen since the early hours, and it's climbing with the morning rush. Nobody on the team touched it. A BIN-velocity ring is probing at 30 attempts a second.",
    roleBriefing:
      "Data on-call: models (fraud-gbm in front of the payment gateway), pipelines and the warehouse. Its threshold is managed by the threshold-autotuner job. A decline is an HTTP 402 before any charge.",
    scorer: {
      versions: [
        version("v14", -25 * DAY, "monthly retrain (before BIN velocity features)", 0.006, 0.8),
        version("v15", -10 * DAY, "monthly retrain + card_bin_velocity_1h", 0.004, 0.98),
      ],
      active: "v15",
      threshold: 0.5,
      tunedThreshold: 0.85,
      features: [
        feature("card_bin_velocity_1h", "features_card_velocity", -7 * 60),
        feature("customer_orders_90d", "features_customer_daily", -6 * HOUR - 10 * 60),
        feature("email_age_days", "features_email_daily", -5 * HOUR),
      ],
      fraudAttemptsPerSecond: 30,
    },
    gateway: { chargesPerSecond: 180 },
    fraudLabel: "BIN-velocity charges",
    fraudBound: 2500,
    declines: {
      name: "declined-overnight",
      description: "Customers fraud-gbm declined in the last 15 min, by score band",
      segmentColumn: "score_band",
      detailColumn: "chargebacks_last_year",
      rows: [
        ["0.50-0.70", 0.66, "0"],
        ["0.70-0.85", 0.3, "0"],
        ["0.85-1.00", 0.04, "37"],
      ],
    },
    ring: {
      name: "bin-velocity",
      description: "Bursts of 40+ attempts per BIN per hour, last 15 min",
      keyColumn: "card_bin",
      amountUsd: "3.00",
      rows: [
        ["434256", 0.5],
        ["523914", 0.5],
      ],
    },
    suggestions: ["models show fraud-gbm", "warehouse run declined-overnight", "warehouse run bin-velocity", "models rollback fraud-gbm"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 35, from: "Maya Okonkwo · Support", text: "Overnight orders were fine until about 3 a.m., then the declines started. It’s worse now." },
      { at: 95, from: "Dev Raman · ML platform", text: "threshold-autotuner fired a drift alarm at 03:00 on the BIN-velocity spike and adjusted fraud-gbm. That’s what it’s for." },
      { at: 160, from: "Jonah Reyes · Product", text: "v15 is ten days old. Maybe it’s gone stale? Roll back to v14?" },
      { at: 240, from: "Rina Nakamura · Risk", text: "v14 predates the BIN-velocity features. It never caught this ring." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Declines climbing with the rush. Update?" },
    ],
    hints: [
      "Nobody shipped a model. Something adjusted how it decides overnight.",
      "Score bands tell you whether the declined customers ever looked like fraud.",
      "Decision settings stay put when the version changes.",
    ],
    solution: [
      { command: "models show fraud-gbm", why: "Threshold 0.5 against a tuned 0.85: the autotuner dropped it at 03:00 on a drift alarm." },
      { command: "warehouse run declined-overnight", why: "Nearly all declines score 0.5-0.85 and have no chargebacks: good customers." },
      { command: "models threshold fraud-gbm 0.85", why: "Back to the tuned value; v15 still catches 98% of the ring." },
      { command: "models list", why: "Declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why would rolling fraud-gbm back to v14 have made it worse?",
      options: [
        "v14 declines more customers, and the 0.5 threshold stays",
        "v14 can't read card_bin_velocity_1h and fails every score",
        "Rolling back retriggers the autotuner's drift alarm at once",
        "v14 was never registered for production traffic in the scorer",
      ],
      answerIndex: 0,
      explanation: {
        cause: "threshold-autotuner lowered fraud-gbm’s threshold from 0.85 to 0.5 after an overnight drift alarm.",
        why: "Threshold is serving config and survives a rollback. At 0.5, v14 declines about 9% of customers, worse than v15’s 6%, and catches less of the ring. Restoring 0.85 on v15 cut declines to 0.4% and kept the ring out.",
        tell: "Threshold 0.5 against a tuned 0.85, declines from 03:00 when the autotuner fired, and declined customers scoring 0.5-0.85 with no chargebacks.",
      },
    },
  },
  {
    slug: "replica-conflict-two-dags",
    title: "Two DAGs down on the replica",
    severity: "SEV2",
    model: "trust-score",
    opensAtSecondOfDay: at(7, 45),
    briefing:
      "trust-score is declining one customer in eight this morning. The data team failed the feature store's read replica over at 01:30. A refund-abuse crew is checking out on stolen cards to cash out refunds. Support wants trust-score switched off.",
    roleBriefing:
      "Data on-call: models (trust-score in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; whatever trust-score approves is charged.",
    scorer: {
      versions: [
        version("v21", -18 * DAY, "monthly retrain", 0.0045, 0.97),
        version("v22", -4 * DAY, "monthly retrain", 0.004, 0.98),
      ],
      active: "v22",
      threshold: 0.82,
      tunedThreshold: 0.82,
      features: [
        feature("order_history_365d", "features_order_history", -27 * HOUR),
        feature("address_graph_degree", "features_address_graph", -29 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -6 * 60),
      ],
      staleFeatureDeclineShare: 0.062,
      fraudAttemptsPerSecond: 40,
    },
    gateway: { chargesPerSecond: 150 },
    failedRuns: [
      {
        dag: "features_order_history",
        feature: "order_history_365d",
        logicalDate: "2026-10-09T01:00:00+00:00",
        at: -(6 * HOUR + 4 * 60 + 18),
        statement: "insert into features.order_history select customer_id, count(*) from orders.orders where created_at >= current_date - 365 group by customer_id",
        frame: PSYCOPG_FRAME,
        error: ["psycopg2.errors.SerializationFailure: canceling statement due to conflict with recovery", "DETAIL:  User query might have needed to see row versions that must be removed.", ""],
      },
      {
        dag: "features_address_graph",
        feature: "address_graph_degree",
        logicalDate: "2026-10-09T01:15:00+00:00",
        at: -(5 * HOUR + 51 * 60 + 2),
        statement: "insert into features.address_graph select a.customer_id, count(distinct b.customer_id) from addresses a join addresses b using (address_hash) group by a.customer_id",
        frame: PSYCOPG_FRAME,
        error: ["psycopg2.errors.QueryCanceled: canceling statement due to statement timeout", ""],
      },
    ],
    fraudLabel: "Refund-abuse charges",
    fraudBound: 2500,
    declines: {
      name: "declined-history",
      description: "Customers trust-score declined in the last 15 min, with the order history it scored",
      segmentColumn: "customer_history",
      detailColumn: "orders_365d_actual",
      rows: [
        ["10+ paid orders", 0.52, "23"],
        ["3-9 paid orders", 0.35, "5"],
        ["1-2 paid orders", 0.13, "1"],
      ],
      scored: { column: "orders_365d_scored", feature: "order_history_365d", whileStale: "0 (default)" },
    },
    ring: {
      name: "refund-abuse",
      description: "Checkouts on cards linked to refund-to-gift-card cash-outs, last 15 min",
      keyColumn: "refund_method",
      amountUsd: "189.00",
      rows: [
        ["store credit", 0.62],
        ["gift card", 0.38],
      ],
    },
    suggestions: ["models features trust-score", "pipelines list", "warehouse run declined-history", "warehouse run refund-abuse", "models mode trust-score fail-open"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Can we fail open trust-score for now? It’s declining people with dozens of orders." },
      { at: 90, from: "Ana Silva · DBA", text: "We failed the feature store’s read replica over at 01:30 for a kernel patch. The new replica caught up by 02:15, all healthy since." },
      { at: 150, from: "Lena Park · Trust & Safety", text: "The refund-abuse crew is still running, about 40 checkouts a second. trust-score is the only thing stopping them." },
      { at: 230, from: "Sam Tan · SRE", text: "Gateway is at ~120 of 150 contracted charges a second." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Morning. Status?" },
    ],
    hints: [
      "More than one input could be wrong. Check them all.",
      "Jobs that read from a replica mid-failover can die and not retry until tonight.",
      "Failing open would let the crew through to a gateway with little room.",
    ],
    solution: [
      { command: "models features trust-score", why: "Two features STALE: order_history_365d (27 h) and address_graph_degree (29 h). Each adds its own declines." },
      { command: "pipelines logs features_order_history", why: "Cancelled by a recovery conflict during the replica failover; the replica has been healthy since 02:15." },
      { command: "pipelines run features_order_history", why: "Rebuilds order history on the healthy replica." },
      { command: "pipelines run features_address_graph", why: "Its run died in the same failover window on a statement timeout. Both refresh in about a minute." },
      { command: "models features trust-score", why: "Both fresh; declines back near 0.4%." },
    ],
    postmortem: {
      question: "What made trust-score decline customers with long order histories?",
      options: [
        "The refund-abuse crew poisoned the order history table",
        "v22 overweights address_graph_degree for repeat customers",
        "Two feature DAGs failed during the replica failover",
        "Its threshold was lowered for the refund-abuse crew",
      ],
      answerIndex: 2,
      explanation: {
        cause: "features_order_history and features_address_graph both failed while the read replica failed over.",
        why: "A recovery conflict cancelled one job and a statement timeout the other, so both features aged past the 26 h guard and each added its own declines. Failing open would have approved 40 refund-abuse checkouts a second on a gateway with 30 free. Rerunning both DAGs restored the inputs.",
        tell: "Two STALE features, one DAG log ending in SerializationFailure and the other in QueryCanceled, both inside the 01:30 failover window.",
      },
    },
  },
  {
    slug: "geoip-grant-revoked",
    title: "Nowhere near home",
    severity: "SEV2",
    model: "geo-risk",
    opensAtSecondOfDay: at(10, 5),
    briefing:
      "geo-risk is declining about one customer in nine, and support says they're shopping from home. Platform ran a big Terraform apply on the warehouse roles last night. A cross-border card ring is testing stolen EU cards from US proxies.",
    roleBriefing:
      "Data on-call: models (geo-risk in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; whatever geo-risk approves is charged.",
    scorer: {
      versions: [
        version("v10", -26 * DAY, "monthly retrain", 0.0045, 0.9),
        version("v11", -7 * DAY, "monthly retrain", 0.004, 0.92),
      ],
      active: "v11",
      threshold: 0.8,
      tunedThreshold: 0.8,
      features: [
        feature("ip_to_billing_km", "features_geoip", -30 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -5 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -2 * 60),
      ],
      staleFeatureDeclineShare: 0.1,
      fraudAttemptsPerSecond: 45,
    },
    gateway: { chargesPerSecond: 180 },
    failedRuns: [
      {
        dag: "features_geoip",
        feature: "ip_to_billing_km",
        logicalDate: "2026-10-09T02:00:00+00:00",
        at: -(7 * HOUR + 54 * 60 + 30),
        statement: "insert into features.ip_billing select c.customer_id, geo_distance(g.lat, g.lon, c.billing_lat, c.billing_lon) from sessions c join geoip_blocks g on c.ip <<= g.network",
        frame: PSYCOPG_FRAME,
        error: ["psycopg2.errors.InsufficientPrivilege: permission denied for table geoip_blocks", ""],
      },
    ],
    fraudLabel: "Cross-border card charges",
    fraudBound: 4500,
    declines: {
      name: "declined-distance",
      description: "Customers geo-risk declined in the last 15 min, with the IP-to-billing distance it scored",
      segmentColumn: "billing_country",
      detailColumn: "ip_to_billing_km_actual",
      rows: [
        ["US", 0.71, "4"],
        ["CA", 0.17, "9"],
        ["GB", 0.12, "6"],
      ],
      scored: { column: "ip_to_billing_km_scored", feature: "ip_to_billing_km", whileStale: "20000 (default)" },
    },
    ring: {
      name: "cross-border-cards",
      description: "EU-issued cards from US proxy exits, last 15 min, by issuing country",
      keyColumn: "issuer_country",
      amountUsd: "9.99",
      rows: [
        ["DE", 0.38],
        ["FR", 0.34],
        ["NL", 0.28],
      ],
    },
    suggestions: ["models features geo-risk", "pipelines list", "warehouse run declined-distance", "warehouse run cross-border-cards", "models threshold geo-risk 0.95"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Customers in Ohio getting declined for “unusual location”. They’re at home." },
      { at: 90, from: "Jonah Reyes · Product", text: "Bump geo-risk to 0.95 so fewer people trip it? Easy win." },
      { at: 150, from: "Rina Nakamura · Risk", text: "The cross-border ring is testing EU cards from US proxies, ~45 a second. Loosening geo-risk is the one thing they’d love." },
      { at: 220, from: "Tom Becker · Platform", text: "Last night’s Terraform apply dropped some grants on the warehouse; we restored them all at 08:05 (PLAT-551). Sorry, folks." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "One in nine declined. What’s the plan?" },
    ],
    hints: [
      "The customers are where they say they are. The scorer doesn't know that.",
      "An input that can't refresh falls back to a value that looks very far away.",
      "Whatever stopped the job overnight was undone this morning.",
    ],
    solution: [
      { command: "models features geo-risk", why: "ip_to_billing_km is 30 h old and STALE: every customer scored as 20,000 km from home." },
      { command: "pipelines logs features_geoip", why: "permission denied for table geoip_blocks: the Terraform apply dropped the grant. Platform restored it at 08:05." },
      { command: "pipelines run features_geoip", why: "Rebuilds the distance feature with the grant back; fresh in about a minute." },
      { command: "models features geo-risk", why: "ip_to_billing_km fresh; declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why was geo-risk declining customers shopping from home?",
      options: [
        "The proxy ring made customers' home IPs look like proxy exits",
        "v11 learned that US billing addresses are risky",
        "ip_to_billing_km went stale after a revoked table grant",
        "Its threshold was lowered for the cross-border ring",
      ],
      answerIndex: 2,
      explanation: {
        cause: "A Terraform apply revoked the geoip_blocks grant, so features_geoip failed and ip_to_billing_km went stale.",
        why: "Past the 26 h guard the scorer served the default distance, which looks like a card used half a world away. The stale-feature declines don’t depend on the threshold, so 0.95 would have barely helped customers while letting more of the ring through. Platform had restored the grant; a rerun refreshed the feature.",
        tell: "ip_to_billing_km was 30 h old and STALE, the DAG log ended in InsufficientPrivilege on geoip_blocks, and declined customers were scored 20,000 km from home.",
      },
    },
  },
  {
    slug: "gift-card-recall-loosen",
    title: "Loosen it until it stops",
    severity: "SEV2",
    model: "giftcard-risk",
    opensAtSecondOfDay: at(15, 30),
    briefing:
      "giftcard-risk v9 was promoted at 14:50 and since then roughly one customer in twelve is declined. A gift-card laundering crew is buying cards with stolen numbers. Product's plan is to loosen the threshold until declines look normal.",
    roleBriefing:
      "Data on-call: models (giftcard-risk in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; anything approved is charged.",
    scorer: {
      versions: [
        version("v8", -7 * DAY, "weekly retrain", 0.004, 0.95),
        version("v9", -40 * 60, "weekly retrain + recipient_email_domain", 0.085, 0.96),
      ],
      active: "v9",
      threshold: 0.8,
      tunedThreshold: 0.8,
      features: [
        feature("recipient_email_domain", "features_recipient_stream", -60),
        feature("customer_orders_90d", "features_customer_daily", -11 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -4 * 60),
      ],
      fraudAttemptsPerSecond: 50,
    },
    gateway: { chargesPerSecond: 180 },
    fraudLabel: "Laundering charges",
    fraudBound: 2600,
    declines: {
      name: "declined-recipients",
      description: "Customers giftcard-risk declined in the last 15 min, by recipient email domain",
      segmentColumn: "recipient_domain",
      detailColumn: "declined_by_v8_last_week",
      rows: [
        ["gmail.com", 0.47, "0.3%"],
        ["icloud.com", 0.31, "0.4%"],
        ["outlook.com", 0.22, "0.4%"],
      ],
    },
    ring: {
      name: "gift-card-laundering",
      description: "Gift-card purchases sent to throwaway recipient domains, last 15 min",
      keyColumn: "recipient_domain",
      amountUsd: "250.00",
      rows: [
        ["mailinator.com", 0.45],
        ["sharklasers.com", 0.33],
        ["guerrillamail.com", 0.22],
      ],
    },
    suggestions: ["models show giftcard-risk", "warehouse run declined-recipients", "warehouse run gift-card-laundering", "models threshold giftcard-risk 0.95"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Jonah Reyes · Product", text: "Let’s move giftcard-risk to 0.95. Declines drop, everyone’s happy." },
      { at: 90, from: "Owen Price · ML platform", text: "v9 promoted at 14:50 with recipient_email_domain. It flags big webmail domains more than v8 did; we thought that was fine." },
      { at: 160, from: "Rina Nakamura · Risk", text: "Laundering crew is live, ~50 purchases a second to throwaway inboxes." },
      { at: 240, from: "Maya Okonkwo · Support", text: "People sending gift cards to their mums on gmail are declined." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "Is this the new version?" },
    ],
    hints: [
      "Declines started at a specific minute. What went live then?",
      "A looser threshold makes a bad version decline a little less, and catch less too.",
      "The version before it declined almost nobody for the same recipients.",
    ],
    solution: [
      { command: "models show giftcard-risk", why: "v9 went live at 14:50 and declines 8.5% of customers; v8 declined 0.4%." },
      { command: "warehouse run declined-recipients", why: "The declines are mainstream webmail recipients that v8 approved last week." },
      { command: "models rollback giftcard-risk --to v8", why: "Serves v8 at the tuned threshold: 0.4% declined, the crew still caught." },
      { command: "models list", why: "Declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why wouldn't loosening giftcard-risk to 0.95 have fixed it?",
      options: [
        "v9 would still decline about 2.6% and approve more laundering",
        "The threshold is ignored for gift-card purchases entirely",
        "A higher threshold forces a retrain before it takes effect",
        "The laundering crew's scores sit below 0.8 regardless of model",
      ],
      answerIndex: 0,
      explanation: {
        cause: "giftcard-risk v9’s new recipient_email_domain feature declined mainstream webmail recipients.",
        why: "Moving the threshold trades declines for missed fraud on the same bad version. At 0.95 v9 would still decline about 2.6% of customers and let more laundering through. Rolling back to v8 removed the bad feature at the tuned threshold.",
        tell: "Declines began at v9’s 14:50 promotion, v9 declined 8.5% against v8’s 0.4%, and declined recipients were gmail, icloud and outlook addresses.",
      },
    },
  },
  {
    slug: "holiday-sample-promotion",
    title: "Trained on the wrong season",
    severity: "SEV2",
    model: "velocity-guard",
    opensAtSecondOfDay: at(16, 10),
    briefing:
      "velocity-guard v14 went live at 15:20 and since then about one customer in eight is declined. A coupon-stacking bot farm is checking out with stolen cards at 50 orders a second. Support wants fraud checks off for the evening.",
    roleBriefing:
      "Data on-call: models (velocity-guard in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; whatever velocity-guard approves goes on to the gateway.",
    scorer: {
      versions: [
        version("v12", -21 * DAY, "monthly retrain", 0.0045, 0.97),
        version("v13", -8 * DAY, "monthly retrain", 0.004, 0.975),
        version("v14", -50 * 60, "retrain on last November's sample (ML-977)", 0.12, 0.99),
      ],
      active: "v14",
      threshold: 0.85,
      tunedThreshold: 0.85,
      features: [
        feature("orders_per_hour_customer", "features_velocity_stream", -2 * 60),
        feature("coupon_codes_7d", "features_coupon_daily", -10 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -9 * HOUR),
      ],
      fraudAttemptsPerSecond: 50,
    },
    gateway: { chargesPerSecond: 155 },
    fraudLabel: "Bot-farm charges",
    fraudBound: 2500,
    declines: {
      name: "declined-velocity-bands",
      description: "Customers velocity-guard declined in the last 15 min, by orders this hour",
      segmentColumn: "orders_this_hour",
      detailColumn: "typical_november_rate",
      rows: [
        ["1", 0.74, "3"],
        ["2", 0.21, "5"],
        ["3+", 0.05, "8"],
      ],
    },
    ring: {
      name: "coupon-bots",
      description: "Orders stacking three or more coupon codes from headless browsers, last 15 min",
      keyColumn: "coupon_code",
      amountUsd: "57.40",
      rows: [
        ["WELCOME20", 0.51],
        ["AUTUMN15", 0.31],
        ["FREESHIP", 0.18],
      ],
    },
    suggestions: ["models show velocity-guard", "warehouse run declined-velocity-bands", "warehouse run coupon-bots", "models mode velocity-guard fail-open"],
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Can we fail open velocity-guard for tonight? It’s declining people placing one order." },
      { at: 90, from: "Hiro Tanaka · ML platform", text: "v14 was retrained on last November’s sample by mistake (ML-977). It thinks one order an hour is quiet for a customer, which it is in November." },
      { at: 150, from: "Lena Park · Trust & Safety", text: "The coupon bot farm is live, 50 checkouts a second. Failing open hands them the store." },
      { at: 230, from: "Sam Tan · SRE", text: "Gateway gives us 155 charges a second; we’re around 120." },
      { at: 330, from: "Elena Ruiz · VP Engineering", text: "What’s the call?" },
    ],
    hints: [
      "Declines started when something went live this afternoon.",
      "The bot farm is real, and the scorer is what stops it.",
      "Approving everyone would send the bots to a gateway with little room.",
    ],
    solution: [
      { command: "models show velocity-guard", why: "v14 went live at 15:20 and declines 12%; v13 declined 0.4%." },
      { command: "warehouse run coupon-bots", why: "50 bot checkouts a second. Failing open would push the gateway past 155." },
      { command: "models rollback velocity-guard --to v13", why: "Back to v13: 0.4% declined and 97.5% of the bots caught." },
      { command: "models list", why: "Declines back near 0.4%." },
    ],
    postmortem: {
      question: "Why did velocity-guard start declining single orders at 15:20?",
      options: [
        "v14 was retrained on last November's traffic",
        "The bot farm's coupon codes leaked into customer features",
        "Its threshold was lowered to stop the bot farm",
        "coupon_codes_7d went stale and defaulted to a high count",
      ],
      answerIndex: 0,
      explanation: {
        cause: "velocity-guard v14 was retrained on last November’s traffic by mistake.",
        why: "In November customers order more often, so v14 learned that one order an hour in October is unusual and declined 12% of customers. Failing open would have sent 50 bot checkouts a second to a gateway with 35 to spare. Rolling back to v13 restored October’s norms.",
        tell: "Declines began at v14’s 15:20 deploy, v14 declined 12% against v13’s 0.4%, and declined customers had placed a single order that hour.",
      },
    },
  },
  {
    slug: "loose-arm-left-on",
    title: "The experiment nobody ended",
    severity: "SEV1",
    model: "risk-ensemble",
    opensAtSecondOfDay: at(17, 40),
    briefing:
      "Gateway calls are timing out and customers are charged for orders that fail. A triangulation-fraud ring is buying goods for resale on stolen cards. Risk wants risk-ensemble locked down hard: threshold 0.4 until the ring gives up.",
    roleBriefing:
      "Data on-call: models (risk-ensemble in front of the payment gateway), pipelines and the warehouse. What risk-ensemble approves joins the gateway queue beside real customers; the gateway takes about 150 charges a second for us.",
    scorer: {
      versions: [
        version("v6", -16 * DAY, "monthly retrain", 0.0045, 0.88),
        version("v7", -5 * DAY, "monthly retrain", 0.004, 0.9),
      ],
      active: "v7",
      threshold: 0.98,
      tunedThreshold: 0.8,
      features: [
        feature("ship_bill_mismatch", "features_address_daily", -8 * HOUR),
        feature("customer_orders_90d", "features_customer_daily", -7 * HOUR),
        feature("card_bin_velocity_1h", "features_card_velocity", -3 * 60),
      ],
      fraudAttemptsPerSecond: 160,
    },
    gateway: { chargesPerSecond: 150, backlog: 320 },
    fraudLabel: "Triangulation charges",
    fraudBound: 20000,
    declines: {
      name: "ab-arms",
      description: "Checkouts in the last 15 min by A/B arm of exp-ensemble-threshold",
      segmentColumn: "arm",
      detailColumn: "threshold",
      rows: [
        ["loose (100% since Tue)", 1, "0.98"],
        ["control (0%)", 0, "0.80"],
      ],
    },
    ring: {
      name: "triangulation",
      description: "Orders shipping to marketplace resellers' forwarding addresses, last 15 min",
      keyColumn: "marketplace",
      amountUsd: "189.00",
      rows: [
        ["resale listing A", 0.57],
        ["resale listing B", 0.43],
      ],
    },
    suggestions: ["models show risk-ensemble", "warehouse run ab-arms", "warehouse run triangulation", "models threshold risk-ensemble 0.4"],
    lostCheckoutsPerPoint: 300,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% for 5m (payment-gateway timeouts). Data on-call paged." },
      { at: 30, from: "Sam Tan · SRE", text: "Gateway queue past 2 s and growing; we’re sending more than 150 a second." },
      { at: 80, from: "Rina Nakamura · Risk", text: "Triangulation ring, ~160 orders a second. Lock risk-ensemble down to 0.4 until they leave." },
      { at: 150, from: "Nina Okafor · Growth", text: "Oh no. The exp-ensemble-threshold A/B ended Tuesday and the loose arm got ramped to 100% instead of switched off. That’s 0.98." },
      { at: 230, from: "Grace Liu · Finance", text: "We’re capturing charges on orders that fail. Refund volume is climbing." },
      { at: 320, from: "Elena Ruiz · VP Engineering", text: "SEV1. What’s filling the gateway?" },
    ],
    hints: [
      "Count who is calling the gateway, customers or the ring.",
      "A threshold was changed for an experiment and never put back.",
      "Locking down well past the tuned value declines customers instead of timing them out.",
    ],
    solution: [
      { command: "models show risk-ensemble", why: "Threshold 0.98 against a tuned 0.8: the A/B loose arm, ramped to 100% on Tuesday." },
      { command: "warehouse run triangulation", why: "~160 ring orders a second, about 33 of them approved: 120 customers plus 33 overflows 150." },
      { command: "models threshold risk-ensemble 0.8", why: "Back to the tuned value: 90% of the ring caught, gateway drains, 0.4% declined." },
      { command: "models list", why: "Approved fraud down to ~16 a second; declines near 0.4%." },
    ],
    postmortem: {
      question: "Why was a 0.4 lockdown the wrong response?",
      options: [
        "It would decline about 9% of real customers",
        "The gateway charges a fee for every declined authorization",
        "risk-ensemble ignores thresholds below 0.5 by design",
        "The ring's orders score below 0.4 and would still get through",
      ],
      answerIndex: 0,
      explanation: {
        cause: "An A/B test’s loose arm left risk-ensemble’s threshold at 0.98 instead of the tuned 0.8.",
        why: "At 0.98 about 33 ring orders a second were approved and the gateway overflowed. Dropping to 0.4 would have caught more fraud but declined about 9% of real customers. Restoring 0.8 caught 90% of the ring with 0.4% declines.",
        tell: "Threshold 0.98 against a tuned 0.8, the loose arm at 100% since Tuesday, near-zero declines, and ring orders filling the gateway.",
      },
    },
  },
];

export const DATA_TIER3_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
