import type { Objective, Scenario } from "../scenario.ts";
import { clientSegments, triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { configValue, findConfig, latestChange, type ClientDefect, type Commerce, type DefectTrigger } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const API_HOST = "api.marlow.shop";
const PIN_SET_KEY = "api_pin_set";
const PINNING_MODE_KEY = "api_pinning_mode";

/** SPKI pins (sha256, base64) of the certificates around the API; fictional keys. */
const OLD_INTERMEDIATE_PIN = "sha256/vZLucvSvH39DMm3RUcknHGtgt/Hqi+jMuuk1BavJKiY=";
const BACKUP_PIN = "sha256/5JAtQIBaqlsGtu/+NAlZPmMFoKJi88yIyJkMcKC/Vfw=";
const NEW_INTERMEDIATE_PIN = "sha256/WLzjxBehVlZI4YwxVVf20Pz/c9kniFWRpoB2oTlCcR0=";
const ROOT_PIN = "sha256/NWs12gHGX+5DpiffXXZtyJYsjSUoV+PBaTrvhqPwOiI=";
const LEAF_PIN = "sha256/xBRS4r1uD9YoHqukSvBD+zPpjEVfFRxdkloTX6Hvn+0=";
const PINNED_BEFORE = `${OLD_INTERMEDIATE_PIN},${BACKUP_PIN}`;
const PINNED_AFTER = `${PINNED_BEFORE},${NEW_INTERMEDIATE_PIN}`;
const NEW_INTERMEDIATE = "Halyard TLS RSA CA 2026";
const ROOT = "Halyard Root R1";

const PIN_MISSING: DefectTrigger = { remoteConfig: PIN_SET_KEY, failsWithout: NEW_INTERMEDIATE_PIN };
/** A failed pin check blocks the connection only while pinning is enforced; report-only lets it through and reports it. */
const BLOCKS_CONNECTION: DefectTrigger = { all: [PIN_MISSING, { remoteConfig: PINNING_MODE_KEY, failsWhen: "enforce" }] };

// TrustKit (TSKPinningValidator.m, ssl_pin_verifier.m) and OkHttp 4.12.0 (CertificatePinner.kt), verbatim.
const TRUSTKIT_FAILURE = `Pin validation failed for ${API_HOST}`;
const OKHTTP_FAILURE = "javax.net.ssl.SSLPeerUnverifiedException: Certificate pinning failure!";

function pinningDefect(message: string): ClientDefect {
  return { trigger: BLOCKS_CONNECTION, failShare: 1, where: "client", message };
}

function commerce(): Commerce {
  const ios = pinningDefect(`[TrustKit] ${TRUSTKIT_FAILURE}`);
  const android = pinningDefect(OKHTTP_FAILURE);
  return checkoutCommerce({
    platforms: {
      ios: {
        current: { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: NO_RETRY, defects: [ios] },
        previous: { version: "7.2.4", userAgent: iosUserAgent("7.2.4", 7244), timeoutMs: 30_000, retry: NO_RETRY, defects: [ios] },
        adoption: 0.41,
        rollout: { kind: "phased", day: 5, isPaused: false, adoptionPerSecond: 0.00004 },
      },
      android: { current: { version: "7.2.4", userAgent: androidUserAgent("7.2.4"), timeoutMs: 30_000, retry: NO_RETRY, defects: [android] } },
    },
    remoteConfig: [
      {
        key: PIN_SET_KEY,
        description: `SPKI pins the apps accept for ${API_HOST}; at least two`,
        readBy: "ios >= 7.0.0, android >= 7.0.0",
        allowed: null,
        baseVersion: 3,
        history: [{ at: -210 * DAY, by: "kai.nakamura", from: "", to: PINNED_BEFORE, note: "Halyard TLS RSA CA 2024 + offline backup key (SEC-812)" }],
      },
      {
        key: PINNING_MODE_KEY,
        description: "enforce: a failed pin check blocks the connection. report-only: allow it and send a pin failure report",
        readBy: "ios >= 7.0.0, android >= 7.0.0",
        allowed: ["enforce", "report-only"],
        baseVersion: 1,
        history: [{ at: -200 * DAY, by: "kai.nakamura", from: "report-only", to: "enforce", note: "pen-test finding PT-2025-14: enforce pinning in prod" }],
      },
      ...SHOP_REMOTE_CONFIG,
    ],
  });
}

function initialState(): ClusterState {
  return checkoutCluster({
    seed: "pinned-cert-rotation",
    revisions: [
      { number: 5, tag: "v4.10.2", changeCause: "v4.10.2 bump spring-boot to 3.3.4", traits: [] },
      { number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
    ],
    revision: 6,
    podsStartedAgo: 2 * DAY,
    commerce: commerce(),
  });
}

function configOf(state: ClusterState, key: string): string | undefined {
  const entry = state.commerce && findConfig(state.commerce, key);
  return entry ? configValue(entry) : undefined;
}

function isNewIntermediatePinned(state: ClusterState): boolean {
  return (configOf(state, PIN_SET_KEY) ?? "").split(",").some((pin) => pin.trim() === NEW_INTERMEDIATE_PIN);
}

function objectives(state: ClusterState): readonly Objective[] {
  return [{ role: "mobile", label: `Certificate pinning is still enforced (${PINNING_MODE_KEY})`, isMet: configOf(state, PINNING_MODE_KEY) === "enforce" }];
}

/** The pins the failing apps hold: the newest published set that still lacks the new intermediate. */
function pinsStillHeld(shop: Commerce): readonly string[] {
  const entry = findConfig(shop, PIN_SET_KEY);
  if (!entry) return [];
  const change = latestChange(entry.history);
  const held = change.to.split(",").some((pin) => pin.trim() === NEW_INTERMEDIATE_PIN) ? change.from : change.to;
  return held.split(",").map((pin) => pin.trim()).filter(Boolean);
}

/** `releases tls-errors`: what each app build's pinning reports when it talks to the API. */
function tlsErrors(state: ClusterState): readonly string[] {
  const shop = state.commerce;
  if (!shop) return [];
  const missing = triggerShare(PIN_MISSING, shop, state.t);
  const blocking = triggerShare(BLOCKS_CONNECTION, shop, state.t);
  const apps = clientSegments(shop, state.t).filter((segment) => segment.platform !== "web");
  const perMinute = (share: number) => Math.round(shop.pulse.organicCheckoutsPerSecond * share * missing * 60).toLocaleString("en-US");
  const rows = apps.map((segment) => [`${segment.platform} ${segment.version}`.padEnd(16), perMinute(segment.share).padStart(14), missing === 0 ? "—" : blocking > 0 ? "connection blocked" : "allowed, report sent"].join("   "));
  const header = [`Pin validation on ${API_HOST} from app telemetry, last 5 min`, `${"BUILD".padEnd(16)}   ${"FAILURES/MIN".padStart(14)}   OUTCOME`, ...rows];
  if (missing === 0) return [...header, "", "No pin validation failures."];
  return [
    ...header,
    "",
    "Sample, ios 7.3.0 (TrustKit, forwarded by the app's logger):",
    `[TrustKit] Checking certificate with CN: ${ROOT}`,
    `[TrustKit] Checking certificate with CN: ${NEW_INTERMEDIATE}`,
    `[TrustKit] Checking certificate with CN: ${API_HOST}`,
    `[TrustKit] Error: SSL Pin not found for ${API_HOST}`,
    `[TrustKit] ${TRUSTKIT_FAILURE}`,
    "",
    "Sample, android 7.2.4 (OkHttp CertificatePinner):",
    OKHTTP_FAILURE,
    "  Peer certificate chain:",
    `    ${LEAF_PIN}: CN=${API_HOST}`,
    `    ${NEW_INTERMEDIATE_PIN}: CN=${NEW_INTERMEDIATE},O=Halyard Trust,C=US`,
    `    ${ROOT_PIN}: CN=${ROOT},O=Halyard Trust,C=US`,
    `  Pinned certificates for ${API_HOST}:`,
    ...pinsStillHeld(shop).map((pin) => `    ${pin}`),
  ];
}

export const pinnedCertRotation: Scenario = {
  id: "pinned-cert-rotation",
  title: "The apps can’t reach the API",
  tier: 4,
  severity: "SEV1",
  service: "checkout-api",
  briefing:
    "No app customer has checked out since about 10:15. checkout-api shows almost no errors and web checkout is fine; the iOS and Android apps simply stopped placing orders. Every app build is affected, old and new. You’re the mobile on-call.",
  roles: ["mobile"],
  roleBriefings: {
    mobile:
      "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Both apps pin the API’s TLS keys, and security requires pinning enforced in production.",
  },
  suggestions: {
    mobile: ["releases status", "releases tls-errors", "remote-config list", "releases halt ios 7.3.0", `remote-config set ${PINNING_MODE_KEY} report-only`, `remote-config get ${PIN_SET_KEY}`],
  },
  opensAtSecondOfDay: 10 * HOUR + 18 * 60,
  seed: "pinned-cert-rotation",
  initialState,
  alertMetric: {
    label: "checkout loss",
    rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0),
  },
  evidence: [
    { tool: "releases", name: "tls-errors", description: `Pin validation failures on ${API_HOST} by app build (app telemetry)`, run: tlsErrors },
  ],
  lostCheckoutsPerPoint: 500,
  isRootCauseFixed: (state) => isOnCleanBuild(state) && isNewIntermediatePinned(state),
  objectives,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%; app checkout volume has dropped to nothing. Mobile on-call paged." },
    { at: 25, from: "Maya Okonkwo · Support", text: "App customers on iPhone and Android: “Cannot connect to Marlow. Check your connection and try again.” Web works fine." },
    { at: 60, from: "Sam Tan · Eng manager", text: `Infra renewed the ${API_HOST} certificate at 10:12, as scheduled. They say nothing else changed this morning.` },
    { at: 100, from: "Lucas Moreau · iOS lead", text: "iOS 7.3.0 is mid phased release. Should we halt it? Or roll back to 7.2.4?" },
    { at: 150, from: "Jonah Reyes · Mobile lead", text: `Fastest way out: flip ${PINNING_MODE_KEY} to report-only and checkout works again. We can sort the pins out later.` },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Half our customers are app customers and none of them can buy. What’s the ETA?" },
  ],
  hints: [
    "checkout-api sees almost nothing failing. Look at what the apps themselves report.",
    "Every build fails the same way, so no release or rollback will help. Something about the API’s certificate changed this morning.",
    "The apps can learn to trust a new key without a new build, and without giving up pinning.",
  ],
  solution: {
    mobile: [
      {
        command: `remote-config set ${PIN_SET_KEY} ${PINNED_AFTER} --note "add ${NEW_INTERMEDIATE} after the 10:12 renewal"`,
        why: "Every app build pins the old intermediate’s key, and the renewed certificate chains to a new intermediate. Adding its key lets installed apps connect again within about two minutes, with pinning still enforced.",
      },
      { command: "releases tls-errors", why: `TrustKit and OkHttp report pin validation failures on ${API_HOST}: the chain now carries ${NEW_INTERMEDIATE}, whose key the pinned set lacked. Failures fall to zero as apps fetch the new set.` },
      { command: "releases status", why: "FAILED falls from 100% toward 0% on every app build. Halting or rolling back would have done nothing: every build pins the same keys." },
      { command: `remote-config get ${PINNING_MODE_KEY}`, why: "Still enforce. Report-only would have let checkout through by turning pinning off." },
    ],
  },
  postmortem: {
    question: "Why could no app customer check out after 10:12?",
    options: [
      "checkout-api rejected every request carrying an app user agent",
      "The apps pinned only the old intermediate, not the one now serving",
      "iOS 7.3.0’s phased release shipped a broken networking layer",
      "The renewed certificate had already expired when it was installed",
    ],
    answerIndex: 1,
    explanation: {
      cause: `Both apps pinned the SPKI of ${API_HOST}’s old intermediate plus a backup key. The renewal at 10:12 came from a new intermediate, so pin validation failed on every app build and the apps dropped the connection.`,
      why: "The failure happened inside the apps before any request reached checkout-api, so 5xx stayed near zero while app checkouts stopped. Builds, releases and rollbacks were irrelevant because every build reads its pins from remote config; adding the new intermediate’s key fixed them all with pinning still enforced.",
      tell: "0% 5xx, web unaffected, every app build failing at once from 10:12, and pin validation errors whose peer chain shows a key missing from the pinned set.",
    },
  },
};
