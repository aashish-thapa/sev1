import type { Objective, Scenario } from "../scenario.ts";
import { unsafeRetryShare } from "../sim/clients.ts";
import { configValue, findConfig, RETRY_POLICY_NAMES, type Commerce } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const RETRY_CONFIG_KEY = "checkout_retry_policy";
/** The push campaign lands at 11:00:00; the page fires at 11:03:00, once the storm holds on its own. */
const WARM_UP_SECONDS = 180;
const PUSH_SURGE_SECONDS = 50;
const PUSH_SURGE_RPS = 480;
const ORGANIC_RPS = 300;
/** What the degraded gateway completes for us: above organic demand, well below what immediate retries send. */
const GATEWAY_CHARGES_PER_SECOND = 150;

function commerce(): Commerce {
  return checkoutCommerce({
    platforms: {
      ios: {
        current: { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: { kind: "remote-config", key: RETRY_CONFIG_KEY } },
        previous: { version: "7.2.4", userAgent: iosUserAgent("7.2.4", 7244), timeoutMs: 30_000, retry: NO_RETRY },
        adoption: 0.5,
        rollout: { kind: "phased", day: 6, isPaused: false, adoptionPerSecond: 0.00025 },
      },
    },
    remoteConfig: [
      {
        key: RETRY_CONFIG_KEY,
        description: "How the app retries POST /checkout on timeout or 5xx",
        readBy: "ios >= 7.3.0",
        allowed: RETRY_POLICY_NAMES,
        baseVersion: 56,
        history: [{ at: -6 * DAY, by: "release-bot", from: "none", to: "immediate", note: "ios 7.3.0 (MOB-1184): default for new checkout networking layer" }],
      },
      ...SHOP_REMOTE_CONFIG,
    ],
    gateway: { chargesPerSecond: GATEWAY_CHARGES_PER_SECOND, maxQueueSeconds: 8 },
  });
}

function initialState(): ClusterState {
  return checkoutCluster({
    seed: "ios-retry-config",
    revisions: [
      { number: 5, tag: "v4.10.2", changeCause: "v4.10.2 bump spring-boot to 3.3.4", traits: [] },
      { number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
    ],
    revision: 6,
    commerce: commerce(),
    warmUp: { seconds: WARM_UP_SECONDS, requestsPerSecond: (second) => (second < PUSH_SURGE_SECONDS ? PUSH_SURGE_RPS : ORGANIC_RPS) },
  });
}

function retryPolicy(state: ClusterState): string | undefined {
  const entry = state.commerce && findConfig(state.commerce, RETRY_CONFIG_KEY);
  return entry ? configValue(entry) : undefined;
}

function objectives(state: ClusterState): readonly Objective[] {
  return [{ role: "mobile", label: `iOS 7.3.0 no longer retries immediately (${RETRY_CONFIG_KEY})`, isMet: retryPolicy(state) !== "immediate" }];
}

export const iosRetryConfig: Scenario = {
  id: "ios-retry-config",
  title: "The app keeps retrying",
  tier: 1,
  severity: "SEV2",
  service: "checkout-api",
  briefing:
    "A push campaign went out at 11:00 and checkout started failing. The rush is over, but checkout hasn’t recovered, and the payment gateway says we’re sending far more charge attempts than we take orders. You’re the mobile on-call. iOS 7.3.0 is on day 6 of its phased release.",
  roles: ["mobile"],
  roleBriefings: {
    mobile:
      "You own the iOS and Android apps: releases shows each build and how it behaves in the field, remote-config changes apps already on customers’ phones. Remember what you can and can’t take back once a build is installed.",
  },
  suggestions: {
    mobile: ["releases status", `remote-config get ${RETRY_CONFIG_KEY}`, "releases halt ios 7.3.0", `remote-config set ${RETRY_CONFIG_KEY} backoff`],
  },
  opensAtSecondOfDay: 11 * HOUR + WARM_UP_SECONDS,
  seed: "ios-retry-config",
  initialState,
  // Every customer on a storming build loses their checkout while the gateway queue drains, so even a fast fix loses a few thousand.
  lostCheckoutsPerPoint: 1000,
  isRootCauseFixed: (state) => isOnCleanBuild(state) && !!state.commerce && unsafeRetryShare(state.commerce, state.t) < 0.001,
  objectives,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Reduced capacity in us-east — merchants should retry with backoff (since 10:41)" },
        { key: "Throughput for us", value: `≈${GATEWAY_CHARGES_PER_SECOND} charges/s while degraded; excess queues FIFO` },
        { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% for 3m. Mobile on-call paged: app checkout requests per order are up." },
    { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Start with releases status. Compare REQ/ORDER across builds: a build that sends one request per order reads 1.00." },
    { at: 45, from: "Maya Okonkwo · Support", text: "New App Store reviews: “Pay spins, then fails, and my card shows two pending charges.” All from iPhones." },
    { at: 75, from: "Sam Tan · Eng manager", text: "The gateway’s TAM says the traffic surge is long over but we’re still sending about three charge attempts per order. They’re asking us to back off." },
    { at: 105, from: "Jonah Reyes · Mobile lead (your mentor)", text: "7.3.0 reads its retry policy from remote config: remote-config get checkout_retry_policy. Halting the release won’t change phones that already have 7.3.0." },
    { at: 150, from: "Jonah Reyes · Mobile lead (your mentor)", text: "remote-config set checkout_retry_policy backoff. Apps pick it up within about two minutes; then watch REQ/ORDER fall." },
  ],
  hints: [
    "Compare how many checkout requests each app build sends for every order it takes.",
    "Phones that installed a build keep it. What can you still change on them without shipping a new one?",
    "The newest iOS build takes its retry behaviour from remote config, and the value it was given has no backoff.",
  ],
  solution: {
    mobile: [
      {
        command: `remote-config set ${RETRY_CONFIG_KEY} backoff --note "immediate retries keep the gateway queue full"`,
        why: "iOS 7.3.0 retries every failed checkout three times at once. Remote config reaches apps already installed, within about two minutes, so publish it first.",
      },
      { command: "releases status ios", why: "7.3.0 sends about four checkout requests per order and 7.2.4 one. REQ/ORDER on 7.3.0 falls as apps fetch the new policy." },
      { command: `remote-config get ${RETRY_CONFIG_KEY}`, why: "backoff: two retries with exponential backoff and jitter, a 10% retry budget and an Idempotency-Key." },
      { command: `remote-config history ${RETRY_CONFIG_KEY}`, why: "release-bot set immediate when 7.3.0 shipped; your change is now the newest version." },
    ],
  },
  postmortem: {
    question: "What kept checkout failing after the push campaign’s rush had passed?",
    options: [
      "The payment gateway was down for every merchant it serves",
      "iOS 7.3.0 retried each failed checkout at once, with no backoff",
      "Android 7.2.4 sent every checkout request to the gateway twice",
      "checkout-api ran out of database connections under the rush",
    ],
    answerIndex: 1,
    explanation: {
      cause: "iOS 7.3.0 read checkout_retry_policy from remote config, and it was set to immediate: up to three instant retries with no backoff and no Idempotency-Key.",
      why: "The gateway was running at reduced capacity. The push rush filled its queue past checkout-api’s 3 s timeout, and every timeout made 7.3.0 send up to three more charge attempts, so the queue never drained after the rush. Backoff with a retry budget brought demand back under what the gateway could take.",
      tell: "REQ/ORDER near 4 on iOS 7.3.0 and 1.00 on every other build, with organic traffic back to normal.",
    },
  },
};
