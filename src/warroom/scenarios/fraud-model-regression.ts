import type { Scenario } from "../scenario.ts";
import { activeVersion } from "../sim/fraud.ts";
import type { ClusterState } from "../sim/model.ts";
import { sqlTable } from "../shell/sql-table.ts";
import { checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { CUSTOMERS_LOST, FRAUD_MODEL, fraudScorer, lastQuarterHour, scorerOf } from "./fraud-scorer.ts";

const SEED = "fraud-model-regression";
const HOUR = 3600;
const DAY = 24 * HOUR;
/** The weekly retrain promoted v13 at 09:08; the page fires at 09:20. */
const OPENS_AT = 9 * HOUR + 20 * 60;
const V13_DEPLOYED_AT = -12 * 60;

/** Why each version declines most of what it declines, from its score explanations. */
const TOP_REASON: Readonly<Record<string, string>> = {
  v13: "device_age_days < 1",
  v12: "card_bin_velocity_1h > 40",
  v11: "card_bin_velocity_1h > 40",
};

function initialState(): ClusterState {
  return checkoutCluster({
    seed: SEED,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({
      fraud: fraudScorer({
        versions: [
          { version: "v11", deployedAt: -23 * DAY, note: "monthly retrain", falseDeclineShare: 0.005, catchShare: 0.91 },
          { version: "v12", deployedAt: -9 * DAY, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.93 },
          { version: "v13", deployedAt: V13_DEPLOYED_AT, note: "weekly retrain + device_age_days (RISK-412)", falseDeclineShare: 0.14, catchShare: 0.97 },
        ],
        active: "v13",
        features: [
          { name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -6 * HOUR - 39 * 60, refresh: null },
          { name: "device_age_days", pipeline: "features_device_daily", lastSuccessAt: -5 * HOUR - 52 * 60, refresh: null },
          { name: "card_bin_velocity_1h", pipeline: "features_card_velocity", lastSuccessAt: -14 * 60, refresh: null },
        ],
        fraudAttemptsPerSecond: 2.4,
      }),
    }),
  });
}

/** Who the scorer declined in the last 15 minutes, by how well we already knew them. */
function declinedCheckouts(state: ClusterState): readonly string[] {
  const window = lastQuarterHour(state);
  const fraud = scorerOf(state);
  if (!window || !fraud) return [];
  const caughtFraud = window.fraudAttempts - window.fraudApproved;
  const rows: [string, number, string][] = [
    ["3+ paid orders", window.declined * 0.62, "1140"],
    ["1-2 paid orders", window.declined * 0.23, "260"],
    ["no paid orders", window.declined * 0.15 + caughtFraud, "0"],
  ];
  const total = rows.reduce((sum, [, declined]) => sum + declined, 0);
  return [
    ...sqlTable(
      ["customer_history", "declined", "pct_of_declines", "median_account_age_days"],
      rows.map(([history, declined, age]) => [history, String(Math.round(declined)), total > 0 ? ((declined / total) * 100).toFixed(1) : "0.0", age]),
    ),
    `Top decline reason in ${fraud.model} ${fraud.active}'s score explanations: ${TOP_REASON[fraud.active] ?? "none"}`,
  ];
}

export const fraudModelRegression: Scenario = {
  id: "fraud-model-regression",
  title: "Good customers declined",
  tier: 2,
  severity: "SEV2",
  service: FRAUD_MODEL,
  briefing:
    "Checkout is up and fast, but customers are being told their payment was declined, and their banks say nothing was. The decline monitor paged at 09:20. Risk says fraud is up this week. Find out who is being declined, and why, before the morning rush.",
  roles: ["data"],
  roleBriefings: {
    data: "Data on-call: models (fraud-scorer, the model in front of the payment gateway), pipelines (the Airflow DAGs that build its features) and the warehouse. A decline is an HTTP 402 before any charge: no 5xx, just a lost customer.",
  },
  opensAtSecondOfDay: OPENS_AT,
  seed: SEED,
  initialState,
  alertMetric: CUSTOMERS_LOST,
  isRootCauseFixed: (state) => {
    const fraud = scorerOf(state);
    const version = fraud && activeVersion(fraud);
    return !!fraud && !!version && fraud.mode === "enforce" && version.falseDeclineShare <= 0.01;
  },
  // Every second of v13 turns away 17 customers, and the version it rolls back to still declines 1 in 250.
  lostCheckoutsPerPoint: 200,
  evidence: [{ tool: "warehouse", name: "declined-checkouts", description: "Checkouts fraud-scorer declined in the last 15 min, by customer history", run: declinedCheckouts }],
  suggestions: { data: ["models list", "models show fraud-scorer", "models features fraud-scorer", "warehouse run declined-checkouts"] },
  externals: [
    {
      id: "payment-gateway",
      status: "ok",
      facts: [
        { key: "Status page", value: "All systems operational" },
        { key: "Declines", value: "Card-network declines normal; the 402s come from fraud-scorer, before any charge" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout customers lost above 5% for 5m (fraud declines, HTTP 402). Data on-call paged." },
    { at: 25, from: "Maya Okonkwo · Support", text: "Regulars are getting “Your payment was declined”. Their banks say nothing was declined. One has ordered from us every week for three years." },
    { at: 60, from: "Rina Nakamura · Risk", text: "Heads-up: card-testing attempts are up about 30% this week and chargebacks with them. The new fraud model shipped to catch exactly that, so please don’t undo our fraud work without a good reason." },
    { at: 110, from: "Dev Raman · ML platform", text: "The weekly retrain auto-promoted fraud-scorer v13 at 09:08. It beat v12 on holdout recall, so the gate let it through." },
    { at: 200, from: "Grace Liu · Finance", text: "Every declined checkout is revenue we never see, and the morning rush starts at 10. What’s the plan?" },
    { at: 320, from: "Elena Ruiz · VP Engineering", text: "Is this fraud or is this us?" },
  ],
  hints: [
    "Compare how many checkouts are being declined with how many fraud attempts there really are.",
    "Something in the scorer changed this morning. Check when the declines started.",
    "A version that scores better on its holdout set can still treat real customers worse.",
  ],
  solution: {
    data: [
      { command: "models show fraud-scorer", why: "v13 went live at 09:08 and declines 14% of customers; v12 declined 0.4% while it served. Fraud is a sliver of checkouts." },
      { command: "warehouse run declined-checkouts", why: "Most declined customers have years of paid orders and no chargebacks, and v13’s top reason is a feature new in v13." },
      { command: "models rollback fraud-scorer", why: "Serves v12 again. The threshold stays where it was tuned." },
      { command: "models list", why: "Customers declined back near 0.4%." },
    ],
  },
  postmortem: {
    question: "What caused the jump in declined checkouts?",
    options: [
      "fraud-scorer v13 declines far more good customers than v12 did",
      "A card-testing wave pushed real fraud through checkout",
      "Risk lowered the decline threshold to stop card testers",
      "A stale feature made returning customers look brand new",
    ],
    answerIndex: 0,
    explanation: {
      cause: "The weekly retrain promoted fraud-scorer v13, which declines about 14% of good customers; v12 declined 0.4%.",
      why: "v13 learned to lean on device_age_days, a feature new in v13, so any customer on a new phone or a cleared browser scored as fraud. Its holdout set rewarded catching more fraud and didn’t weigh the good customers it turned away, so the promotion gate passed it. Rolling back to v12 restores the old trade-off.",
      tell: "Declines jumped at v13’s 09:08 deploy and ran at about 17 a second against 2.4 fraud attempts a second. The threshold sat where it was tuned, every feature was fresh, and the declined customers had years of orders and no chargebacks.",
    },
  },
};
