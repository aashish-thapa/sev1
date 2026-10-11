import type { AlertMetric, CommsMessage, Evidence, ExternalService, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { airflowCompact, airflowLine } from "../shell/commands/pipelines.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { pendingRefunds, visibleOrphans } from "../sim/commerce-actions.ts";
import { activeVersion, fraudDeclines, isFeatureStale, scoredAt } from "../sim/fraud.ts";
import type { ClusterState, LogEntry } from "../sim/model.ts";
import { checkoutCluster, type WarmUp } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, fraudScorer, lastQuarterHour, scorerOf } from "./fraud-scorer.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const MENTOR = "Tomás Varga · Staff data engineer (your mentor)";
const REVISIONS = [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }];
/** A degraded gateway completing exactly checkout's steady 120 charges a second, so a residual queue neither drains nor grows. */
const DEGRADED_GATEWAY_CHARGES_PER_SECOND = 120;

type ScorerSetup = Parameters<typeof fraudScorer>[0];

/** What every tier-1 data page carries, whatever the mechanic underneath. */
type Story = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly service: string;
  readonly opensAt: readonly [hour: number, minute: number];
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly suggestions: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
  readonly externals: readonly ExternalService[];
};

/** A saved warehouse view: one row per cohort with its share of what the incident counts, then fixed cells. */
type ShareView = {
  readonly name: string;
  readonly description: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly [label: string, share: number, ...cells: string[]])[];
};

function idOf(story: Story): string {
  return `data-t1-${story.slug}`;
}

function secondOfDay([hour, minute]: Story["opensAt"]): number {
  return hour * HOUR + minute * 60;
}

function wallClock(second: number): string {
  const total = ((second % DAY) + DAY) % DAY;
  return `${String(Math.floor(total / HOUR)).padStart(2, "0")}:${String(Math.floor((total % HOUR) / 60)).padStart(2, "0")}`;
}

function storyParts(story: Story) {
  const id = idOf(story);
  return {
    id,
    tier: 1,
    title: story.title,
    severity: story.severity,
    service: story.service,
    briefing: story.briefing,
    roles: ["data"],
    roleBriefings: { data: story.roleBriefing },
    opensAtSecondOfDay: secondOfDay(story.opensAt),
    seed: id,
    suggestions: { data: story.suggestions },
    lostCheckoutsPerPoint: story.lostCheckoutsPerPoint,
    externals: story.externals,
    comms: story.comms,
    postmortem: story.postmortem,
    hints: story.hints,
    solution: { data: story.solution },
  } satisfies Partial<Scenario>;
}

function shareTable(view: ShareView, measure: (state: ClusterState) => number) {
  return (state: ClusterState): readonly string[] =>
    sqlTable(
      view.columns,
      view.rows.map(([label, share, ...cells]) => [label, String(Math.round(measure(state) * share)), ...cells]),
    );
}

function warehouseView(view: ShareView, run: Evidence["run"]): Evidence {
  return { tool: "warehouse", name: view.name, description: view.description, run };
}

// ── Refunds: a gateway queue that ran past checkout-api's timeout left captured charges with no order ──

type RefundRow = Story & {
  /** Seconds since the surge began, and the demand each of them. */
  readonly surge: WarmUp;
  /** Gateway queue left at the page, in seconds of capacity: just past 2.2 s, so a trickle of late captures goes on. */
  readonly residualQueueSeconds: number;
  readonly averageOrderCents: number;
  /** Incident second the settlement batch closes; refunds queued before it go out as voids. */
  readonly cutoffAt: number;
  readonly view: ShareView;
};

function refundBacklog(state: ClusterState): number {
  const { commerce } = state;
  const quarterHourOfCheckouts = (commerce?.pulse.organicCheckoutsPerSecond ?? 0) * 15 * 60;
  return commerce && quarterHourOfCheckouts > 0 ? pendingRefunds(commerce) / quarterHourOfCheckouts : 0;
}

function unrefundedShare(state: ClusterState): number {
  const { commerce } = state;
  if (!commerce) return 0;
  const visible = visibleOrphans(commerce);
  return visible > 0 ? pendingRefunds(commerce) / visible : 0;
}

const REFUND_ALERT: AlertMetric = { label: "charges to refund, vs 15 min of checkouts", rate: refundBacklog };

function refundIncident(row: RefundRow): Scenario {
  const parts = storyParts(row);
  const cutoffClock = wallClock(parts.opensAtSecondOfDay + row.cutoffAt);
  return {
    ...parts,
    initialState: () => {
      const state = checkoutCluster({
        seed: parts.id,
        revisions: REVISIONS,
        revision: 6,
        commerce: checkoutCommerce({ gateway: { chargesPerSecond: DEGRADED_GATEWAY_CHARGES_PER_SECOND } }),
        warmUp: row.surge,
      });
      const { commerce } = state;
      if (!commerce) return state;
      return {
        ...state,
        commerce: {
          ...commerce,
          gateway: { ...commerce.gateway, backlog: DEGRADED_GATEWAY_CHARGES_PER_SECOND * row.residualQueueSeconds },
          ledger: { ...commerce.ledger, averageOrderCents: row.averageOrderCents },
        },
      };
    },
    alertMetric: REFUND_ALERT,
    isRootCauseFixed: (state) => unrefundedShare(state) < 0.05,
    objectives: (state): readonly Objective[] => [
      {
        role: "data",
        label: `Refund batch queued before the ${cutoffClock} settlement cut-off`,
        isMet: (state.commerce?.ledger.refundBatches ?? []).some((batch) => batch.at < row.cutoffAt),
      },
    ],
    evidence: [warehouseView(row.view, shareTable(row.view, (state) => (state.commerce ? visibleOrphans(state.commerce) : 0)))],
  };
}

// ── fraud-scorer: a model, a threshold, a mode and the features it reads ──

type ScorerRow = Story & { readonly scorer: ScorerSetup; readonly gatewayChargesPerSecond?: number };

function scorerState(id: string, row: ScorerRow, logs: Readonly<Record<string, readonly LogEntry[]>> = {}): ClusterState {
  const state = checkoutCluster({
    seed: id,
    revisions: REVISIONS,
    revision: 6,
    commerce: checkoutCommerce({ gateway: { chargesPerSecond: row.gatewayChargesPerSecond ?? 180 }, fraud: fraudScorer(row.scorer) }),
  });
  const { commerce } = state;
  if (!commerce) return state;
  // Fraud captured counts from the page on.
  return { ...state, logs: { ...state.logs, ...logs }, commerce: { ...commerce, ledger: { ...commerce.ledger, fraudulentCaptures: 0 } } };
}

const declinedLastQuarterHour = (state: ClusterState) => lastQuarterHour(state)?.declined ?? 0;

/** A version that declines far more good customers than the one before it. */
type RollbackRow = ScorerRow & { readonly view: ShareView; readonly topReason: Readonly<Record<string, string>> };

function rollbackIncident(row: RollbackRow): Scenario {
  const parts = storyParts(row);
  const table = shareTable(row.view, declinedLastQuarterHour);
  return {
    ...parts,
    initialState: () => scorerState(parts.id, row),
    alertMetric: CUSTOMERS_LOST,
    isRootCauseFixed: (state) => {
      const fraud = scorerOf(state);
      const version = fraud && activeVersion(fraud);
      return !!fraud && !!version && fraud.mode === "enforce" && version.falseDeclineShare <= 0.01;
    },
    evidence: [
      warehouseView(row.view, (state) => {
        const fraud = scorerOf(state);
        return fraud ? [...table(state), `Top decline reason in ${fraud.model} ${fraud.active}'s score explanations: ${row.topReason[fraud.active] ?? "none"}`] : [];
      }),
    ],
  };
}

/** A threshold moved away from where it was tuned. */
type ThresholdRow = ScorerRow & {
  readonly view: Omit<ShareView, "rows"> & { readonly aboveTuned: string; readonly belowTuned: string };
};

function thresholdIncident(row: ThresholdRow): Scenario {
  const parts = storyParts(row);
  return {
    ...parts,
    initialState: () => scorerState(parts.id, row),
    alertMetric: CUSTOMERS_LOST,
    isRootCauseFixed: (state) => {
      const fraud = scorerOf(state);
      return !!fraud && fraud.mode === "enforce" && fraud.threshold >= fraud.tunedThreshold - 0.05 && fraud.threshold <= fraud.tunedThreshold + 0.1;
    },
    evidence: [
      {
        tool: "warehouse",
        name: row.view.name,
        description: row.view.description,
        run: (state) => {
          const window = lastQuarterHour(state);
          const fraud = scorerOf(state);
          const version = fraud && activeVersion(fraud);
          if (!window || !fraud || !version) return [];
          const { threshold, tunedThreshold } = fraud;
          const atTuned = Math.min(window.declined, window.customers * scoredAt(version, tunedThreshold, tunedThreshold).falseDeclineShare);
          const rows = [[`${Math.max(threshold, tunedThreshold).toFixed(2)}-1.00`, String(Math.round(atTuned)), row.view.aboveTuned]];
          if (threshold < tunedThreshold) rows.push([`${threshold.toFixed(2)}-${tunedThreshold.toFixed(2)}`, String(Math.round(window.declined - atTuned)), row.view.belowTuned]);
          return sqlTable(row.view.columns, rows);
        },
      },
    ],
  };
}

/** A feature DAG whose last scheduled run failed, leaving one feature past the scorer's freshness guard. */
type StaleRow = ScorerRow & {
  readonly failure: {
    readonly dag: string;
    readonly feature: string;
    /** "HH:MM" the DAG is scheduled at; Airflow names the run after the previous day's slot. */
    readonly schedule: string;
    /** Incident second the third and last attempt failed. */
    readonly failedAt: number;
    readonly sql: string;
    /** What psycopg2 raised, as the traceback prints it. */
    readonly error: readonly string[];
  };
  readonly view: ShareView;
};

/** The failed task's log: Airflow 2.10 lines around the exception psycopg2 raised. */
function failedRunLog(opensAt: number, failure: StaleRow["failure"]): readonly LogEntry[] {
  const task = `build_${failure.feature}`;
  const runId = `scheduled__2026-10-09T${failure.schedule}:00+00:00`;
  const entry = (offset: number, origin: string, isError: boolean, message: string): LogEntry => ({
    t: failure.failedAt + offset,
    source: failure.dag,
    level: isError ? "ERROR" : "INFO",
    text: airflowLine(opensAt, failure.failedAt + offset, origin, isError ? "ERROR" : "INFO", message),
  });
  return [
    entry(0, "taskinstance.py:2867", false, "Starting attempt 3 of 3"),
    entry(0, "standard_task_runner.py:72", false, `Started process ${40_000 + (Math.abs(failure.failedAt) % 9000)} to run task`),
    entry(1, "task_command.py:467", false, `Running <TaskInstance: ${failure.dag}.${task} ${runId} [running]> on host airflow-worker-0.airflow-worker.data.svc.cluster.local`),
    entry(2, "sql.py:282", false, `Executing: ${failure.sql}`),
    entry(2, "sql.py:509", false, `Running statement: ${failure.sql}, parameters: None`),
    entry(
      3,
      "taskinstance.py:3313",
      true,
      [
        "Task failed with exception",
        "Traceback (most recent call last):",
        '  File "/home/airflow/.local/lib/python3.12/site-packages/airflow/providers/common/sql/hooks/sql.py", line 514, in _run_command',
        "    cur.execute(sql_statement)",
        ...failure.error,
        // libpq ends the message with a newline and Python's traceback adds its own.
        "",
      ].join("\n"),
    ),
    entry(
      3,
      "taskinstance.py:1226",
      false,
      `Marking task as FAILED. dag_id=${failure.dag}, task_id=${task}, run_id=${runId}, execution_date=20261009T${failure.schedule.replace(":", "")}00, start_date=${airflowCompact(opensAt, failure.failedAt)}, end_date=${airflowCompact(opensAt, failure.failedAt + 3)}`,
    ),
    entry(4, "local_task_job_runner.py:266", false, "Task exited with return code 1"),
    entry(4, "taskinstance.py:3901", false, "0 downstream tasks scheduled from follow-on schedule check"),
  ];
}

function staleIncident(row: StaleRow): Scenario {
  const parts = storyParts(row);
  const { feature } = row.failure;
  return {
    ...parts,
    initialState: () => scorerState(parts.id, row, { [row.failure.dag]: failedRunLog(parts.opensAtSecondOfDay, row.failure) }),
    alertMetric: CUSTOMERS_LOST,
    isRootCauseFixed: (state) => {
      const fraud = scorerOf(state);
      return !!fraud && fraud.mode === "enforce" && fraud.features.every((candidate) => !isFeatureStale(candidate, state.t));
    },
    evidence: [
      warehouseView(row.view, (state) => {
        const scored = scorerOf(state)?.features.find((candidate) => candidate.name === feature);
        if (!scored) return [];
        const isStale = isFeatureStale(scored, state.t);
        const declined = declinedLastQuarterHour(state);
        return sqlTable(
          row.view.columns,
          row.view.rows.map(([label, share, actual = "0"]) => [label, String(Math.round(declined * share)), isStale ? "0" : actual, actual]),
        );
      }),
    ],
  };
}

/** fraud-scorer left approving everything. */
type FailOpenRow = ScorerRow & {
  readonly view: ShareView;
  /** Pages on fraud's share of gateway charges, with a capture bound, when the gateway has room and customers notice nothing. */
  readonly fraudCaptureBound?: number;
};

/** Share of what reaches the gateway that the scorer let through as fraud. */
function fraudShareOfCharges(state: ClusterState): number {
  const { commerce } = state;
  if (!commerce) return 0;
  const fraud = fraudDeclines(commerce, state.t).gatewayCallsPerSecond;
  const calls = commerce.pulse.gatewayCallsPerSecond + fraud;
  return calls > 0 ? fraud / calls : 0;
}

function failOpenIncident(row: FailOpenRow): Scenario {
  const parts = storyParts(row);
  const bound = row.fraudCaptureBound;
  return {
    ...parts,
    initialState: () => scorerState(parts.id, row),
    alertMetric: bound === undefined ? CUSTOMERS_LOST : { label: "fraud share of gateway charges", rate: fraudShareOfCharges },
    isRootCauseFixed: (state) => scorerOf(state)?.mode === "enforce",
    ...(bound === undefined
      ? {}
      : {
          objectives: (state: ClusterState): readonly Objective[] => {
            const captured = Math.round(state.commerce?.ledger.fraudulentCaptures ?? 0);
            return [
              {
                role: "data",
                label: `Fraudulent charges captured since the page: ${captured.toLocaleString("en-US")} (keep under ${bound.toLocaleString("en-US")})`,
                isMet: captured < bound,
              },
            ];
          },
        }),
    evidence: [warehouseView(row.view, shareTable(row.view, (state) => lastQuarterHour(state)?.fraudApproved ?? 0))],
  };
}

// ── Shared story pieces ──

const PAGE_DECLINES = (severity: string) =>
  `${severity} triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged.`;

const SCORER_BRIEFING =
  "Data on-call: models (fraud-scorer, in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge: no 5xx, just a customer who leaves.";

const REFUND_BRIEFING =
  "Data on-call: warehouse (payments and orders via CDC, ~45 s behind) and reconcile (refund batches Payments Ops executes through the gateway).";

function gateway(status: ExternalService["status"], ...facts: readonly (readonly [string, string])[]): ExternalService {
  return { id: "payment-gateway", status, facts: facts.map(([key, value]) => ({ key, value })) };
}

const SCORER_GATEWAY = gateway("ok", ["Status page", "All systems operational"], ["Declines", "Card-network declines normal; the 402s come from fraud-scorer, before any charge"]);

function refundSteps(view: string, evidence: string, cutoff: string): readonly SolutionStep[] {
  return [
    { command: `warehouse run ${view}`, why: evidence },
    { command: "reconcile preview", why: "How many charges a batch would refund now, and that only a trickle is still arriving." },
    { command: "reconcile submit", why: `Queues a refund for every visible orphaned charge before ${cutoff}, so they go out as voids.` },
    { command: "reconcile status", why: "The batch is queued. The late trickle adds a few a minute; a later batch sweeps them up." },
  ];
}

/** Demand per second since the surge began: each phase's rate until its end second, then the steady 300 rps. */
const surge = (seconds: number, phases: readonly (readonly [end: number, rps: number])[]): WarmUp => ({
  seconds,
  requestsPerSecond: (second) => phases.find(([end]) => second < end)?.[1] ?? 300,
});

// ── The incidents ──

const LUNCH_FLASH: RefundRow = {
  slug: "lunch-flash-voids",
  title: "Charged at lunch, no order",
  severity: "SEV3",
  service: "payments-recon",
  opensAt: [12, 14],
  surge: surge(14 * 60, [
    [55, 380],
    [200, 230],
  ]),
  residualQueueSeconds: 2.203,
  averageOrderCents: 3290,
  cutoffAt: 26 * 60,
  briefing:
    "The 12:00 Lunch Flash email went to 1.4 million customers. For about a minute payment-gateway queued charges past checkout-api’s 3 s timeout: customers saw an error, and the gateway captured their card anyway. Checkout recovered by 12:04. Finance wants every charge without an order refunded before the 12:40 settlement batch.",
  roleBriefing: `${REFUND_BRIEFING} Nothing is down. Find the charges with no order behind them and refund them before 12:40.`,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV3 triggered — payments-recon: captured charges with no paid order above threshold since 12:00. Data on-call paged." },
    { at: 15, from: MENTOR, text: "I’m shadowing you today. Start with the charges that have no order behind them; there’s a saved warehouse query for this exact shape." },
    { at: 45, from: "Maya Okonkwo · Support", text: "Lunch Flash customers say checkout errored and they still got a bank notification for the charge." },
    { at: 90, from: "Grace Liu · Finance", text: "Settlement runs at 12:40. Refund before then and it’s a void: no fee, nothing on the statement. After that it’s a 5–10 day refund." },
    { at: 150, from: "Sam Tan · SRE", text: "Gateway queue is back under 3 s. A few charges a minute still land late, nothing like the spike." },
    { at: 240, from: "Jonah Reyes · Product", text: "Shouldn’t we wait until the gateway is fully healthy and do one clean batch tonight?" },
    { at: 300, from: MENTOR, text: "Refunds are keyed by charge id, so a second batch later can’t refund anyone twice. Don’t wait for a perfect list." },
  ],
  hints: [
    "Find the charges the gateway captured that never became a paid order.",
    "The settlement batch is the deadline that matters, not the gateway’s recovery.",
    "A second batch later only picks up stragglers; a refund never repeats a charge.",
  ],
  suggestions: ["warehouse saved", "warehouse run lunch-orphans-by-wait", "warehouse run orphaned-captures", "reconcile preview", "reconcile status"],
  view: {
    name: "lunch-orphans-by-wait",
    description: "Charges captured since 12:00 with no paid order, by how long they waited in the gateway queue",
    columns: ["gateway_queue_wait", "orphaned_charges", "had_idempotency_key"],
    rows: [
      ["3-5 s", 0.44, "t"],
      ["5-8 s", 0.38, "t"],
      ["8 s+", 0.18, "t"],
    ],
  },
  solution: refundSteps(
    "lunch-orphans-by-wait",
    "Every orphaned charge waited 3 s or more in the gateway queue: checkout-api had already given up on it.",
    "12:40",
  ),
  lostCheckoutsPerPoint: 150,
  externals: [
    gateway(
      "degraded",
      ["Status page", "Elevated acquirer latency since 11:58; recovering"],
      ["checkout-api timeout", "3000 ms per call; queued calls still get captured"],
      ["Settlement", "Today’s batch closes 12:40. Refunds before then are voids"],
    ),
  ],
  postmortem: {
    question: "Why were Lunch Flash customers charged without an order?",
    options: [
      "Queued charges were captured after checkout-api timed out",
      "The Lunch Flash email linked customers to an old checkout page",
      "Customers double-tapped Pay with no idempotency key sent",
      "CDC lag made the warehouse show paid orders as missing",
    ],
    answerIndex: 0,
    explanation: {
      cause: "payment-gateway queued charges past checkout-api’s 3 s timeout and captured them anyway.",
      why: "checkout-api gave up after 3 s and failed the order, but the gateway works its queue in order and captured the card regardless. The customer saw an error and kept a charge with no order. Refunds queued before the 12:40 settlement go out as voids, which never reach a statement.",
      tell: "Every orphaned charge waited 3 s or more in the gateway queue and carried an Idempotency-Key, and they bunched in the minute after the 12:00 email.",
    },
  },
};

const GIFT_CARD_PROMO: RefundRow = {
  slug: "gift-card-promo-refunds",
  title: "Gift card promo, charges with no card",
  severity: "SEV2",
  service: "payments-recon",
  opensAt: [18, 9],
  surge: surge(9 * 60, [
    [70, 350],
    [240, 250],
  ]),
  residualQueueSeconds: 2.204,
  averageOrderCents: 5000,
  cutoffAt: 21 * 60,
  briefing:
    "The 18:00 gift card promo (buy $50, get $10) went live with a homepage takeover. payment-gateway is running from its secondary region tonight at about 120 charges a second, and for a minute its queue ran past checkout-api’s 3 s timeout. Customers were charged for gift cards that were never issued. Refund them before the 18:30 settlement.",
  roleBriefing: `${REFUND_BRIEFING} The gateway is the gateway’s problem; the charges with no gift card behind them are yours.`,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — payments-recon: gift card charges with no issued card above threshold since 18:00. Data on-call paged." },
    { at: 20, from: MENTOR, text: "Gift cards make this easy to see: a paid order issues a card code. Look for charges with no code behind them." },
    { at: 60, from: "Priya Shah · Payments", text: "payment-gateway failed over to its secondary region at 17:40 for planned maintenance. Secondary gives us about 120 charges a second, no more." },
    { at: 110, from: "Maya Okonkwo · Support", text: "Customers are posting screenshots: “Payment failed”, then a $50 charge on their card. Some bought a second card and got that one." },
    { at: 200, from: "Grace Liu · Finance", text: "Settlement is 18:30 tonight. Voids before then, full refunds after." },
    { at: 330, from: "Jonah Reyes · Product", text: "Could we issue the missing gift card codes instead of refunding? Customers might prefer that." },
    { at: 380, from: MENTOR, text: "Issuing codes means guessing what each customer wanted, and many already bought again. A refund before settlement is clean." },
  ],
  hints: [
    "A paid order issues a gift card code. Look for captured charges with nothing issued.",
    "The gateway is still slow, so a few charges a minute keep arriving late. Don’t wait for zero.",
    "Before settlement a refund is a void; after it, a 5–10 day refund.",
  ],
  suggestions: ["warehouse saved", "warehouse run giftcard-charges-no-code", "warehouse run revenue-vs-orders", "reconcile preview"],
  view: {
    name: "giftcard-charges-no-code",
    description: "Gift card charges captured since 18:00 with no card issued, by product",
    columns: ["sku", "charges_without_card", "median_queue_wait_s"],
    rows: [
      ["GC-50-DIGITAL", 0.61, "5.8"],
      ["GC-100-DIGITAL", 0.27, "6.1"],
      ["GC-25-PLASTIC", 0.12, "5.4"],
    ],
  },
  solution: refundSteps(
    "giftcard-charges-no-code",
    "Thousands of gift card charges with no card issued, all from the minute the secondary-region queue ran past 3 s.",
    "18:30",
  ),
  lostCheckoutsPerPoint: 150,
  externals: [
    gateway(
      "degraded",
      ["Status page", "Planned maintenance: traffic served from secondary region"],
      ["Throughput for us", "≈120 charges/s on the secondary; excess queues FIFO"],
      ["Settlement", "Tonight’s batch closes 18:30"],
    ),
  ],
  postmortem: {
    question: "Why were customers charged for gift cards they never got?",
    options: [
      "The gift card code service ran out of unused codes at 18:00",
      "Late charges were captured after checkout-api gave up",
      "The promo charged the $10 bonus as a separate card payment",
      "The secondary gateway region charged every card twice",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The gateway’s queue ran past checkout-api’s 3 s timeout, and late charges still captured.",
      why: "On its secondary region the gateway takes about 120 charges a second. The 18:00 surge queued calls past 3 s, so checkout-api failed the order and never issued a card, while the gateway captured the charge anyway. Refunding before the 18:30 settlement turns each one into a void.",
      tell: "Every charge without a card waited over 3 s in the gateway queue, carried an Idempotency-Key and fell in the minutes after 18:00; none had a code issued.",
    },
  },
};

const PUSH_SURGE: RefundRow = {
  slug: "push-notification-surge",
  title: "One push, thousands of orphaned charges",
  severity: "SEV3",
  service: "payments-recon",
  opensAt: [20, 7],
  surge: surge(7 * 60, [
    [45, 470],
    [140, 200],
  ]),
  residualQueueSeconds: 2.2025,
  averageOrderCents: 4120,
  cutoffAt: 23 * 60,
  briefing:
    "At 20:00 the app sent a “24 hours only” push to every installed device. Checkout took a 45-second wall of traffic, payment-gateway queued charges past checkout-api’s 3 s timeout, and app customers were charged for orders that failed. The app is fine now. Payments Ops needs a refund batch before the 20:30 settlement.",
  roleBriefing: `${REFUND_BRIEFING} Nothing to restart. Find the charges with no order and refund them in time.`,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV3 triggered — payments-recon: captured charges with no paid order above threshold since 20:00. Data on-call paged." },
    { at: 20, from: MENTOR, text: "Growth sent a push to everyone at once. Look at the charges from the first minute and whether an order exists for each." },
    { at: 50, from: "Lena Ortiz · Growth", text: "Sorry, that was us. The push was meant to go out in waves over an hour. It went to all 2.1 million devices at 20:00:00." },
    { at: 120, from: "Maya Okonkwo · Support", text: "App reviews are filling with “charged but no order”. People want to know if they’ll get the money back." },
    { at: 210, from: "Grace Liu · Finance", text: "20:30 is settlement. Anything refunded before then is a void." },
    { at: 400, from: "Sam Tan · SRE", text: "Gateway latency is normal again apart from a slow trickle on the tail." },
  ],
  hints: [
    "The surge lasted under a minute. The charges it left behind didn’t go away.",
    "Customers saw an error, so the order failed. The card didn’t know that.",
    "A batch now beats a perfect batch after settlement.",
  ],
  suggestions: ["warehouse saved", "warehouse run push-surge-orphans", "warehouse run multi-charge-carts", "reconcile preview", "reconcile status"],
  view: {
    name: "push-surge-orphans",
    description: "Captured charges with no paid order since 20:00, by client",
    columns: ["client", "orphaned_charges", "share_in_first_minute"],
    rows: [
      ["ios 7.3.0", 0.57, "91%"],
      ["android 7.2.4", 0.29, "89%"],
      ["web 2026.10.09-2", 0.14, "62%"],
    ],
  },
  solution: refundSteps(
    "push-surge-orphans",
    "Nine in ten orphaned charges landed in the first minute after the push, from app builds that never retry checkout on their own.",
    "20:30",
  ),
  lostCheckoutsPerPoint: 150,
  externals: [
    gateway(
      "ok",
      ["Status page", "All systems operational"],
      ["checkout-api timeout", "3000 ms per call; queued calls still get captured"],
      ["Settlement", "Tonight’s batch closes 20:30"],
    ),
  ],
  postmortem: {
    question: "Why were app customers charged for orders that failed?",
    options: [
      "The push opened the app on a cached cart with stale prices",
      "Charges queued in the 20:00 surge were captured after timeout",
      "The app retried every failed checkout without an idempotency key",
      "The warehouse counted each charge once per CDC replay",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The 20:00 surge queued charges past the 3 s timeout, and the gateway captured them anyway.",
      why: "A push to every device at once sent a wall of checkouts at payment-gateway. Calls waited past checkout-api’s 3 s timeout, so checkout failed the order while the gateway, working its queue in order, captured the card. Refunds before the 20:30 settlement go out as voids.",
      tell: "Nine in ten orphaned charges landed in the minute after the push, each with an Idempotency-Key, from app builds that never retry checkout.",
    },
  },
};

const PAYDAY_SALE: RefundRow = {
  slug: "payday-sale-cutoff",
  title: "Payday sale, early settlement",
  severity: "SEV2",
  service: "payments-recon",
  opensAt: [7, 12],
  surge: surge(12 * 60, [
    [90, 330],
    [260, 240],
  ]),
  residualQueueSeconds: 2.2035,
  averageOrderCents: 7650,
  cutoffAt: 13 * 60,
  briefing:
    "The payday sale opened at 07:00. payment-gateway’s acquirer was slow, the queue ran past checkout-api’s 3 s timeout for over a minute, and customers were charged for orders that failed. Today is a bank holiday in two markets, so settlement runs early, at 07:25.",
  roleBriefing: `${REFUND_BRIEFING} The clock is short today: settlement is at 07:25, not the usual 08:00.`,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — payments-recon: captured charges with no paid order above threshold since 07:00. Data on-call paged." },
    { at: 15, from: MENTOR, text: "Short deadline today. Find the orphaned charges, see how many a batch would cover, and don’t polish it." },
    { at: 45, from: "Grace Liu · Finance", text: "Heads-up: bank holiday in IE and the UK, so the acquirer settles at 07:25 today instead of 08:00. Voids before, refunds after." },
    { at: 100, from: "Maya Okonkwo · Support", text: "Payday customers are angry. Some have two charges and one order, some one charge and none." },
    { at: 180, from: "Priya Shah · Payments", text: "The acquirer says latency is recovering. I’d rather wait until it’s fully clean so we only run one batch." },
    { at: 330, from: MENTOR, text: "One batch now and a small one later is fine; refunds are keyed by charge id." },
    { at: 600, from: "Grace Liu · Finance", text: "Three minutes to settlement." },
  ],
  hints: [
    "Settlement is earlier than usual today. Check the clock against it.",
    "The orphaned charges are the ones with no paid order behind them.",
    "Waiting for the gateway to be perfectly clean costs more than a second, smaller batch.",
  ],
  suggestions: ["warehouse saved", "warehouse run payday-orphans-by-scheme", "warehouse run orphaned-captures", "reconcile preview"],
  view: {
    name: "payday-orphans-by-scheme",
    description: "Captured charges with no paid order since 07:00, by card scheme",
    columns: ["card_scheme", "orphaned_charges", "typical_amount"],
    rows: [
      ["visa", 0.53, "$40-$120"],
      ["mastercard", 0.35, "$40-$120"],
      ["amex", 0.12, "$90-$200"],
    ],
  },
  solution: refundSteps("payday-orphans-by-scheme", "Thousands of charges across every scheme with no paid order, all from the minutes the acquirer was slow.", "07:25"),
  lostCheckoutsPerPoint: 150,
  externals: [
    gateway(
      "degraded",
      ["Status page", "Acquirer latency in eu-west since 06:58; recovering"],
      ["checkout-api timeout", "3000 ms per call; queued calls still get captured"],
      ["Settlement", "Bank holiday: today’s batch closes 07:25"],
    ),
  ],
  postmortem: {
    question: "Why did payday customers end up with charges and no order?",
    options: [
      "The bank holiday moved settlement and double-posted charges",
      "Charges that waited past the 3 s timeout were still captured",
      "Payday traffic made checkout-api run out of database connections",
      "The acquirer declined orders but kept the authorizations open",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Charges waited past checkout-api’s 3 s timeout in the gateway queue and still captured.",
      why: "checkout-api fails an order when the gateway takes longer than 3 s, but the gateway keeps the call in its queue and captures the card. With settlement moved to 07:25 for the bank holiday, refunds had to be queued within minutes to go out as voids instead of 5–10 day refunds.",
      tell: "Orphaned charges sat in the minutes the queue ran past 3 s, each with an Idempotency-Key, and Finance had moved settlement to 07:25.",
    },
  },
};

const POSTCODE_RETRAIN: RollbackRow = {
  slug: "postcode-feature-retrain",
  title: "Declined by postcode",
  severity: "SEV2",
  service: "fraud-scorer",
  opensAt: [11, 25],
  scorer: {
    versions: [
      { version: "v19", deployedAt: -30 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.93 },
      { version: "v20", deployedAt: -8 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.95 },
      { version: "v21", deployedAt: -15 * 60, note: "weekly retrain + shipping_postcode_risk (RISK-433)", falseDeclineShare: 0.11, catchShare: 0.97 },
    ],
    active: "v21",
    features: [
      { name: "account_age_days", pipeline: "features_account_daily", lastSuccessAt: -7 * HOUR, refresh: null },
      { name: "shipping_postcode_risk", pipeline: "features_geo_weekly", lastSuccessAt: -20 * HOUR, refresh: null },
      { name: "card_velocity_10m", pipeline: "features_card_stream", lastSuccessAt: -3 * 60, refresh: null },
    ],
    fraudAttemptsPerSecond: 18,
  },
  briefing:
    "Since 11:10 customers in whole neighbourhoods are being told their card was declined. Their banks approved nothing and declined nothing. The weekly fraud-scorer retrain promoted itself at 11:10. Find out who is declined and why, and get them paying again.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "When declines jump, first look at what changed in the scorer and when. Then look at who is being declined." },
    { at: 55, from: "Maya Okonkwo · Support", text: "It’s whole areas. A customer on a new housing estate says all her neighbours are declined too." },
    { at: 100, from: "Dev Raman · ML platform", text: "fraud-scorer v21 auto-promoted at 11:10. New input this week: shipping_postcode_risk, from RISK-433." },
    { at: 170, from: "Rina Nakamura · Risk", text: "Card testers are steady at about 18 attempts a second. Please don’t switch the scorer off to fix this." },
    { at: 280, from: "Grace Liu · Finance", text: "We’re losing about one checkout in nine. What’s the plan?" },
  ],
  hints: [
    "Declines started at one exact minute. Find what changed then.",
    "Look at who is declined. A real fraud wave wouldn’t follow postcodes.",
    "Approving everyone would wave the card testers through too.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "models features fraud-scorer", "warehouse run declines-by-postcode"],
  view: {
    name: "declines-by-postcode",
    description: "Checkouts fraud-scorer declined in the last 15 min, by when the shipping postcode first appeared",
    columns: ["postcode_first_seen", "declined", "chargebacks_90d"],
    rows: [
      ["under 2 years ago", 0.66, "0"],
      ["2-10 years ago", 0.21, "1"],
      ["over 10 years ago", 0.13, "2"],
    ],
  },
  topReason: { v21: "shipping_postcode_risk > 0.7", v20: "card_velocity_10m > 12", v19: "card_velocity_10m > 12" },
  solution: [
    { command: "models show fraud-scorer", why: "v21 went live at 11:10 and declines 11% of customers; v20 declined 0.4% while it served." },
    { command: "warehouse run declines-by-postcode", why: "Two thirds of declines ship to postcodes under two years old with no chargebacks; v21’s top reason is its new postcode feature." },
    { command: "models rollback fraud-scorer", why: "Serves v20 again. Threshold and mode stay as they were." },
    { command: "models list", why: "Customers declined back near 0.4%." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "What made fraud-scorer decline whole postcodes?",
    options: [
      "v21’s new postcode feature declined good customers",
      "A card-testing ring shipped to addresses on new housing estates",
      "Risk lowered the decline threshold to 0.6 at 11:10",
      "The postcode feature DAG failed and served every value as 0",
    ],
    answerIndex: 0,
    explanation: {
      cause: "The weekly retrain promoted v21, which leaned on shipping_postcode_risk and declined 11%.",
      why: "shipping_postcode_risk scores postcodes by their fraud history. New estates have little history, so v21 scored their residents as risky and declined them. The holdout set had few such postcodes, so the promotion gate passed it. Rolling back to v20 restored the old behaviour.",
      tell: "Declines jumped at v21’s 11:10 promotion, threshold and features were unchanged, and the declined shipped to new postcodes with no chargebacks.",
    },
  },
};

const SHADOW_PROMOTED: RollbackRow = {
  slug: "shadow-model-promoted",
  title: "The shadow model went live",
  severity: "SEV2",
  service: "fraud-scorer",
  opensAt: [15, 40],
  scorer: {
    versions: [
      { version: "v7", deployedAt: -48 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.93 },
      { version: "v8", deployedAt: -20 * DAY, note: "monthly retrain", falseDeclineShare: 0.004, catchShare: 0.94 },
      { version: "v9-shadow", deployedAt: -9 * 60, note: "shadow candidate: scores logged, never used for decisions", falseDeclineShare: 0.19, catchShare: 0.99 },
    ],
    active: "v9-shadow",
    features: [
      { name: "customer_tenure_days", pipeline: "features_customer_daily", lastSuccessAt: -9 * HOUR, refresh: null },
      { name: "device_fingerprint_reuse_7d", pipeline: "features_device_daily", lastSuccessAt: -8 * HOUR, refresh: null },
      { name: "card_velocity_1h", pipeline: "features_card_stream", lastSuccessAt: -4 * 60, refresh: null },
    ],
    fraudAttemptsPerSecond: 22,
  },
  briefing:
    "For a week fraud-scorer has run a shadow candidate beside it: it scores every checkout and is only logged. At 15:31 a registry clean-up script pointed serving at the shadow. Since then almost one customer in five is declined. Get the right model back in front of checkout.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "Look at which version is serving and when it started. The version history tells you a lot." },
    { at: 60, from: "Dev Raman · ML platform", text: "Ugh. My clean-up job for stale registry aliases ran at 15:31. It may have moved the serving alias. Checking." },
    { at: 120, from: "Maya Okonkwo · Support", text: "About every fifth customer on chat says their card was declined." },
    { at: 190, from: "Rina Nakamura · Risk", text: "Could we just raise the threshold to 0.95 for now? Fewer declines without switching anything off." },
    { at: 260, from: "Dev Raman · ML platform", text: "Confirmed: the job pointed serving at v9-shadow. That candidate was never meant to make decisions." },
  ],
  hints: [
    "The version serving now went live a few minutes before the page.",
    "A candidate built only to log scores was never tuned to decide anything.",
    "Loosening the threshold on the wrong version only hides part of the damage.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run declines-by-tenure", "models features fraud-scorer"],
  view: {
    name: "declines-by-tenure",
    description: "Checkouts fraud-scorer declined in the last 15 min, by how long the customer has shopped with us",
    columns: ["customer_tenure", "declined", "median_prior_paid_orders"],
    rows: [
      ["over 1 year", 0.58, "14"],
      ["3-12 months", 0.27, "4"],
      ["under 3 months", 0.15, "1"],
    ],
  },
  topReason: { "v9-shadow": "device_fingerprint_reuse_7d > 2", v8: "card_velocity_1h > 30", v7: "card_velocity_1h > 30" },
  solution: [
    { command: "models show fraud-scorer", why: "v9-shadow has served since 15:31 and declines 19% of customers; v8 declined 0.4%." },
    { command: "warehouse run declines-by-tenure", why: "Most declined customers have shopped with us for over a year. These are not fraudsters." },
    { command: "models rollback fraud-scorer", why: "Serves v8 again, the last version promoted on purpose." },
    { command: "models list", why: "Declines back near 0.4%." },
  ],
  lostCheckoutsPerPoint: 250,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "Why did one customer in five get declined?",
    options: [
      "A clean-up job made the shadow candidate serve",
      "Risk tightened the decline threshold during the afternoon peak",
      "A card-testing wave pushed real fraud scores above the threshold",
      "The shadow model’s features went stale and defaulted to zero",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A registry clean-up job pointed serving at v9-shadow, a candidate meant only for logging.",
      why: "A shadow model scores real traffic but its scores are never used, so nobody tunes its decisions. Once it served, one customer in five met the 0.85 threshold. Rolling back to v8 put the tuned model back; raising the threshold on v9-shadow would still have declined about one customer in twelve.",
      tell: "Serving moved to v9-shadow at 15:31, minutes before declines jumped; threshold and features were unchanged and the declined were long-standing customers.",
    },
  },
};

const UNCALIBRATED: RollbackRow = {
  slug: "uncalibrated-scores",
  title: "Scores without calibration",
  severity: "SEV2",
  service: "fraud-scorer",
  opensAt: [10, 2],
  gatewayChargesPerSecond: 150,
  scorer: {
    versions: [
      { version: "v29", deployedAt: -35 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.97 },
      { version: "v30", deployedAt: -14 * DAY, note: "weekly retrain", falseDeclineShare: 0.0045, catchShare: 0.98 },
      { version: "v31", deployedAt: -25 * 60, note: "weekly retrain; export skipped calibration (MLP-208)", falseDeclineShare: 0.09, catchShare: 0.99 },
    ],
    active: "v31",
    features: [
      { name: "bin_attempts_5m", pipeline: "features_bin_stream", lastSuccessAt: -2 * 60, refresh: null },
      { name: "customer_tenure_days", pipeline: "features_customer_daily", lastSuccessAt: -6 * HOUR, refresh: null },
      { name: "email_domain_age_days", pipeline: "features_email_weekly", lastSuccessAt: -18 * HOUR, refresh: null },
    ],
    fraudAttemptsPerSecond: 36,
  },
  briefing:
    "fraud-scorer v31 went live at 09:37. Since then about one customer in eleven is declined, and the scores in the decision log bunch between 0.85 and 0.95 where most used to sit near 0.1. Nobody touched the threshold. Get good customers paying again.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 25, from: MENTOR, text: "When every score moves at once, usually the model changed, not the customers. Compare the versions." },
    { at: 70, from: "Dev Raman · ML platform", text: "v31’s export pipeline skipped the isotonic calibration step (MLP-208). Raw scores, straight out of the trees." },
    { at: 130, from: "Maya Okonkwo · Support", text: "Declines look random: regulars, new customers, all sorts." },
    { at: 200, from: "Rina Nakamura · Risk", text: "There’s a BIN attack running at about 36 attempts a second. The scorer is the only thing between it and the gateway." },
    { at: 300, from: "Jonah Reyes · Product", text: "Fail open for ten minutes? We’d stop losing customers right away." },
  ],
  hints: [
    "Nothing about the customers changed at 09:37. Something about the scorer did.",
    "An uncalibrated score can’t be read against a threshold tuned on calibrated ones.",
    "The scorer is holding back a live card attack. Keep it deciding.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run score-distribution", "models features fraud-scorer"],
  view: {
    name: "score-distribution",
    description: "Customer checkouts fraud-scorer declined in the last 15 min, by score band",
    columns: ["score_band", "declined", "band_chargeback_rate"],
    rows: [
      ["0.85-0.90", 0.52, "0.1%"],
      ["0.90-0.95", 0.38, "0.2%"],
      ["0.95-1.00", 0.1, "3.4%"],
    ],
  },
  topReason: { v31: "raw score above 0.85 (no calibration layer)", v30: "bin_attempts_5m > 20", v29: "bin_attempts_5m > 20" },
  solution: [
    { command: "models show fraud-scorer", why: "v31 went live at 09:37 and declines 9% of customers; v30 declined 0.45%." },
    { command: "warehouse run score-distribution", why: "Declined scores bunch just above 0.85 with almost no chargebacks: uncalibrated scores, not fraud." },
    { command: "models rollback fraud-scorer", why: "Serves calibrated v30 again, still enforcing against the BIN attack." },
    { command: "models list", why: "Declines back under half a percent." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [gateway("ok", ["Throughput for us", "≈150 charges/s contracted; excess queues FIFO"], ["checkout-api timeout", "3000 ms per call"])],
  postmortem: {
    question: "Why did fraud-scorer v31 decline so many good customers?",
    options: [
      "v31 shipped raw scores without its calibration step",
      "The BIN attack raised every customer’s velocity feature",
      "Risk moved the threshold from 0.85 to 0.55 at 09:37",
      "A stale tenure feature scored every customer as brand new",
    ],
    answerIndex: 0,
    explanation: {
      cause: "v31’s export skipped the calibration step, so raw scores were read against 0.85.",
      why: "The threshold was tuned on calibrated scores, where 0.85 means very likely fraud. v31 served raw scores, which run higher, so ordinary customers crossed 0.85. Rolling back to v30 restored calibrated scores; failing open would have sent the BIN attack straight to a gateway with little headroom.",
      tell: "Declines began at v31’s 09:37 deploy, declined scores bunched just above 0.85 with almost no chargebacks, and threshold and features were unchanged.",
    },
  },
};

const LOYALTY_GRANT: StaleRow = {
  slug: "loyalty-feature-grant",
  title: "Loyalty members look brand new",
  severity: "SEV2",
  service: "features-platform",
  opensAt: [8, 15],
  scorer: {
    versions: [
      { version: "v14", deployedAt: -16 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.97 },
      { version: "v15", deployedAt: -6 * DAY, note: "weekly retrain", falseDeclineShare: 0.0045, catchShare: 0.975 },
    ],
    active: "v15",
    features: [
      // Yesterday's run finished loyalty_orders_365d at 01:35, and loyalty_tier_days (which waits for the tier recompute) at 08:20.
      { name: "loyalty_orders_365d", pipeline: "features_loyalty_daily", lastSuccessAt: -(30 * HOUR + 40 * 60), refresh: null },
      { name: "loyalty_tier_days", pipeline: "features_loyalty_daily", lastSuccessAt: -26 * HOUR + 5 * 60, refresh: null },
      { name: "device_accounts_30d", pipeline: "features_device_daily", lastSuccessAt: -6 * HOUR, refresh: null },
      { name: "card_attempts_15m", pipeline: "features_card_stream", lastSuccessAt: -4 * 60, refresh: null },
    ],
    fraudAttemptsPerSecond: 20,
    staleFeatureDeclineShare: 0.1,
  },
  failure: {
    dag: "features_loyalty_daily",
    feature: "loyalty_orders_365d",
    schedule: "01:30",
    failedAt: 1 * HOUR + 41 * 60 + 12 - (8 * HOUR + 15 * 60),
    sql: [
      "insert into features.loyalty_daily (customer_id, loyalty_orders_365d, as_of)",
      "select l.customer_id, count(distinct l.order_id), current_date",
      "from loyalty.ledger l",
      "where l.event = 'order_paid'",
      "  and l.created_at >= current_date - 365",
      "group by l.customer_id",
    ].join("\n"),
    error: ["psycopg2.errors.InsufficientPrivilege: permission denied for table ledger"],
  },
  briefing:
    "Since early this morning fraud-scorer has been declining our loyalty members, people with dozens of orders, while first-time shoppers check out fine. No model has shipped since Sunday. Find out why our most loyal customers look like strangers.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "When good customers look new, check how fresh the scorer’s inputs are before you touch the model." },
    { at: 60, from: "Maya Okonkwo · Support", text: "Gold-tier members are being declined. One has 140 orders with us." },
    { at: 120, from: "Kofi Mensah · Security", text: "FYI we rotated the airflow_features database role at 23:00 last night (SEC-1180). The DBA re-granted the read it missed on loyalty.ledger at 07:52." },
    { at: 200, from: "Dev Raman · ML platform", text: "Want me to roll fraud-scorer back to v14? One command." },
    { at: 290, from: MENTOR, text: "Rolling back swaps the model, not its inputs. Every version reads the same features." },
    { at: 360, from: "Elena Ruiz · VP Engineering", text: "Declines just went up again. What’s happening?" },
  ],
  hints: [
    "Returning customers look brand new to the scorer. Check what it is being fed.",
    "An input older than the freshness guard is served as a default.",
    "Whatever broke last night’s job has since been put right. The job just hasn’t run again.",
  ],
  suggestions: ["models show fraud-scorer", "models features fraud-scorer", "pipelines list", "warehouse run declined-loyalty-members"],
  view: {
    name: "declined-loyalty-members",
    description: "Customers fraud-scorer declined in the last 15 min, with the loyalty orders it scored them on",
    columns: ["loyalty_tier", "declined", "orders_365d_scored", "orders_365d_actual"],
    rows: [
      ["gold", 0.41, "38"],
      ["silver", 0.37, "11"],
      ["none", 0.22, "0"],
    ],
  },
  solution: [
    { command: "models features fraud-scorer", why: "loyalty_orders_365d last refreshed 30 h ago, past the 26 h guard: every member is scored as if they had never ordered." },
    { command: "pipelines logs features_loyalty_daily", why: "Last night’s run failed: permission denied for table ledger, after the role rotation. The grant came back at 07:52." },
    { command: "pipelines run features_loyalty_daily", why: "Runs the DAG now instead of at 01:30 tomorrow; its features refresh in about a minute." },
    { command: "models features fraud-scorer", why: "Both loyalty features go from refreshing to fresh; declines fall back to about half a percent." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "Why were loyalty members declined as if they were new?",
    options: [
      "Their loyalty feature went stale after a failed DAG run",
      "fraud-scorer v15 was trained without any loyalty members",
      "The card-testing bots signed up as fake loyalty members",
      "Risk lowered the decline threshold for gold-tier members",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A role rotation broke features_loyalty_daily, so loyalty_orders_365d went stale.",
      why: "Last night’s run failed with permission denied for table ledger after the airflow_features role was rotated. Past the 26 h guard the scorer serves 0, the value a brand-new customer has, so every member looked new to every model version. The grant was back at 07:52; a manual run rebuilt the features in a minute.",
      tell: "loyalty_orders_365d was 30 h old and STALE, the DAG log ended in permission denied for table ledger, and declined members were scored on 0 orders.",
    },
  },
};

const ADDRESS_DISK_FULL: StaleRow = {
  slug: "address-feature-disk-full",
  title: "Every address is a new address",
  severity: "SEV2",
  service: "features-platform",
  opensAt: [9, 30],
  scorer: {
    versions: [
      { version: "v22", deployedAt: -21 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.96 },
      { version: "v23", deployedAt: -4 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.97 },
    ],
    active: "v23",
    features: [
      { name: "address_age_days", pipeline: "features_address_daily", lastSuccessAt: -(30 * HOUR + 18 * 60), refresh: null },
      { name: "address_orders_180d", pipeline: "features_address_daily", lastSuccessAt: -26 * HOUR + 4 * 60, refresh: null },
      { name: "ip_distance_km", pipeline: "features_geo_stream", lastSuccessAt: -90, refresh: null },
    ],
    fraudAttemptsPerSecond: 15,
    staleFeatureDeclineShare: 0.09,
  },
  failure: {
    dag: "features_address_daily",
    feature: "address_age_days",
    schedule: "03:00",
    failedAt: 3 * HOUR + 12 * 60 + 44 - (9 * HOUR + 30 * 60),
    sql: [
      "insert into features.address_daily (address_hash, address_age_days, as_of)",
      "select a.address_hash, current_date - min(o.created_at)::date, current_date",
      "from orders.orders o",
      "join orders.addresses a on a.id = o.shipping_address_id",
      "group by a.address_hash",
    ].join("\n"),
    error: ['psycopg2.errors.DiskFull: could not extend file "base/16384/2620934": No space left on device', "HINT:  Check free disk space."],
  },
  briefing:
    "Customers shipping to the address they’ve used for years are being declined as if they had just moved in. The decline monitor paged at 09:30. Nothing shipped overnight. Find out why every address looks brand new.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "Check the scorer’s inputs and how old each one is. A model can only be as fresh as what it reads." },
    { at: 70, from: "Maya Okonkwo · Support", text: "A woman who has shipped to the same farmhouse for nine years was told her payment was declined." },
    { at: 130, from: "Sam Tan · SRE", text: "features-db’s data volume filled up at 03:10 last night. I grew it from 500 GB to 1 TB at 09:05 (OPS-3302). Plenty of room now." },
    { at: 210, from: "Dev Raman · ML platform", text: "v23 is four days old. Should we try v22?" },
    { at: 300, from: MENTOR, text: "Every version reads the same address features. Ask what they are being fed." },
  ],
  hints: [
    "The scorer treats every shipping address as new. Look at its inputs, not its version.",
    "Something that should refresh daily has not refreshed since yesterday.",
    "What broke the overnight job was fixed this morning. Nothing has rerun it.",
  ],
  suggestions: ["models features fraud-scorer", "pipelines list", "warehouse run declines-by-address-age", "models show fraud-scorer"],
  view: {
    name: "declines-by-address-age",
    description: "Customers fraud-scorer declined in the last 15 min, with the address age it scored them on",
    columns: ["address_first_used", "declined", "address_age_scored", "address_age_actual"],
    rows: [
      ["5+ years ago", 0.48, "2140"],
      ["1-5 years ago", 0.36, "870"],
      ["this month", 0.16, "9"],
    ],
  },
  solution: [
    { command: "models features fraud-scorer", why: "address_age_days last refreshed 30 h ago and is STALE: served as 0, a brand-new address. address_orders_180d is close behind." },
    { command: "pipelines logs features_address_daily", why: "The 03:00 run died with No space left on device. SRE grew the volume at 09:05." },
    { command: "pipelines run features_address_daily", why: "Reruns the DAG on the bigger volume; both address features refresh in about a minute." },
    { command: "models features fraud-scorer", why: "Both address features go fresh; declines fall back to about 0.4%." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "Why did long-used shipping addresses look brand new?",
    options: [
      "A full disk failed the address DAG; its feature went stale",
      "fraud-scorer v23 dropped address history from its inputs",
      "A postcode database update renamed thousands of streets",
      "Card testers reused real customers’ shipping addresses overnight",
    ],
    answerIndex: 0,
    explanation: {
      cause: "features-db ran out of disk, the address DAG failed, and address_age_days went stale.",
      why: "The 03:00 run failed with No space left on device. Past the 26 h guard the scorer serves 0 for address_age_days, the age of an address used for the first time, so every customer looked like they had just moved. SRE grew the volume at 09:05; a manual run rebuilt both address features in a minute.",
      tell: "address_age_days was STALE at 30 h, the DAG log ended in No space left on device, and declined customers were scored on 0-day-old addresses.",
    },
  },
};

const BASKET_TIMEOUT: StaleRow = {
  slug: "basket-feature-statement-timeout",
  title: "Regular baskets look suspicious",
  severity: "SEV2",
  service: "features-platform",
  opensAt: [7, 45],
  scorer: {
    versions: [
      { version: "v40", deployedAt: -12 * DAY, note: "weekly retrain", falseDeclineShare: 0.005, catchShare: 0.95 },
      { version: "v41", deployedAt: -3 * DAY, note: "weekly retrain", falseDeclineShare: 0.0045, catchShare: 0.96 },
    ],
    active: "v41",
    features: [
      { name: "repeat_basket_items_60d", pipeline: "features_basket_daily", lastSuccessAt: -(29 * HOUR + 12 * 60), refresh: null },
      { name: "basket_value_avg_60d", pipeline: "features_basket_daily", lastSuccessAt: -(25 * HOUR), refresh: null },
      { name: "checkout_attempts_10m", pipeline: "features_session_stream", lastSuccessAt: -60, refresh: null },
    ],
    fraudAttemptsPerSecond: 12,
    staleFeatureDeclineShare: 0.12,
  },
  failure: {
    dag: "features_basket_daily",
    feature: "repeat_basket_items_60d",
    schedule: "02:30",
    failedAt: 3 * HOUR + 31 * 60 + 5 - (7 * HOUR + 45 * 60),
    sql: [
      "insert into features.basket_daily (customer_id, repeat_basket_items_60d, as_of)",
      "select oi.customer_id, count(*) filter (where oi.times_bought > 1), current_date",
      "from orders.order_items oi",
      "where oi.created_at >= current_date - 60",
      "group by oi.customer_id",
    ].join("\n"),
    error: ["psycopg2.errors.QueryCanceled: canceling statement due to statement timeout"],
  },
  briefing:
    "Customers who buy the same coffee, nappies and cat food every week are being declined. Brand-new customers with odd baskets go straight through. The decline monitor paged at 07:45. Find out why our most predictable customers look risky.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "Predictable customers looking risky means the scorer can’t see their history. Find out which input is missing." },
    { at: 75, from: "Maya Okonkwo · Support", text: "Subscription-style regulars are being declined. One orders the same cat food every Monday." },
    { at: 140, from: "Ingrid Solberg · Data eng", text: "orders-db ran its monthly REINDEX of order_items from 02:00 to 06:20 (DBA-779). Anything scanning order_items overnight crawled. It’s back to normal now." },
    { at: 220, from: "Jonah Reyes · Product", text: "Could we roll the model back? v41 is new this week." },
    { at: 310, from: MENTOR, text: "A model can’t remember what its features never told it. Check the job that builds them." },
  ],
  hints: [
    "Regulars look like strangers. Check how fresh the scorer’s inputs are.",
    "A job that normally takes minutes ran out of time overnight.",
    "Whatever slowed it down finished hours ago.",
  ],
  suggestions: ["models show fraud-scorer", "models features fraud-scorer", "pipelines list", "warehouse run declines-by-repeat-basket"],
  view: {
    name: "declines-by-repeat-basket",
    description: "Customers fraud-scorer declined in the last 15 min, with the repeat-basket count it scored them on",
    columns: ["repeat_buyer_segment", "declined", "repeat_items_scored", "repeat_items_actual"],
    rows: [
      ["weekly", 0.55, "23"],
      ["monthly", 0.31, "6"],
      ["first order", 0.14, "0"],
    ],
  },
  solution: [
    { command: "models features fraud-scorer", why: "repeat_basket_items_60d last refreshed 29 h ago: STALE, served as 0, as for a first order." },
    { command: "pipelines logs features_basket_daily", why: "All three overnight attempts were cancelled on statement timeout while orders-db reindexed order_items." },
    { command: "pipelines run features_basket_daily", why: "orders-db is quiet again; the run rebuilds the basket features in about a minute." },
    { command: "models features fraud-scorer", why: "The basket features go fresh; declines fall back to about half a percent." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "Why did weekly regulars get declined this morning?",
    options: [
      "The basket DAG timed out overnight and its feature went stale",
      "fraud-scorer v41 learned to distrust customers who reorder often",
      "Card testers copied regular customers’ baskets to look genuine",
      "The order_items reindex deleted the last 60 days of order lines",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A reindex slowed the basket DAG past its statement timeout; the feature went stale.",
      why: "orders-db’s monthly REINDEX of order_items made last night’s feature query crawl until Postgres cancelled it on statement timeout, three times. Past the 26 h guard the scorer served repeat_basket_items_60d as 0, so regulars looked like first orders to every model. The reindex ended at 06:20; a manual run fixed it in a minute.",
      tell: "repeat_basket_items_60d was 29 h old and STALE, all three attempts ended in canceling statement due to statement timeout, and regulars were scored on 0 repeat items.",
    },
  },
};

const EXPERIMENT_LEFT: ThresholdRow = {
  slug: "experiment-threshold-left",
  title: "The experiment that never ended",
  severity: "SEV2",
  service: "risk-experiments",
  opensAt: [14, 20],
  scorer: {
    versions: [
      { version: "v6", deployedAt: -25 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.95 },
      { version: "v7", deployedAt: -10 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.96 },
    ],
    active: "v7",
    threshold: 0.4,
    tunedThreshold: 0.8,
    features: [
      { name: "promo_redemptions_7d", pipeline: "features_promo_daily", lastSuccessAt: -6 * HOUR, refresh: null },
      { name: "account_age_days", pipeline: "features_account_daily", lastSuccessAt: -5 * HOUR, refresh: null },
      { name: "bin_attempts_10m", pipeline: "features_bin_stream", lastSuccessAt: -3 * 60, refresh: null },
    ],
    fraudAttemptsPerSecond: 10,
  },
  briefing:
    "At 14:03 Risk’s experiment runner started a 15-minute test that tightens fraud-scorer, and it was meant to restore the old setting when it finished. Declines have run at about one customer in ten since. No model shipped today. Put fraud-scorer back the way it was tuned.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "The scorer has a version, a mode and a threshold. Check all three against how it was tuned." },
    { at: 70, from: "Rina Nakamura · Risk", text: "risk-exp-117 should have run 14:03–14:18 and then restored the threshold. The runner pod was OOM-killed at 14:09 and never restored anything." },
    { at: 130, from: "Maya Okonkwo · Support", text: "Declines everywhere. Customers are trying three cards and giving up." },
    { at: 200, from: "Dev Raman · ML platform", text: "Rolling back to v6 is easy if you think the model is the issue." },
    { at: 280, from: MENTOR, text: "Before you roll anything back, ask what the experiment actually changed." },
  ],
  hints: [
    "No new version went out today. Look at how the scorer decides, not which version decides.",
    "The experiment was supposed to put a setting back when it finished. It never finished.",
    "The scorer was tuned to one number. Is that the number it is using?",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run declines-by-score-band", "models features fraud-scorer"],
  view: {
    name: "declines-by-score-band",
    description: "Customers fraud-scorer declined in the last 15 min, by score band",
    columns: ["score_band", "customers_declined", "median_prior_paid_orders"],
    aboveTuned: "2",
    belowTuned: "9",
  },
  solution: [
    { command: "models show fraud-scorer", why: "Threshold 0.4, tuned to 0.8: about one customer in ten now scores above it." },
    { command: "warehouse run declines-by-score-band", why: "Almost every declined customer scored between 0.40 and 0.80, with a median of 9 prior paid orders." },
    { command: "models threshold fraud-scorer 0.8", why: "Back where it was tuned. Version and mode stay as they are." },
    { command: "models list", why: "Declines back near 0.4%." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [SCORER_GATEWAY],
  postmortem: {
    question: "Why did declines jump at 14:03?",
    options: [
      "An experiment lowered the threshold and never restored it",
      "fraud-scorer v7 drifted after ten days in production",
      "The experiment runner’s crash took the scorer’s features down",
      "A card-testing wave raised everyone’s velocity scores at 14:03",
    ],
    answerIndex: 0,
    explanation: {
      cause: "risk-exp-117 lowered the threshold from 0.80 to 0.40 and crashed before restoring it.",
      why: "Scores at or above the threshold are declined. At 0.40 about one good customer in ten crossed it, against 1 in 250 at the tuned 0.80. The runner was OOM-killed at 14:09, so its restore step never ran. Setting the threshold back to 0.80 fixed it; rolling back the model would not have.",
      tell: "The threshold read 0.40 against a tuned 0.80, declines began at 14:03, no version or feature changed, and the declined scored between 0.40 and 0.80.",
    },
  },
};

const THRESHOLD_TYPO: ThresholdRow = {
  slug: "threshold-transposed-digits",
  title: "Two digits the wrong way round",
  severity: "SEV2",
  service: "fraud-scorer",
  opensAt: [17, 0],
  gatewayChargesPerSecond: 150,
  scorer: {
    versions: [
      { version: "v3", deployedAt: -40 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.95 },
      { version: "v4", deployedAt: -12 * DAY, note: "monthly retrain", falseDeclineShare: 0.004, catchShare: 0.97 },
    ],
    active: "v4",
    threshold: 0.38,
    tunedThreshold: 0.83,
    features: [
      { name: "customer_orders_180d", pipeline: "features_customer_daily", lastSuccessAt: -10 * HOUR, refresh: null },
      { name: "card_country_mismatch_30d", pipeline: "features_card_daily", lastSuccessAt: -9 * HOUR, refresh: null },
      { name: "bin_declines_15m", pipeline: "features_bin_stream", lastSuccessAt: -2 * 60, refresh: null },
    ],
    fraudAttemptsPerSecond: 34,
  },
  briefing:
    "Since 16:48 about one checkout in seven has been declined. Risk re-applied fraud-scorer’s threshold through the config console a few minutes before, after a console upgrade made its history look empty. No model shipped. Get good customers paying again without letting the card testers through.",
  roleBriefing: SCORER_BRIEFING,
  comms: [
    { at: 0, from: "PagerDuty", text: PAGE_DECLINES("SEV2") },
    { at: 20, from: MENTOR, text: "Compare the threshold the scorer is using with the one it was tuned to. Then think about what each fix would let through." },
    { at: 60, from: "Omar Haddad · Risk", text: "I re-applied last week’s threshold at 16:48 because the config history looked empty after the console upgrade. It should read 0.83." },
    { at: 120, from: "Maya Okonkwo · Support", text: "Declines on about one checkout in seven. It started just before five." },
    { at: 190, from: "Jonah Reyes · Product", text: "Can we turn fraud checks off until Risk sorts it out? Every decline is a lost order." },
    { at: 240, from: "Sam Tan · SRE", text: "Careful: payment-gateway caps us at 150 charges a second, and the card testers send 34 attempts a second on their own." },
  ],
  hints: [
    "A person changed a number at 16:48. Check what it reads now.",
    "Tuned to one value, serving at another: look closely at the digits.",
    "Switching the scorer off sends every card tester to a gateway with almost no headroom.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run declines-since-1648", "models features fraud-scorer"],
  view: {
    name: "declines-since-1648",
    description: "Customers fraud-scorer declined in the last 15 min, by score band, with how many ever charged back",
    columns: ["score_band", "customers_declined", "ever_charged_back"],
    aboveTuned: "4.1%",
    belowTuned: "0.3%",
  },
  solution: [
    { command: "models show fraud-scorer", why: "Threshold 0.38, tuned to 0.83: the digits are swapped." },
    { command: "warehouse run declines-since-1648", why: "Nearly every declined customer scored between 0.38 and 0.83, and almost none ever charged back." },
    { command: "models threshold fraud-scorer 0.83", why: "Back to the tuned value; the scorer keeps declining the card testers." },
    { command: "models list", why: "Declines back near 0.4%." },
  ],
  lostCheckoutsPerPoint: 250,
  externals: [gateway("ok", ["Throughput for us", "≈150 charges/s contracted; excess queues FIFO"], ["checkout-api timeout", "3000 ms per call; queued calls still get captured"])],
  postmortem: {
    question: "What caused one checkout in seven to be declined?",
    options: [
      "The threshold was typed as 0.38 instead of 0.83",
      "The console upgrade wiped fraud-scorer’s tuned model weights",
      "fraud-scorer v4 began declining customers on new devices",
      "Card testers pushed the gateway into declining real customers",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A threshold re-applied at 16:48 was typed as 0.38 instead of the tuned 0.83.",
      why: "Scores at or above the threshold are declined, so 0.38 declined every customer scoring in between: about one in seven. Setting it back to 0.83 fixed it at once. Failing open would have approved the card testers too, 34 attempts a second on a gateway with room for about 30 more, and timed out real checkouts.",
      tell: "The threshold read 0.38 against a tuned 0.83, declines began at 16:48 when it was re-applied, and the declined scored between the two with almost no chargebacks.",
    },
  },
};

const MAINTENANCE_FAIL_OPEN: FailOpenRow = {
  slug: "fail-open-after-maintenance",
  title: "Left open after maintenance",
  severity: "SEV1",
  service: "fraud-scorer",
  opensAt: [7, 5],
  gatewayChargesPerSecond: 150,
  scorer: {
    versions: [
      { version: "v17", deployedAt: -19 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.98 },
      { version: "v18", deployedAt: -5 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.985 },
    ],
    active: "v18",
    mode: "fail-open",
    features: [
      { name: "bin_auth_rate_1h", pipeline: "features_bin_stream", lastSuccessAt: -2 * 60, refresh: null },
      { name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -5 * HOUR, refresh: null },
      { name: "email_age_days", pipeline: "features_email_daily", lastSuccessAt: -7 * HOUR, refresh: null },
    ],
    fraudAttemptsPerSecond: 45,
  },
  briefing:
    "Last night’s feature-store maintenance put fraud-scorer in fail-open at 02:00 so checkout wouldn’t stall, and nobody switched it back. At 07:04 a card-testing ring found the open door. payment-gateway is now queueing past checkout-api’s timeout, and real customers are failing at checkout.",
  roleBriefing:
    "Data on-call: models (fraud-scorer, in front of the payment gateway), pipelines and the warehouse. Whatever the scorer approves goes on to the gateway, card testers included.",
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout customers lost above 5% for 2m (payment-gateway timeouts). Data on-call paged." },
    { at: 20, from: MENTOR, text: "Customers failing and a card ring at the same moment. Check what the scorer is actually doing with its scores." },
    { at: 60, from: "Sam Tan · SRE", text: "payment-gateway’s queue is over 3 s and climbing. We’re sending it about 165 calls a second against a 150 cap." },
    { at: 110, from: "Ingrid Solberg · Data eng", text: "Maintenance ticket DATA-2291 closed at 02:40. Step 6 was “restore scorer mode”. I don’t see it ticked." },
    { at: 180, from: "Dev Raman · ML platform", text: "Should I roll fraud-scorer back to v17? v18 is only five days old." },
    { at: 260, from: "Rina Nakamura · Risk", text: "The ring is about 45 attempts a second, $1 auths on a handful of BINs." },
  ],
  hints: [
    "The scorer is approving checkouts it would normally decline. Find out why.",
    "A maintenance step from last night was never undone.",
    "No version decides anything while the scorer isn’t deciding.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run card-testing-0704", "models features fraud-scorer"],
  view: {
    name: "card-testing-0704",
    description: "Card-testing authorizations fraud-scorer approved in the last 15 min, by card BIN",
    columns: ["card_bin", "approved_auths", "amount_usd"],
    rows: [
      ["455620", 0.44, "1.00"],
      ["537410", 0.35, "1.00"],
      ["401795", 0.21, "1.00"],
    ],
  },
  solution: [
    { command: "models show fraud-scorer", why: "Mode fail-open: every checkout approved, scores logged and ignored. v18 would catch 98.5% of this ring." },
    { command: "warehouse run card-testing-0704", why: "About 45 $1 auths a second on three BINs, all approved and queueing at the gateway beside real customers." },
    { command: "models mode fraud-scorer enforce", why: "The scorer declines the ring again, and the gateway queue drains within a minute." },
    { command: "models list", why: "Enforcing, with declines near 0.4%." },
  ],
  lostCheckoutsPerPoint: 400,
  externals: [gateway("degraded", ["Throughput for us", "≈150 charges/s contracted; excess queues FIFO"], ["checkout-api timeout", "3000 ms per call; queued calls still get captured"])],
  postmortem: {
    question: "Why did real customers fail at checkout this morning?",
    options: [
      "fraud-scorer was left in fail-open after maintenance",
      "fraud-scorer v18 stopped recognising card-testing BINs",
      "The feature-store maintenance left every feature stale",
      "payment-gateway cut our contracted charges per second at 07:00",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Maintenance set fraud-scorer to fail-open at 02:00 and nobody restored enforce mode.",
      why: "In fail-open the scorer approves everything, so the ring’s 45 attempts a second went straight to payment-gateway beside real customers. That was more than its 150 a second, the queue ran past checkout-api’s 3 s timeout, and real checkouts failed. Back in enforce mode the ring was declined and the queue drained.",
      tell: "Mode read fail-open since 02:00, the maintenance ticket’s restore step was unticked, every ring auth was approved, and gateway calls ran over the 150/s cap.",
    },
  },
};

const QUIET_FAIL_OPEN: FailOpenRow = {
  slug: "fail-open-quiet-fraud",
  title: "Fraud walking through an open door",
  severity: "SEV3",
  service: "fraud-scorer",
  opensAt: [10, 30],
  gatewayChargesPerSecond: 200,
  fraudCaptureBound: 2500,
  scorer: {
    versions: [
      { version: "v10", deployedAt: -28 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.96 },
      { version: "v11", deployedAt: -7 * DAY, note: "weekly retrain", falseDeclineShare: 0.0045, catchShare: 0.975 },
    ],
    active: "v11",
    mode: "fail-open",
    features: [
      { name: "reshipper_address_flag", pipeline: "features_address_risk_daily", lastSuccessAt: -8 * HOUR, refresh: null },
      { name: "signup_age_hours", pipeline: "features_account_daily", lastSuccessAt: -6 * HOUR, refresh: null },
      { name: "promo_code_reuse_7d", pipeline: "features_promo_daily", lastSuccessAt: -5 * HOUR, refresh: null },
    ],
    fraudAttemptsPerSecond: 28,
  },
  briefing:
    "Chargeback alerts from the card networks are climbing, and Finance has spotted orders shipping to the same few reshippers. Checkout looks perfectly healthy. fraud-scorer was put in fail-open yesterday afternoon during a feature-store incident. Find out how much fraud is getting through, and stop it.",
  roleBriefing:
    "Data on-call: models (fraud-scorer, in front of the payment gateway), pipelines and the warehouse. Whatever the scorer approves is charged; the gateway has room, so nothing errors.",
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV3 triggered — likely-fraud share of captured charges above 5% for 10m. Data on-call paged." },
    { at: 20, from: MENTOR, text: "Healthy checkout and rising fraud usually means the scorer isn’t stopping anything. Look at how it is deciding." },
    { at: 60, from: "Grace Liu · Finance", text: "We’ve shipped 300 orders to two reshipper addresses in Delaware since yesterday evening. Each one comes back as a chargeback with a $15 fee." },
    { at: 120, from: "Ingrid Solberg · Data eng", text: "Yesterday’s feature-store incident (DATA-2287) closed at 18:20. We put the scorer in fail-open at 16:05 while the store was down." },
    { at: 200, from: "Rina Nakamura · Risk", text: "Want me to tighten the threshold to 0.7? That should catch more of them." },
    { at: 300, from: MENTOR, text: "A threshold only matters while the scorer is enforcing it." },
  ],
  hints: [
    "Checkout is healthy. Ask what the scorer does with the scores it computes.",
    "Yesterday’s emergency setting was meant to last an hour.",
    "Tightening anything changes nothing while no decision is enforced.",
  ],
  suggestions: ["models list", "models show fraud-scorer", "warehouse run reshipper-orders", "models features fraud-scorer"],
  view: {
    name: "reshipper-orders",
    description: "Checkouts approved in the last 15 min that fraud-scorer’s logged score marks as likely fraud, by ship-to",
    columns: ["ship_to", "approved_likely_fraud", "median_logged_score"],
    rows: [
      ["reshipper, Wilmington DE", 0.47, "0.97"],
      ["reshipper, New Castle DE", 0.31, "0.96"],
      ["freight forwarder, Miami FL", 0.22, "0.94"],
    ],
  },
  solution: [
    { command: "models show fraud-scorer", why: "Mode fail-open since yesterday 16:05: scores are logged and nothing is declined." },
    { command: "warehouse run reshipper-orders", why: "About 28 likely-fraud checkouts a second approved, scored 0.94 and up, shipping to reshippers." },
    { command: "models mode fraud-scorer enforce", why: "Scores at or above 0.85 are declined again." },
    { command: "models list", why: "Enforcing; fraud approvals down to a trickle." },
  ],
  lostCheckoutsPerPoint: 200,
  externals: [gateway("ok", ["Throughput for us", "≈200 charges/s contracted"], ["Chargebacks", "Network alerts up 4× since yesterday evening"])],
  postmortem: {
    question: "Why did fraud reach the gateway while checkout was healthy?",
    options: [
      "fraud-scorer stayed in fail-open after yesterday’s incident",
      "The threshold was raised so high that nothing scored above it",
      "fraud-scorer v11 never learned what reshipper addresses look like",
      "The feature-store incident left every fraud feature stale",
    ],
    answerIndex: 0,
    explanation: {
      cause: "fraud-scorer was set to fail-open during yesterday’s incident and never set back.",
      why: "Fail-open approves every checkout and only logs the score. The gateway had headroom, so nothing errored and checkout looked healthy while likely fraud was captured at about 28 a second. Back in enforce mode the same model declined it again; tightening the threshold first would have changed nothing.",
      tell: "Mode read fail-open since 16:05 yesterday, approved checkouts scored 0.94 and up and shipped to reshippers, and checkout 5xx stayed at zero.",
    },
  },
};

/** Fourteen guided data incidents: one cause, one fix, and a tempting move that doesn't help. */
export const DATA_TIER1_INCIDENTS: readonly Scenario[] = [
  refundIncident(LUNCH_FLASH),
  refundIncident(GIFT_CARD_PROMO),
  refundIncident(PUSH_SURGE),
  refundIncident(PAYDAY_SALE),
  rollbackIncident(POSTCODE_RETRAIN),
  rollbackIncident(SHADOW_PROMOTED),
  rollbackIncident(UNCALIBRATED),
  staleIncident(LOYALTY_GRANT),
  staleIncident(ADDRESS_DISK_FULL),
  staleIncident(BASKET_TIMEOUT),
  thresholdIncident(EXPERIMENT_LEFT),
  thresholdIncident(THRESHOLD_TYPO),
  failOpenIncident(MAINTENANCE_FAIL_OPEN),
  failOpenIncident(QUIET_FAIL_OPEN),
];
