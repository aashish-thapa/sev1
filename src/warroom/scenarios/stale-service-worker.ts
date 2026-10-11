import type { Scenario } from "../scenario.ts";
import { percent } from "../shell/commerce-command.ts";
import { COMPANY_DOMAIN } from "../shell/identity.ts";
import { table } from "../shell/types.ts";
import { findFlag, findPlatform, isFlagOn } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const RETRY_FLAG = "checkout.auto_retry";
const KILL_SWITCH_FLAG = "web.sw_kill_switch";
const STALE_BUILD = "2026.10.09-2";
const FIXED_BUILD = "2026.10.10-1";
/** The newsletter lands at 09:44:00; the page fires at 09:47:00, once the storm has taken hold. */
const WARM_UP_SECONDS = 180;
const SURGE_SECONDS = 45;
const SURGE_RPS = 480;
const ORGANIC_RPS = 300;
const DEGRADED_CHARGES_PER_SECOND = 170;
/** Tabs the old worker reloads onto the network build each second while the kill switch is on: 70% move in under 90 s. */
const KILL_SWITCH_ADOPTION_PER_SECOND = 0.008;
const OLD_WORKER = 412;
const NEW_WORKER = 413;

/** The registration as Chrome's Application panel would show it across our users' browsers. */
function serviceWorker(state: ClusterState): readonly string[] {
  const { commerce } = state;
  const web = commerce && findPlatform(commerce, "web");
  const killSwitch = commerce && findFlag(commerce, KILL_SWITCH_FLAG);
  if (!web) return [];
  const isKillSwitchOn = !!killSwitch && isFlagOn(killSwitch);
  const stale = 1 - web.adoption;
  return [
    `Service worker · scope https://www.${COMPANY_DOMAIN}/ · checkout-web sessions, last 5 min`,
    ...table([
      ["STATUS", "BUILD", "CONTROLS"],
      stale > 0 ? [`#${OLD_WORKER} activated and is running`, STALE_BUILD, `${percent(stale, 0)} of tabs`] : [`#${OLD_WORKER} is redundant`, STALE_BUILD, "—"],
      stale > 0 ? [`#${NEW_WORKER} waiting to activate`, FIXED_BUILD, "— (until every tab #412 controls has closed)"] : [`#${NEW_WORKER} activated and is running`, FIXED_BUILD, "100% of tabs"],
    ]),
    `Precache workbox-precache-v2-https://www.${COMPANY_DOMAIN}/ holds the ${stale > 0 ? STALE_BUILD : FIXED_BUILD} app shell and bundles, served cache-first.`,
    isKillSwitchOn
      ? `${KILL_SWITCH_FLAG} is on: #${OLD_WORKER} unregisters and reloads each tab it controls from the network.`
      : `${KILL_SWITCH_FLAG} is off.`,
  ];
}

export const staleServiceWorker: Scenario = {
  id: "stale-service-worker",
  tier: 4,
  title: "The rollback that didn't reach the browser",
  severity: "SEV2",
  service: CHECKOUT,
  briefing: `Yesterday’s web release ${STALE_BUILD} retried every slow checkout instantly. At 08:30 the team replaced it with ${FIXED_BUILD}, which backs off. The payment gateway is degraded again, the 09:44 newsletter brought a surge, and checkout is failing just like yesterday.`,
  roles: ["frontend"],
  roleBriefings: {
    frontend: `You own checkout-web: the flags CLI and RUM. The CDN only serves ${FIXED_BUILD}. Find out what customers’ browsers are actually running before you reach for yesterday’s fix.`,
  },
  suggestions: {
    frontend: ["rum overview", "rum session", "rum service-worker", "flags list", `flags history ${RETRY_FLAG}`, `flags set ${RETRY_FLAG} off`],
  },
  evidence: [{ tool: "rum", name: "service-worker", description: "Service worker versions and the tabs they control", run: serviceWorker }],
  opensAtSecondOfDay: 9 * HOUR + 44 * 60 + WARM_UP_SECONDS,
  seed: "stale-service-worker",
  initialState: () =>
    checkoutCluster({
      seed: "stale-service-worker",
      revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
      revision: 6,
      replicas: 4,
      commerce: checkoutCommerce({
        platforms: {
          web: {
            current: { version: FIXED_BUILD, userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: { kind: "flag", key: RETRY_FLAG, whenOn: "backoff", whenOff: "none" } },
            previous: { version: STALE_BUILD, userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: { kind: "fixed", policy: "immediate" } },
            adoption: 0.3,
            rollout: { kind: "service-worker", killSwitchFlag: KILL_SWITCH_FLAG, adoptionPerSecond: KILL_SWITCH_ADOPTION_PER_SECOND },
          },
        },
        flags: [
          {
            key: RETRY_FLAG,
            description: "Retry POST /checkout automatically when it times out or returns 5xx",
            owner: "team-checkout-web",
            history: [{ at: -19 * HOUR, by: "web-release-bot", from: false, to: true, note: `web ${STALE_BUILD} (FE-2291): turn on checkout auto-retry` }],
          },
          {
            key: KILL_SWITCH_FLAG,
            description: "Old service workers unregister themselves and reload their tabs from the network",
            owner: "team-web-platform",
            history: [{ at: -120 * DAY, by: "jorge.alvarez", from: true, to: false, note: "kill-switch drill done" }],
          },
          ...SHOP_FLAGS,
        ],
        gateway: { chargesPerSecond: DEGRADED_CHARGES_PER_SECOND, maxQueueSeconds: 10 },
      }),
      warmUp: { seconds: WARM_UP_SECONDS, requestsPerSecond: (second) => (second < SURGE_SECONDS ? SURGE_RPS : ORGANIC_RPS) },
    }),
  isRootCauseFixed: (state) => {
    const web = state.commerce && findPlatform(state.commerce, "web");
    return !!web && web.adoption >= 0.99;
  },
  // Every checkout fails until the old worker lets go and the gateway queue drains: a quick fix still loses ~18k.
  lostCheckoutsPerPoint: 1000,
  externals: [
    {
      id: "payment-gateway",
      status: "degraded",
      facts: [
        { key: "Status page", value: "Reduced capacity in us-east — merchants should retry with backoff (since 09:30)" },
        { key: "Throughput for us", value: `≈${DEGRADED_CHARGES_PER_SECOND} charges/s while degraded; excess queues FIFO` },
        { key: "checkout-api timeout", value: "3000 ms per call" },
      ],
    },
  ],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 30% since the newsletter. Assigned to frontend on-call." },
    { at: 20, from: "Priya Shah · Frontend lead", text: `This looks exactly like yesterday, but ${STALE_BUILD} is gone: ${FIXED_BUILD} went out at 08:30 with backoff and idempotency keys, and the CDN only serves ${FIXED_BUILD}.` },
    { at: 50, from: "Maya Okonkwo · Support", text: "Customers say Pay spins, then spins again. A couple said a hard refresh fixed it." },
    { at: 90, from: "Sam Tan · Eng manager", text: "payment-gateway is degraded and asking merchants to back off. We’re sending them about three charges per order again." },
    { at: 130, from: "Jorge Alvarez · Web platform", text: "Our checkout shell is precached by the Workbox service worker. A new worker waits until every tab the old one controls has closed, and phone users never close tabs." },
    { at: 210, from: "Elena Ruiz · VP Engineering", text: "We fixed this yesterday. Why is it back?" },
  ],
  hints: [
    "The bad build was replaced hours ago, yet something still behaves like it. Find out which build the failing sessions are actually running.",
    "A hard refresh fixes it for some customers. What does a hard refresh skip that a normal page load doesn’t?",
    "A switch that changes what the new build does can’t reach a build that never reads it.",
  ],
  solution: {
    frontend: [
      { command: "rum overview", why: `70% of web sessions still run ${STALE_BUILD}, at four requests per Pay tap; ${FIXED_BUILD} sends about one.` },
      { command: "rum session", why: `The sampled ${STALE_BUILD} session loaded its page and bundles from the service worker, not the network.` },
      { command: "rum service-worker", why: `The old worker still controls 70% of tabs; the one for ${FIXED_BUILD} is waiting to activate.` },
      { command: `flags set ${KILL_SWITCH_FLAG} on --note "old worker is pinning tabs to ${STALE_BUILD}"`, why: `The old worker unregisters and reloads its tabs onto ${FIXED_BUILD}.` },
      { command: "rum overview", why: `${STALE_BUILD}’s share falls toward 0% and REQ/TAP with it; checkout recovers once the gateway queue drains.` },
    ],
  },
  postmortem: {
    question: `Why did ${STALE_BUILD} keep running after it was replaced?`,
    options: [
      "The CDN kept serving the old bundles from its edge cache",
      "Its service worker kept serving the precached build to open tabs",
      `The ${FIXED_BUILD} deploy failed and was rolled back automatically`,
      `${RETRY_FLAG} was still on, so the new build retried as hard`,
    ],
    answerIndex: 1,
    explanation: {
      cause: `Workbox had precached ${STALE_BUILD}. The worker for ${FIXED_BUILD} installed but waited to activate while the old one still controlled open tabs, so 70% of sessions kept running yesterday’s build and its hard-coded instant retries.`,
      why: `When the degraded gateway met the newsletter surge, those stale tabs retried every timeout at once and the storm held. ${RETRY_FLAG} only switches ${FIXED_BUILD} between backoff and no retry; ${STALE_BUILD} never read it. The kill switch made the old worker unregister and reload its tabs, so they moved to ${FIXED_BUILD} and the gateway queue drained.`,
      tell: `RUM showed 70% of web sessions on ${STALE_BUILD} at four requests per Pay tap, pages served (ServiceWorker), and the new worker waiting to activate.`,
    },
  },
};
