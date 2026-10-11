import type { Objective, Scenario } from "../scenario.ts";
import { activeVersion, scoredAt } from "../sim/fraud.ts";
import type { ClusterState } from "../sim/model.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, FRAUD_MODEL, fraudScorer, lastQuarterHour, scorerOf } from "./fraud-scorer.ts";

const SEED = "fraud-threshold-fail-open";
const HOUR = 3600;
const DAY = 24 * HOUR;
/** The ring started at 09:15, Risk moved the threshold at 09:40, and the decline monitor pages at 10:05. */
const OPENS_AT = 10 * HOUR + 5 * 60;
const CARD_TESTING_PER_SECOND = 60;
/** payment-gateway's ceiling for this account: room above our ~120 checkouts a second, not for the ring as well. */
const GATEWAY_CHARGES_PER_SECOND = 150;
/** Card-testing charges captured since the page that Payments can still absorb in chargebacks and fees. */
export const FRAUD_CAPTURE_BOUND = 2000;
/** The ring's cards, by issuer BIN, and its share of the attempts. */
const RING_BINS: readonly (readonly [string, number])[] = [
  ["414709", 0.46],
  ["486236", 0.33],
  ["529149", 0.21],
];

function initialState(): ClusterState {
  const state = checkoutCluster({
    seed: SEED,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({
      gateway: { chargesPerSecond: GATEWAY_CHARGES_PER_SECOND },
      fraud: fraudScorer({
        versions: [
          { version: "v11", deployedAt: -30 * DAY, note: "monthly retrain", falseDeclineShare: 0.0045, catchShare: 0.985 },
          { version: "v12", deployedAt: -9 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.99 },
        ],
        active: "v12",
        threshold: 0.35,
        features: [
          { name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -8 * HOUR, refresh: null },
          { name: "device_age_days", pipeline: "features_device_daily", lastSuccessAt: -7 * HOUR - 12 * 60, refresh: null },
          { name: "card_bin_velocity_1h", pipeline: "features_card_velocity", lastSuccessAt: -9 * 60, refresh: null },
        ],
        fraudAttemptsPerSecond: CARD_TESTING_PER_SECOND,
      }),
    }),
  });
  const { commerce } = state;
  // The objective counts the ring's captures from the page on.
  return commerce ? { ...state, commerce: { ...commerce, ledger: { ...commerce.ledger, fraudulentCaptures: 0 } } } : state;
}

function fraudCaptured(state: ClusterState): number {
  return Math.round(state.commerce?.ledger.fraudulentCaptures ?? 0);
}

function objectives(state: ClusterState): readonly Objective[] {
  const captured = fraudCaptured(state);
  return [
    {
      role: "data",
      label: `Card-testing charges captured since the page: ${captured.toLocaleString("en-US")} (keep under ${FRAUD_CAPTURE_BOUND.toLocaleString("en-US")})`,
      isMet: captured < FRAUD_CAPTURE_BOUND,
    },
  ];
}

/** Customers declined in the last 15 minutes by the score that declined them. */
function declinedCheckouts(state: ClusterState): readonly string[] {
  const window = lastQuarterHour(state);
  const fraud = scorerOf(state);
  const version = fraud && activeVersion(fraud);
  if (!window || !fraud || !version) return [];
  const { threshold, tunedThreshold } = fraud;
  const declinedAtTuned = Math.min(window.declined, window.customers * scoredAt(version, tunedThreshold, tunedThreshold).falseDeclineShare);
  const rows = [[`${Math.max(threshold, tunedThreshold).toFixed(2)}-1.00`, String(Math.round(declinedAtTuned)), "1"]];
  if (threshold < tunedThreshold) rows.push([`${threshold.toFixed(2)}-${tunedThreshold.toFixed(2)}`, String(Math.round(window.declined - declinedAtTuned)), "11"]);
  return sqlTable(["score_band", "customers_declined", "median_prior_paid_orders"], rows);
}

/** The ring in the last 15 minutes: $1 authorizations on a few BINs, and how many got through. */
function cardTesting(state: ClusterState): readonly string[] {
  const window = lastQuarterHour(state);
  if (!window) return [];
  return sqlTable(
    ["card_bin", "amount_usd", "attempts", "approved", "distinct_cards"],
    RING_BINS.map(([bin, share]) => [
      bin,
      "1.00",
      String(Math.round(window.fraudAttempts * share)),
      String(Math.round(window.fraudApproved * share)),
      String(Math.round(window.fraudAttempts * share * 0.97)),
    ]),
  );
}

export const fraudThresholdFailOpen: Scenario = {
  id: "fraud-threshold-fail-open",
  title: "The threshold nobody tuned",
  tier: 3,
  severity: "SEV2",
  service: FRAUD_MODEL,
  briefing:
    "A card-testing ring has been firing $1 authorizations at checkout since 09:15. Since about 09:40 one checkout in five is declined, and the declined customers are our regulars. No model shipped today. Get good customers paying again without opening the door to the ring.",
  roles: ["data"],
  roleBriefings: {
    data: "Data on-call: models (fraud-scorer in front of the payment gateway), pipelines and the warehouse. A decline is an HTTP 402 before any charge; whatever the scorer approves goes on to the gateway, card testers included.",
  },
  opensAtSecondOfDay: OPENS_AT,
  seed: SEED,
  initialState,
  alertMetric: CUSTOMERS_LOST,
  isRootCauseFixed: (state) => {
    const fraud = scorerOf(state);
    // Back at, or a little above, where it was tuned; far above it lets the ring through.
    return !!fraud && fraud.mode === "enforce" && fraud.threshold >= fraud.tunedThreshold - 0.05 && fraud.threshold <= fraud.tunedThreshold + 0.1;
  },
  objectives,
  // A fifth of customers declined until the threshold moves, and 1 in 250 after.
  lostCheckoutsPerPoint: 200,
  evidence: [
    { tool: "warehouse", name: "declined-checkouts", description: "Customers fraud-scorer declined in the last 15 min, by score", run: declinedCheckouts },
    { tool: "warehouse", name: "card-testing", description: "Card-testing authorizations in the last 15 min, by card BIN", run: cardTesting },
  ],
  suggestions: {
    data: ["models show fraud-scorer", "warehouse run declined-checkouts", "warehouse run card-testing", "models rollback fraud-scorer", "models mode fraud-scorer fail-open"],
  },
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
    { at: 30, from: "Maya Okonkwo · Support", text: "Declines everywhere since about 09:40. Some customers tried three different cards." },
    { at: 70, from: "Rina Nakamura · Risk", text: "Since 09:15 a card-testing ring has been firing $1 auths at checkout, about 60 a second. Risk tightened fraud-scorer at 09:40 so none of them get through (RISK-519). The ring is still going." },
    { at: 130, from: "Sam Tan · SRE", text: "For the record, payment-gateway caps us at 150 charges a second. We run about 120 at this hour." },
    { at: 200, from: "Jonah Reyes · Product", text: "Can we just switch fraud checks off for an hour? We’re losing a fifth of checkouts and the testers only take $1 each." },
    { at: 330, from: "Elena Ruiz · VP Engineering", text: "Where are we? I’d like good customers paying again and the ring still blocked." },
  ],
  hints: [
    "Nobody shipped a new model today. Look at how the scorer decides, not which version decides.",
    "Someone tightened the scorer this morning for a good reason. Undo the tightening, not the scorer.",
    "Approving everyone would wave the card testers through to a gateway with little headroom.",
  ],
  solution: {
    data: [
      { command: "models show fraud-scorer", why: "Threshold 0.35, tuned to 0.85. A score at or above it is declined, so a fifth of good customers now are." },
      { command: "warehouse run card-testing", why: "The ring is real, about 60 $1 auths a second. Failing open would send every one of them to the gateway." },
      { command: "models threshold fraud-scorer 0.85", why: "Back where it was tuned: 0.4% of customers declined, and the ring still caught." },
      { command: "models list", why: "Customers declined back near 0.4%." },
    ],
  },
  postmortem: {
    question: "Why were one in five good customers declined?",
    options: [
      "fraud-scorer's threshold was lowered from 0.85 to 0.35",
      "The card-testing ring overloaded the scorer's endpoint",
      "fraud-scorer v12 started declining returning customers",
      "The customer feature DAG failed and went stale overnight",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Risk lowered fraud-scorer’s decline threshold from its tuned 0.85 to 0.35 to stop a card-testing ring.",
      why: "A score at or above the threshold is declined. The ring’s scores sit near 1, so 0.85 already caught 99% of it; dropping to 0.35 barely caught more fraud and declined every customer scoring in between, about a fifth of them. Failing open instead would have approved the ring too, about 60 attempts a second on a gateway with room for 30 more, and drowned everyone in timeouts.",
      tell: "The threshold read 0.35 against a tuned 0.85, declines began at 09:40 when Risk moved it, rolling back to v11 changed nothing, every feature was fresh, and nearly every declined customer scored between 0.35 and 0.85.",
    },
  },
};
