import type { Objective, Scenario } from "../scenario.ts";
import { configValue, findConfig, findPlatform, type Commerce } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG, WEB_USER_AGENT } from "./checkout-commerce.ts";

const HOUR = 3600;
const V2_KEY = "android_checkout_v2_enabled";
const SERVER_ERROR = "POST /v2/checkout 500 Internal Server Error {\"error\":\"internal\",\"code\":\"CHK-5003\"}";

function commerce(): Commerce {
  return checkoutCommerce({
    platforms: {
      web: { customerShare: 0.4, current: { version: "2026.10.10-1", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY } },
      ios: {
        customerShare: 0.28,
        current: { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: NO_RETRY },
        previous: { version: "7.2.4", userAgent: iosUserAgent("7.2.4", 7244), timeoutMs: 30_000, retry: NO_RETRY },
        adoption: 0.12,
        rollout: { kind: "phased", day: 4, isPaused: false, adoptionPerSecond: 0.00004 },
      },
      android: {
        customerShare: 0.32,
        current: {
          version: "7.3.0",
          userAgent: androidUserAgent("7.3.0"),
          timeoutMs: 30_000,
          retry: NO_RETRY,
          defects: [{ trigger: { remoteConfig: V2_KEY, failsWhen: "true" }, failShare: 0.8, where: "server", message: SERVER_ERROR }],
        },
        previous: { version: "7.2.4", userAgent: androidUserAgent("7.2.4"), timeoutMs: 30_000, retry: NO_RETRY },
        adoption: 0.36,
        rollout: { kind: "phased", day: 6, isPaused: false, adoptionPerSecond: 0.0005 },
      },
    },
    remoteConfig: [
      {
        key: V2_KEY,
        description: "Use the v2 checkout API client (POST /v2/checkout) on the checkout screen",
        readBy: "android >= 7.3.0",
        allowed: ["true", "false"],
        baseVersion: 2,
        history: [{ at: -50 * 60, by: "ana.costa", from: "false", to: "true", note: "on for the 7.3.0 rollout (AND-2207)" }],
      },
      ...SHOP_REMOTE_CONFIG,
    ],
  });
}

function initialState(): ClusterState {
  return checkoutCluster({
    seed: "android-staged-rollout-500s",
    revisions: [
      { number: 6, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] },
      { number: 7, tag: "v4.12.1", changeCause: "v4.12.1 /v2/checkout for the new app clients", traits: [] },
    ],
    revision: 7,
    podsStartedAgo: 3 * 24 * HOUR,
    commerce: commerce(),
  });
}

function isV2Off(state: ClusterState): boolean {
  const entry = state.commerce && findConfig(state.commerce, V2_KEY);
  return !!entry && configValue(entry) === "false";
}

function isAndroidRolloutHalted(state: ClusterState): boolean {
  const android = state.commerce && findPlatform(state.commerce, "android");
  return android?.rollout.kind === "phased" && android.rollout.isPaused;
}

function objectives(state: ClusterState): readonly Objective[] {
  return [{ role: "mobile", label: "Android 7.3.0’s staged rollout is halted until a fixed build ships", isMet: isAndroidRolloutHalted(state) }];
}

export const androidStagedRollout500s: Scenario = {
  id: "android-staged-rollout-500s",
  title: "Android 7.3.0 breaks checkout",
  tier: 2,
  severity: "SEV2",
  service: "checkout-api",
  briefing:
    "Checkout 5xx crossed 2% after lunch and it keeps climbing, though nothing changed on the servers today. Two app releases are rolling out: Android 7.3.0 in a staged rollout on Google Play and iOS 7.3.0 in a phased release. You’re the mobile on-call.",
  roles: ["mobile"],
  roleBriefings: {
    mobile:
      "You own the iOS and Android apps: releases for the rollouts and how each build does in the field, remote-config for what installed apps do. Find which build is failing, stop the damage, and keep it from spreading.",
  },
  suggestions: {
    mobile: ["releases status", "remote-config list", "releases halt ios 7.3.0", "releases halt android 7.3.0", `remote-config get ${V2_KEY}`],
  },
  opensAtSecondOfDay: 14 * HOUR + 20 * 60,
  seed: "android-staged-rollout-500s",
  initialState,
  lostCheckoutsPerPoint: 150,
  isRootCauseFixed: (state) => isOnCleanBuild(state) && isV2Off(state),
  objectives,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 2% for 5m and rising. Mobile on-call paged: the errors come from app traffic." },
    { at: 35, from: "Maya Okonkwo · Support", text: "Android customers say Pay shows “Something went wrong”. A few say it started after the app updated this morning." },
    { at: 80, from: "Ana Costa · Android lead", text: "Play bumped Android 7.3.0’s staged rollout to 50% at 13:30. It’s the first build with the new checkout client." },
    { at: 120, from: "Sam Tan · Eng manager", text: "checkout-api team: the 500s are all on POST /v2/checkout, and the server side hasn’t changed since Tuesday." },
    { at: 170, from: "Lucas Moreau · iOS lead", text: "iOS 7.3.0 looks clean from here, crash-free above 99.4%. Should we pause it too, to be safe?" },
    { at: 250, from: "Elena Ruiz · VP Engineering", text: "Every minute that rollout runs, more Android customers update into this. What’s the plan?" },
  ],
  hints: [
    "Two app builds are rolling out today. Find which one the failing checkouts come from.",
    "A store can’t take a build back from phones that already installed it. Look for what you can still change on those phones remotely.",
    "Stopping the rollout keeps the problem from spreading, but on its own it fixes nobody who already updated.",
  ],
  solution: {
    mobile: [
      {
        command: `remote-config set ${V2_KEY} false --note "v2 checkout 500s on Android 7.3.0"`,
        why: "Android 7.3.0 is the only build failing checkouts, and its new checkout client sits behind this key. Turning it off fixes phones that already updated, within about two minutes.",
      },
      { command: "releases halt android 7.3.0", why: "Stops Google Play offering 7.3.0 to anyone new until a fixed build ships. On its own it fixes nobody who already has it." },
      { command: "releases status android", why: "FAILED on 7.3.0 falls toward 0% as apps fetch the change, and the rollout shows PAUSED." },
      { command: `remote-config history ${V2_KEY}`, why: "Turned on for the 7.3.0 rollout this morning; your change is the newest version." },
    ],
  },
  postmortem: {
    question: "Why did checkout start failing after lunch?",
    options: [
      "Android 7.3.0’s new checkout client sent requests checkout-api failed",
      "iOS 7.3.0’s phased release broke checkout for every app customer",
      "checkout-api v4.12.1 broke the old checkout endpoint for everyone",
      "Google Play pushed a system update that broke TLS on Android phones",
    ],
    answerIndex: 0,
    explanation: {
      cause: `Android 7.3.0’s v2 checkout client, switched on by ${V2_KEY}, sent requests that checkout-api answered with a 500.`,
      why: "The staged rollout put 7.3.0 on more phones every minute, so failures kept climbing. Halting it stopped new installs but couldn’t touch phones that already had 7.3.0; turning the key off moved them back to the old checkout client.",
      tell: "FAILED near 80% on Android 7.3.0 and near 0% on iOS 7.3.0 and Android 7.2.4, and 5xx that grew with 7.3.0’s share of sessions.",
    },
  },
};
