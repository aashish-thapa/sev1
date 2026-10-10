import type { Objective, Scenario } from "../scenario.ts";
import { pendingRefunds, visibleOrphans } from "../sim/commerce-actions.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster, type WarmUp } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";

const SEED = "refund-double-charges";
/** The Midnight Drop opened at 00:00:00; the reconciliation monitor pages at 00:10:00. */
const WARM_UP_SECONDS = 600;
/** The launch email lands as the drop opens: forty seconds of demand above what the gateway can take, then the post-launch lull. */
const MIDNIGHT_DROP: WarmUp = {
  seconds: WARM_UP_SECONDS,
  requestsPerSecond: (second) => (second < 40 ? 390 : second < 150 ? 210 : 300),
};
/** The degraded gateway completes exactly what checkout sends it at steady traffic, so its queue neither drains nor grows. */
const GATEWAY_CHARGES_PER_SECOND = 120;
/**
 * What the queue still holds at the page: just past the 2.2 s where calls start overrunning checkout-api's
 * 3 s timeout, so about one charge in a thousand is still captured after checkout-api has given up.
 */
const RESIDUAL_QUEUE_SECONDS = 2.202;
/** Payment-gateway closes tonight's settlement batch at 00:30:00; refunds queued before it go out as voids. */
export const SETTLEMENT_CUTOFF = 20 * 60;

function initialState(): ClusterState {
  const state = checkoutCluster({
    seed: SEED,
    revisions: [{ number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
    revision: 6,
    commerce: checkoutCommerce({ gateway: { chargesPerSecond: GATEWAY_CHARGES_PER_SECOND } }),
    warmUp: MIDNIGHT_DROP,
  });
  const { commerce } = state;
  if (!commerce) return state;
  return { ...state, commerce: { ...commerce, gateway: { ...commerce.gateway, backlog: GATEWAY_CHARGES_PER_SECOND * RESIDUAL_QUEUE_SECONDS } } };
}

/** Share of the orphaned charges the warehouse can see that no refund batch covers yet. */
function unrefundedShare(state: ClusterState): number {
  const { commerce } = state;
  if (!commerce) return 0;
  const visible = visibleOrphans(commerce);
  return visible > 0 ? pendingRefunds(commerce) / visible : 0;
}

function objectives(state: ClusterState): readonly Objective[] {
  const batches = state.commerce?.ledger.refundBatches ?? [];
  return [{ role: "data", label: "Refund batch queued before the 00:30 settlement cut-off", isMet: batches.some((batch) => batch.at < SETTLEMENT_CUTOFF) }];
}

export const refundDoubleCharges: Scenario = {
  id: "refund-double-charges",
  title: "Refund last night’s double charges",
  tier: 1,
  severity: "SEV2",
  service: "payments-recon",
  briefing:
    "The Midnight Drop opened at 00:00. For two minutes payment-gateway queued charges past checkout-api’s 3 s timeout: customers saw an error, many paid again, and the gateway captured the first charge anyway. Checkout is back, but thousands of customers have a charge with no order. Payments Ops needs a refund batch before the 00:30 settlement cut-off.",
  roles: ["data"],
  roleBriefings: {
    data: "Data on-call: warehouse (payments and orders via CDC, ~45 s behind) and reconcile (refund batches for Payments Ops). Nothing is broken that you can fix; what you can do is refund the right charges, in time.",
  },
  opensAtSecondOfDay: WARM_UP_SECONDS,
  seed: SEED,
  initialState,
  alertMetric: { label: "orphaned charges not refunded", rate: unrefundedShare },
  isRootCauseFixed: (state) => unrefundedShare(state) < 0.05,
  objectives,
  // Only the gateway's slow trickle costs checkouts after the page; the storm's losses happened before it.
  lostCheckoutsPerPoint: 150,
  suggestions: { data: ["warehouse saved", "warehouse run revenue-vs-orders", "warehouse run orphaned-captures", "reconcile preview", "reconcile status"] },
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Elevated latency in eu-west since 23:52; recovering" },
        { key: "Throughput for us", value: "≈120 charges/s while degraded; excess queues FIFO" },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
        { key: "Settlement", value: "Tonight’s batch closes 00:30. Refunds before then are voids: no fee, nothing on the statement" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — payments-recon: captured charges with no paid order above threshold since 00:00. Data on-call paged." },
    { at: 30, from: "Maya Okonkwo · Support", text: "Midnight Drop customers say they got “Something went wrong” at checkout, paid again, and now see two charges. Tickets are piling up." },
    { at: 75, from: "Grace Liu · Finance", text: "payment-gateway settles tonight’s captures in the 00:30 batch. Anything we refund before then goes out as a void: no fee, and it drops off the customer’s statement. After that it’s a full refund, 5–10 days." },
    { at: 140, from: "Sam Tan · SRE", text: "Checkout is healthy again. The gateway’s status page still says elevated latency, so a few charges a minute are still landing after checkout-api gives up." },
    { at: 420, from: "Grace Liu · Finance", text: "Do we have a list yet? I don’t want to refund anyone who actually got their order." },
    { at: 900, from: "Grace Liu · Finance", text: "Five minutes to the settlement cut-off." },
  ],
  hints: [
    "Look for charges the gateway captured that never turned into a paid order.",
    "Payments data reaches you through CDC about 45 seconds late, so the newest charges aren’t visible yet.",
    "One batch before the cut-off beats a perfect one after it. Refunds are keyed by charge id, so a second batch later only picks up the stragglers.",
  ],
  solution: {
    data: [
      { command: "warehouse run orphaned-captures", why: "Thousands of captured charges with no paid order, every one carrying an Idempotency-Key: checkout-api timeouts, not double taps." },
      { command: "reconcile preview", why: "How many charges a batch would refund now, and whether new ones are still arriving." },
      { command: "reconcile submit", why: "Queues a refund for every visible orphaned charge before the 00:30 cut-off, so they go out as voids." },
      { command: "reconcile status", why: "The batch is queued. The gateway’s trickle adds a few more a minute; a later batch sweeps them up." },
    ],
  },
  postmortem: {
    question: "Why were customers charged for checkouts that failed?",
    options: [
      "checkout-api gave up after 3 s, but the gateway still captured the charge",
      "The web Pay button sent every order twice with no idempotency key",
      "CDC lag made the warehouse count each charge twice",
      "Payments Ops re-ran yesterday’s refund batch by mistake",
    ],
    answerIndex: 0,
    explanation: {
      cause: "During the launch surge payment-gateway queued charges for longer than checkout-api’s 3 s timeout. checkout-api failed the order, and the gateway captured the card anyway.",
      why: "The gateway processes its queue in order, so a call that waited past the timeout was still captured. The customer saw an error, often paid again, and was left with one charge for an order that never existed. Refunding those charges before the settlement batch closes turns them into voids.",
      tell: "Every orphaned charge carried an Idempotency-Key and no cart was captured more than once, which rules out client retries. They line up with the minutes the gateway queue ran past 3 s, and no refund batch existed yet.",
    },
  },
};
