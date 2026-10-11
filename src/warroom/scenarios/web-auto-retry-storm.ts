import type { Scenario } from "../scenario.ts";
import { unsafeRetryShare } from "../sim/clients.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const HOUR = 3600;
const RETRY_FLAG = "checkout.auto_retry";
/** The sale email lands at 11:00:00; the page fires at 11:03:00, once the storm has taken hold. */
const WARM_UP_SECONDS = 180;
const SURGE_SECONDS = 45;
const SURGE_RPS = 480;
const ORGANIC_RPS = 300;
/** Above organic checkouts (120/s), below what web sends while it retries every timeout. */
const DEGRADED_CHARGES_PER_SECOND = 150;

export const webAutoRetryStorm: Scenario = {
  id: "web-auto-retry-storm",
  tier: 1,
  title: "The Pay button won't stop",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "The Autumn Sale email went out at 11:00. Three minutes later most checkouts are failing, though traffic is already back to normal and the payment gateway is only slow, not down. You're the frontend on-call; Priya, the frontend lead, is on the call.",
  roles: ["frontend"],
  roleBriefings: {
    frontend:
      "You own checkout-web. Your laptop has the flags CLI and RUM for the checkout page. Yesterday’s web release changed what the Pay button does when a payment is slow.",
  },
  suggestions: {
    frontend: ["rum overview", "rum session", "rum errors", "flags list", `flags history ${RETRY_FLAG}`, "flags set home.sale_banner off"],
  },
  opensAtSecondOfDay: 11 * HOUR + WARM_UP_SECONDS,
  seed: "web-auto-retry-storm",
  initialState: () =>
    checkoutCluster({
      seed: "web-auto-retry-storm",
      revisions: [
        { number: 5, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
        { number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
      ],
      revision: 6,
      commerce: checkoutCommerce({
        platforms: {
          web: { current: { version: "2026.10.09-2", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: { kind: "flag", key: RETRY_FLAG, whenOn: "immediate", whenOff: "none" } } },
        },
        flags: [
          {
            key: RETRY_FLAG,
            description: "Retry POST /checkout automatically when it times out or returns 5xx",
            owner: "team-checkout-web",
            history: [{ at: -19 * HOUR, by: "web-release-bot", from: false, to: true, note: "web 2026.10.09-2 (FE-2291): turn on checkout auto-retry" }],
          },
          ...SHOP_FLAGS,
        ],
        gateway: { chargesPerSecond: DEGRADED_CHARGES_PER_SECOND },
      }),
      warmUp: { seconds: WARM_UP_SECONDS, requestsPerSecond: (second) => (second < SURGE_SECONDS ? SURGE_RPS : ORGANIC_RPS) },
    }),
  isRootCauseFixed: (state) => !!state.commerce && unsafeRetryShare(state.commerce, state.t) < 0.001,
  // Every checkout fails until the gateway queue drains, ~2 minutes after the retries stop: a quick fix still loses ~18k.
  lostCheckoutsPerPoint: 1200,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Reduced capacity in us-east — merchants should retry with backoff (since 10:41)" },
        { key: "Throughput for us", value: `≈${DEGRADED_CHARGES_PER_SECOND} charges/s while degraded; excess queues FIFO` },
        { key: "checkout-api timeout", value: "3000 ms per call" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 50% since the sale email. Assigned to frontend on-call." },
    { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "Start with RUM. Compare Pay taps with POST /checkout requests: if one tap turns into several requests, the browser is feeding this." },
    { at: 40, from: "Maya Okonkwo · Support", text: "Customers say the Pay button spins for ages, then spins again. Nobody is getting an order through." },
    { at: 70, from: "Lena Ortiz · Growth", text: "Was it my sale banner? It went live at 10:56. Happy to switch home.sale_banner off if that helps." },
    { at: 100, from: "Priya Shah · Frontend lead (your mentor)", text: "Auto-retry on the Pay button shipped yesterday behind a flag. flags history shows when it was switched on and by whom." },
    { at: 150, from: "Sam Tan · Eng manager", text: "payment-gateway is at reduced capacity and asking every merchant to back off. We’re sending them far more charges than we have orders." },
    { at: 220, from: "Priya Shah · Frontend lead (your mentor)", text: "Once the retries stop, the gateway’s queue still has to drain before checkout recovers. Give it a couple of minutes." },
  ],
  hints: [
    "Traffic is back to normal, yet checkout keeps failing. Count how many requests each Pay tap turns into.",
    "Something changed recently in what the browser does when a payment is slow. Find what was switched on, and when.",
    "Features that only add visitors at the top of the shop won’t help now: the extra load comes from the Pay button itself.",
  ],
  solution: {
    frontend: [
      { command: "rum overview", why: "Every Pay tap sends four POST /checkout requests, and almost no orders go through." },
      { command: "rum session", why: "The browser retries 2 ms after each timeout with an identical body and no Idempotency-Key." },
      { command: `flags history ${RETRY_FLAG}`, why: "Auto-retry was switched on with yesterday’s web release." },
      { command: `flags set ${RETRY_FLAG} off --note "instant retries are keeping the gateway queue full"`, why: "Open tabs stop retrying within ~20 s; the gateway queue can start to drain." },
      { command: "rum overview", why: "REQ/TAP falls back to 1.00. Orders return once the queue has drained." },
    ],
  },
  postmortem: {
    question: "Why did checkout stay down after the sale traffic had passed?",
    options: [
      "The sale banner kept sending more shoppers than checkout-api could serve",
      "Each timed-out Pay tap was retried at once, so the gateway queue never drained",
      "The payment gateway stopped processing charges for every merchant",
      "checkout-api ran out of database connections during the sale",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Web 2026.10.09-2 retried every timed-out checkout immediately, up to three times, while the payment gateway was degraded.",
      why: "The sale email briefly sent more charges than the degraded gateway could take, so its queue grew and calls began to time out. Each timeout made the browser send the same checkout again at once, so the gateway saw about four times the real demand and its queue never drained, long after traffic was back to normal. Turning the retries off let the queue drain.",
      tell: "RUM showed about four POST /checkout requests per Pay tap on 2026.10.09-2, fired 2 ms after each timeout, while normal days run at 1.00.",
    },
  },
};
