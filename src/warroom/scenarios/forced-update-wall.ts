import type { Objective, Scenario } from "../scenario.ts";
import { clientSegments } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { configValue, findConfig, type Commerce } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { updateWall } from "../sim/update-wall.ts";
import { checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const ADDRESS_KEY = "checkout_address_v2_enabled";
const MIN_VERSION_KEY = "min_supported_version";
const SERVER_ERROR = 'POST /checkout 500 Internal Server Error {"error":"internal","code":"ADDR-5001"}';

function commerce(): Commerce {
  return checkoutCommerce({
    platforms: {
      ios: {
        current: {
          version: "7.3.0",
          userAgent: iosUserAgent("7.3.0", 7301),
          timeoutMs: 10_000,
          retry: NO_RETRY,
          defects: [{ trigger: { remoteConfig: ADDRESS_KEY, failsWhen: "true" }, failShare: 0.5, where: "server", message: SERVER_ERROR }],
        },
        previous: { version: "7.2.4", userAgent: iosUserAgent("7.2.4", 7244), timeoutMs: 30_000, retry: NO_RETRY },
        adoption: 0.95,
        inReview: "7.3.1",
      },
      android: {
        current: { version: "7.3.1", userAgent: androidUserAgent("7.3.1"), timeoutMs: 30_000, retry: NO_RETRY },
        previous: { version: "7.2.4", userAgent: androidUserAgent("7.2.4"), timeoutMs: 30_000, retry: NO_RETRY },
        adoption: 0.94,
      },
    },
    remoteConfig: [
      {
        key: ADDRESS_KEY,
        description: "New address form with postcode lookup on the checkout sheet",
        readBy: "ios >= 7.3.0, android >= 7.3.0",
        allowed: ["true", "false"],
        baseVersion: 4,
        history: [
          { at: -9 * DAY, by: "jonah.reyes", from: "true", to: "false", note: "address form bug in 7.3.0, fixed in 7.3.1 (MOB-1302)" },
          { at: -80 * 60, by: "jonah.reyes", from: "false", to: "true", note: "7.3.1 has the fix (MOB-1302): ramp to 100%" },
        ],
      },
      ...SHOP_REMOTE_CONFIG,
    ],
    updateWall: { configKey: MIN_VERSION_KEY },
  });
}

function initialState(): ClusterState {
  return checkoutCluster({
    seed: "forced-update-wall",
    revisions: [
      { number: 5, tag: "v4.10.2", changeCause: "v4.10.2 bump spring-boot to 3.3.4", traits: [] },
      { number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
    ],
    revision: 6,
    podsStartedAgo: 2 * DAY,
    commerce: commerce(),
  });
}

function isAddressV2Off(state: ClusterState): boolean {
  const entry = state.commerce && findConfig(state.commerce, ADDRESS_KEY);
  return !!entry && configValue(entry) === "false";
}

function isAnyoneWalled(state: ClusterState): boolean {
  const { commerce: shop } = state;
  return !!shop && clientSegments(shop, state.t).some((segment) => updateWall(shop, segment, state.t) > 0);
}

function objectives(state: ClusterState): readonly Objective[] {
  return [{ role: "mobile", label: `Every app build can still check out (${MIN_VERSION_KEY})`, isMet: !isAnyoneWalled(state) }];
}

export const forcedUpdateWall: Scenario = {
  id: "forced-update-wall",
  title: "Force-update to a build that isn’t out",
  tier: 3,
  severity: "SEV2",
  service: "checkout-api",
  briefing:
    "Checkout 5xx crossed 5% this morning and iPhone customers can’t pay. The servers haven’t changed in two days. The fix everyone is talking about, iOS 7.3.1, is waiting in App Review. You’re the mobile on-call.",
  roles: ["mobile"],
  roleBriefings: {
    mobile:
      "You own the iOS and Android apps: releases for builds and how each does in the field, remote-config for what installed apps do, including which builds are still allowed to run.",
  },
  suggestions: {
    mobile: ["releases status", "remote-config list", `remote-config history ${ADDRESS_KEY}`, `remote-config set ${MIN_VERSION_KEY} 7.3.1`, `remote-config get ${MIN_VERSION_KEY}`],
  },
  opensAtSecondOfDay: 11 * HOUR,
  seed: "forced-update-wall",
  initialState,
  alertMetric: {
    label: "checkout 5xx or loss",
    rate: (state) => Math.max(state.errorRate, state.commerce ? customerLossRate(state.commerce, state.t) : 0),
  },
  lostCheckoutsPerPoint: 200,
  isRootCauseFixed: (state) => isOnCleanBuild(state) && isAddressV2Off(state),
  objectives,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% for 5m. Mobile on-call paged: the 500s come from iOS app traffic." },
    { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers get “Something went wrong” right after entering their address. Android and web customers are fine." },
    { at: 70, from: "Jonah Reyes · Mobile lead", text: "Android 7.3.1 went out last week. App Review bounced iOS 7.3.1 on Monday; it’s back in the queue." },
    { at: 110, from: "Lucas Moreau · iOS lead", text: "7.3.1 fixes the address form. Why not force everyone onto it? Bump min_supported_version to 7.3.1 and the update screen does the rest." },
    { at: 160, from: "Sam Tan · Eng manager", text: "I’ve asked Apple for an expedited review of iOS 7.3.1. No promises; usually within a day." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "A third of our customers are on iPhone and it’s the morning peak. What’s the ETA?" },
  ],
  hints: [
    "Only one app build is failing. Check what changed for it this morning.",
    "The build with the fix isn’t in the App Store yet. Anything that sends customers to the store for it leaves them nowhere to go.",
    "Put the failing build back on the code path it ran before this morning.",
  ],
  solution: {
    mobile: [
      {
        command: `remote-config set ${ADDRESS_KEY} false --note "iOS 7.3.0 address v2 500s; the fix is in 7.3.1, still in review"`,
        why: "Only iOS 7.3.0 is failing, and it started when this key turned on this morning. Off sends 7.3.0 back to the old address form within about two minutes.",
      },
      { command: "releases status ios", why: "FAILED on 7.3.0 falls from about 50% toward 0%. 7.3.1 is still in review, so no customer could install it yet." },
      { command: `remote-config get ${MIN_VERSION_KEY}`, why: "Still 7.0.0: leave it. At 7.3.1 every iOS customer would sit behind an update screen for a build the App Store doesn’t have." },
      { command: `remote-config history ${ADDRESS_KEY}`, why: "Turned off nine days ago for this very bug, back on this morning for 7.3.1; your change is the newest version." },
    ],
  },
  postmortem: {
    question: "What made iOS 7.3.0’s checkouts start failing this morning?",
    options: [
      "A remote-config key turned the new address form on for a build without the fix",
      "App Review held iOS 7.3.1, so iPhone customers couldn’t update to the fixed build",
      "checkout-api started rejecting the addresses that every iOS build sends at checkout",
      "The forced-update screen kept iPhone customers on old builds out of checkout",
    ],
    answerIndex: 0,
    explanation: {
      cause: `${ADDRESS_KEY} was turned on for both apps because 7.3.1 had the fix, but only Android 7.3.1 was out: iOS 7.3.0 got the broken address form back.`,
      why: "Half of iOS 7.3.0’s new-form checkouts sent an address checkout-api answered with a 500. Turning the key off put 7.3.0 back on the old form. Forcing an update to 7.3.1 would have stopped the 500s by locking every iOS customer out, because the build they’d need wasn’t in the App Store.",
      tell: "FAILED near 50% on iOS 7.3.0 only, starting when the key changed, while Android 7.3.1 read the same key without a problem.",
    },
  },
};
