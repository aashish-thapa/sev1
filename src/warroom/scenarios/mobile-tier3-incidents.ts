import type { Role } from "../../domain/incident.ts";
import type { CommsMessage, ExternalService, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { clientDefects } from "../sim/client-defects.ts";
import { clientSegments, triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import {
  configValue,
  findConfig,
  findPlatform,
  type ClientBuild,
  type ClientDefect,
  type Commerce,
  type DefectTrigger,
  type Platform,
  type RemoteConfigEntry,
  type Rollout,
} from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { updateWall } from "../sim/update-wall.ts";
import { CHECKOUT, checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
const ROLE: Role = "mobile";
const MIN_VERSION = "min_supported_version";

/** One installed app build and the bugs it shipped with. */
type Build = { readonly version: string; readonly defects?: readonly ClientDefect[] };

/** One app platform: its share of checkout customers, the build rolling out and the one it replaces. */
type App = {
  readonly share: number;
  readonly current: Build;
  readonly previous?: Build;
  /** Share of the platform's sessions on `current`; required with `previous`. */
  readonly adoption?: number;
  readonly rollout?: Rollout;
  readonly inReview?: string;
};

type ConfigReader = (key: string) => string;

/**
 * A tier-3 mobile incident: one remote-config change broke checkout on some app builds, and the move
 * the room reaches for first (force an update, flip the global switch, revert to the runbook value,
 * resume the release with the fix) makes it worse. The fix is one narrower remote-config value.
 */
type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly ios: App;
  readonly android: App;
  /** The incident's own keys; a shop key of the same name is replaced. */
  readonly config: readonly RemoteConfigEntry[];
  /** True once the key that broke checkout holds its safe value. */
  readonly isFixed: (config: ConfigReader) => boolean;
  /** An outcome beyond the fix that the tempting move would cost. */
  readonly guard?: { readonly label: string; readonly isMet: (config: ConfigReader, state: ClusterState) => boolean };
  /** The plausible move that backfires. */
  readonly trap: string;
  readonly view: { readonly name: string; readonly description: string };
  readonly lostCheckoutsPerPoint: number;
  readonly externals?: readonly ExternalService[];
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly suggestions: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function fails(trigger: DefectTrigger, failShare: number, where: ClientDefect["where"], message: string): ClientDefect {
  return { trigger, failShare, where, message };
}

/** A value change in a remote-config key's history. */
function change(at: number, by: string, from: string, to: string, note: string) {
  return { at, by, from, to, note };
}

function key(
  name: string,
  description: string,
  readBy: string,
  allowed: readonly string[] | null,
  baseVersion: number,
  history: RemoteConfigEntry["history"],
): RemoteConfigEntry {
  return { key: name, description, readBy, allowed, baseVersion, history };
}

function iosBuild(build: Build): ClientBuild {
  const number = Number(build.version.replace(/\./g, "")) * 10 + 1;
  return { version: build.version, userAgent: iosUserAgent(build.version, number), timeoutMs: 10_000, retry: NO_RETRY, defects: build.defects ?? [] };
}

function androidBuild(build: Build): ClientBuild {
  return { version: build.version, userAgent: androidUserAgent(build.version), timeoutMs: 30_000, retry: NO_RETRY, defects: build.defects ?? [] };
}

function platform(app: App, asBuild: (build: Build) => ClientBuild): Partial<Omit<Platform, "id">> {
  return {
    customerShare: app.share,
    current: asBuild(app.current),
    previous: app.previous ? asBuild(app.previous) : null,
    adoption: app.previous ? (app.adoption ?? 1) : 1,
    rollout: app.rollout ?? { kind: "instant" },
    inReview: app.inReview ?? null,
  };
}

function commerce(row: Row): Commerce {
  const own = new Set(row.config.map((entry) => entry.key));
  return checkoutCommerce({
    platforms: {
      web: { customerShare: 1 - row.ios.share - row.android.share },
      ios: platform(row.ios, iosBuild),
      android: platform(row.android, androidBuild),
    },
    remoteConfig: [...row.config, ...SHOP_REMOTE_CONFIG.filter((entry) => !own.has(entry.key))],
    updateWall: { configKey: MIN_VERSION },
  });
}

function reader(state: ClusterState): ConfigReader {
  return (name) => {
    const entry = state.commerce && findConfig(state.commerce, name);
    return entry ? configValue(entry) : "";
  };
}

function isAnyoneWalled(state: ClusterState): boolean {
  const shop = state.commerce;
  return !!shop && clientSegments(shop, state.t).some((segment) => updateWall(shop, segment, state.t) > 0);
}

/** The incident's app-telemetry view: failed checkouts per build, and what the failing ones report. */
function telemetry(row: Row) {
  return (state: ClusterState): readonly string[] => {
    const shop = state.commerce;
    if (!shop) return [];
    const apps = clientSegments(shop, state.t).filter((segment) => segment.platform !== "web");
    const perWindow = (share: number) => shop.pulse.organicCheckoutsPerSecond * share * WINDOW_SECONDS;
    const failing = apps.map((segment) => {
      const effect = clientDefects(shop, segment, state.t);
      const failed = 1 - (1 - effect.clientFailureShare) * (1 - effect.rejectedShare);
      const messages = segment.defects.filter((defect) => triggerShare(defect.trigger, shop, state.t) > 0.001).map((defect) => defect.message);
      return { segment, failed, messages };
    });
    const rows = failing.map(({ segment, failed }) => [
      `${segment.platform} ${segment.version}`,
      count(perWindow(segment.share)),
      percent(failed),
      count(perWindow(segment.share) * failed),
    ]);
    const samples = failing
      .filter(({ failed, messages }) => failed > 0.001 && messages.length > 0)
      .flatMap(({ segment, messages }) => ["", `Sample, ${segment.platform} ${segment.version}:`, ...messages.map((message) => `  ${message}`)]);
    return [
      `${row.view.description} · app telemetry, last 5 min`,
      ...table([["BUILD", "CHECKOUTS", "FAILED", "FAILED CHECKOUTS"], ...rows]),
      ...(samples.length > 0 ? samples : ["", "No checkout failures reported by any app build."]),
    ];
  };
}

function incident(row: Row): Scenario {
  const id = `mob-t3-${row.slug}`;
  const objectives = (state: ClusterState): readonly Objective[] => [
    { role: ROLE, label: `Every app build can still check out (${MIN_VERSION})`, isMet: !isAnyoneWalled(state) },
    ...(row.guard ? [{ role: ROLE, label: row.guard.label, isMet: row.guard.isMet(reader(state), state) }] : []),
  ];
  return {
    id,
    tier: 3,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: [ROLE],
    roleBriefings: { [ROLE]: row.roleBriefing },
    suggestions: { [ROLE]: row.suggestions },
    evidence: [{ tool: "releases", name: row.view.name, description: row.view.description, run: telemetry(row) }],
    opensAtSecondOfDay: row.opensAt[0] * HOUR + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [
          { number: 7, tag: "v4.12.1", changeCause: "v4.12.1 /v2/checkout for the new app clients", traits: [] },
          { number: 8, tag: "v4.12.4", changeCause: "v4.12.4 order-status webhook retries", traits: [] },
        ],
        revision: 8,
        podsStartedAgo: 2 * DAY,
        commerce: commerce(row),
      }),
    alertMetric: {
      label: "checkout 5xx or loss",
      rate: (state) => Math.max(state.errorRate, state.commerce ? customerLossRate(state.commerce, state.t) : 0),
    },
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    isRootCauseFixed: (state) => isOnCleanBuild(state) && row.isFixed(reader(state)),
    objectives,
    externals: row.externals ?? [],
    comms: row.comms,
    hints: row.hints,
    solution: { [ROLE]: row.solution },
    postmortem: row.postmortem,
  };
}

const MOBILE_BRIEFING =
  "You own the iOS and Android apps: releases for builds, rollouts and their field telemetry, remote-config for what installed apps do, including which builds are still allowed to run.";

const isPaused = (state: ClusterState, id: "ios" | "android") => {
  const app = state.commerce && findPlatform(state.commerce, id);
  return app?.rollout.kind === "phased" && app.rollout.isPaused;
};

const has = (list: string, entry: string) => list.split(",").some((item) => item.trim() === entry);

const serverError = (code: string, detail?: string) =>
  `POST /checkout 500 Internal Server Error {"error":"internal","code":"${code}"${detail ? `,"detail":"${detail}"` : ""}}`;

// Swift runtime, Chromium net errors, OkHttp/Retrofit and Android, verbatim.
const SWIFT_NIL = "Fatal error: Unexpectedly found nil while unwrapping an Optional value";
const SWIFT_INDEX = "Fatal error: Index out of range";
const ANDROID_TRUST_ANCHOR = "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";

const ROWS: readonly Row[] = [
  {
    slug: "android-wall-in-review",
    title: "Force-update Android to a build Play hasn’t approved",
    severity: "SEV2",
    opensAt: [9, 42],
    briefing:
      "Since about 08:50 Android customers have been failing at Pay, and it gets worse as Android 7.4.0’s staged rollout reaches more phones. checkout-api hasn’t deployed in two days. The fix, Android 7.4.1, is waiting in Play review. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: { share: 0.22, current: { version: "7.4.0" } },
    android: {
      share: 0.28,
      current: {
        version: "7.4.0",
        defects: [fails({ remoteConfig: "checkout_saved_cards_v3", failsWhen: "true" }, 0.55, "server", serverError("CARD-5012", "vault_token: unexpected token format"))],
      },
      previous: { version: "7.3.2" },
      adoption: 0.45,
      rollout: { kind: "phased", day: 6, isPaused: false, adoptionPerSecond: 0.0003 },
      inReview: "7.4.1",
    },
    config: [
      key("checkout_saved_cards_v3", "Read saved cards from the v3 card vault on the payment step", "android >= 7.4.0", ["true", "false"], 6, [
        change(-12 * DAY, "ana.costa", "true", "false", "7.4.0 sends the v2 token field to v3 (AND-2381); fixed in 7.4.1"),
        change(-52 * MINUTE, "ana.costa", "false", "true", "vault migration finished; ramp to 100% (PAY-771)"),
      ]),
    ],
    isFixed: (config) => config("checkout_saved_cards_v3") === "false",
    trap: `remote-config set ${MIN_VERSION} 7.4.1`,
    view: { name: "payment-errors", description: "Checkout failures on the payment step by app build" },
    lostCheckoutsPerPoint: 120,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout 5xx or loss > 5% for 5m. Mobile on-call paged: the 500s come from Android app traffic." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers paying with a saved card get “Payment failed, try again”. New cards seem fine. iPhone is fine." },
      { at: 70, from: "Ana Costa · Android lead", text: "The v3 card vault went to 100% just before nine. 7.4.0 had a token bug with it, but 7.4.1 fixes that." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "7.4.1 is the fix, so make everyone take it: min_supported_version 7.4.1 and the update screen does the rest." },
      { at: 160, from: "Sam Tan · Eng manager", text: "Play review for 7.4.1 says “pending”. Could be an hour, could be tomorrow." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Every phone that picks up 7.4.0 joins this. What’s the plan?" },
    ],
    hints: [
      "Only one build is failing, and only for one way of paying. Check what changed for it this morning.",
      "The build with the fix isn’t in the Play Store yet. Anything that sends customers to the store for it leaves them nowhere to go.",
      "Put the failing build back on the card code path it ran before this morning.",
    ],
    suggestions: ["releases status android", "releases payment-errors", "remote-config list", "remote-config history checkout_saved_cards_v3", `remote-config set ${MIN_VERSION} 7.4.1`],
    solution: [
      {
        command: 'remote-config set checkout_saved_cards_v3 false --note "7.4.0 v3 vault token 500s; fix is in 7.4.1, still in Play review"',
        why: "Only Android 7.4.0 fails, and it began when the v3 vault went to 100%. Off sends 7.4.0 back to the v2 vault within about two minutes.",
      },
      { command: "releases payment-errors", why: "Failures on 7.4.0 carry CARD-5012 (unexpected token format) and fall toward zero as apps fetch the change." },
      { command: "releases status android", why: "7.4.1 shows in review, so nobody could install it: an update screen for it would lock every Android customer out." },
      { command: `remote-config get ${MIN_VERSION}`, why: "Still 7.0.0. Leave it until 7.4.1 is actually in the store." },
    ],
    postmortem: {
      question: "What made Android 7.4.0’s checkouts start failing this morning?",
      options: [
        "Play review held 7.4.1, so Android customers couldn’t update to the fixed build",
        "A remote-config key put 7.4.0 on the v3 vault it couldn’t read",
        "checkout-api stopped accepting saved cards from every app build",
        "The card vault migration deleted the saved cards of Android customers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_saved_cards_v3 went to 100% because 7.4.1 reads the v3 vault correctly, but 7.4.1 wasn’t out: Android 7.4.0 sent its old token field to v3, which checkout-api answered with a 500.",
        why: "The staged rollout put 7.4.0 on more phones every minute, so failures grew. Turning the key off put 7.4.0 back on the v2 vault. Forcing an update to 7.4.1 would have stopped the 500s by locking every Android customer out, since Play hadn’t approved the build they’d need.",
        tell: "FAILED only on Android 7.4.0, only for saved cards, from the minute the key changed, with 7.4.1 still listed as in review.",
      },
    },
  },
  {
    slug: "ios-floor-strands-stragglers",
    title: "Raising the floor on iOS 7.1",
    severity: "SEV3",
    opensAt: [8, 15],
    briefing:
      "UK prices went VAT-inclusive at 07:30 and since then a slice of iPhone customers crash on the review step. Everyone else is fine. The crashes all come from iOS 7.1.4, a build about a fifth of iPhone customers never updated from. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.4,
      current: { version: "7.3.2" },
      previous: { version: "7.1.4", defects: [fails({ remoteConfig: "checkout_tax_display", failsWhen: "inclusive" }, 0.7, "client", SWIFT_NIL)] },
      adoption: 0.78,
    },
    android: { share: 0.14, current: { version: "7.3.2" } },
    config: [
      key("checkout_tax_display", "How the review step shows tax: exclusive (added at the end) or inclusive (in every line price)", "ios >= 7.0.0, android >= 7.0.0", ["exclusive", "inclusive"], 3, [
        change(-45 * MINUTE, "noor.haddad", "exclusive", "inclusive", "UK VAT-inclusive pricing launch (GRW-530)"),
      ]),
    ],
    isFixed: (config) => config("checkout_tax_display") === "exclusive",
    trap: `remote-config set ${MIN_VERSION} 7.2.0`,
    view: { name: "crashes", description: "Crashes on the checkout review step by app build" },
    lostCheckoutsPerPoint: 100,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: iOS crash rate up." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Some iPhone customers say the app closes when they tap Review order. Only since this morning." },
      { at: 75, from: "Noor Haddad · Growth", text: "VAT-inclusive pricing for the UK went live at 07:30. Legal wanted it today; please don’t undo it unless you must." },
      { at: 115, from: "Lucas Moreau · iOS lead", text: "7.1.4 is two years old. Raise min_supported_version to 7.2.0 and those people update. Problem gone." },
      { at: 170, from: "Sam Tan · Eng manager", text: "Analytics: when we last showed a forced-update screen, most people closed the app instead of updating." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Small slice, but they’re paying customers. What are we doing?" },
    ],
    hints: [
      "Only the oldest iOS build crashes. Check what changed this morning that an old build might not understand.",
      "A blocking update screen doesn’t check anybody out today; it only turns a crash into a closed app.",
      "Put the old build back on the review step it could render before 07:30.",
    ],
    suggestions: ["releases status ios", "releases crashes", "remote-config list", "remote-config history checkout_tax_display", `remote-config set ${MIN_VERSION} 7.2.0`],
    solution: [
      {
        command: 'remote-config set checkout_tax_display exclusive --note "iOS 7.1.4 crashes rendering inclusive tax lines"',
        why: "iOS 7.1.4 crashes on the review step whenever prices are inclusive, and it started at 07:30. Exclusive brings it back within about two minutes.",
      },
      { command: "releases crashes", why: "Every crash is a nil unwrap on iOS 7.1.4; 7.3.2 renders inclusive prices fine. Crashes fall as apps fetch the change." },
      { command: "releases status ios", why: "FAILED on 7.1.4 falls toward 0%, and nobody sits on the forced-update screen." },
      { command: `remote-config get ${MIN_VERSION}`, why: "Still 7.0.0. At 7.2.0, everyone on 7.1.4 would have lost checkout entirely instead of some of them." },
    ],
    postmortem: {
      question: "Why did iPhone customers start crashing on the review step at 07:30?",
      options: [
        "iOS 7.1.4 couldn’t render the inclusive tax display turned on that morning",
        "iOS 7.3.2 shipped a review step that crashes on every UK address",
        "checkout-api started sending prices without a currency to every app",
        "The forced-update screen kept old builds away from checkout-api’s newest endpoints",
      ],
      answerIndex: 0,
      explanation: {
        cause: "checkout_tax_display went to inclusive for the UK launch. iOS 7.1.4 reads the key but predates the inclusive tax line, so its review step unwrapped a value that wasn’t there and crashed.",
        why: "Only 7.1.4 crashed, and only some of its checkouts. Raising the minimum to 7.2.0 would have put all of them behind an update screen, which most customers close: more lost checkouts, not fewer. Exclusive brought 7.1.4 back at once while the launch waits for a build-aware rollout.",
        tell: "Crashes only on iOS 7.1.4, all nil unwraps on the review step, starting at the minute the key changed.",
      },
    },
  },
  {
    slug: "shared-floor-walls-ios",
    title: "Evicting a bad Android build walls iPhones too",
    severity: "SEV2",
    opensAt: [13, 5],
    briefing:
      "Android customers paying with Pacer, our buy-now-pay-later option, have been failing since about 12:20. All the failures come from Android 7.9.2, which most Android customers still run because 7.9.4’s rollout was halted on Tuesday. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: { share: 0.25, current: { version: "7.8.3" } },
    android: {
      share: 0.3,
      current: { version: "7.9.4" },
      previous: { version: "7.9.2", defects: [fails({ remoteConfig: "checkout_bnpl_provider", failsWhen: "pacer-v2" }, 0.6, "server", serverError("BNPL-5021", "pacer: plan_id missing"))] },
      adoption: 0.1,
      rollout: { kind: "phased", day: 4, isPaused: true, adoptionPerSecond: 0.0002 },
    },
    config: [
      key("checkout_bnpl_provider", "Which Pacer integration the payment step uses", "ios >= 7.6.0, android >= 7.6.0", ["pacer-v1", "pacer-v2", "off"], 9, [
        change(-45 * MINUTE, "dev.raman", "pacer-v1", "pacer-v2", "Pacer v2 instalment plans (PAY-845)"),
      ]),
    ],
    isFixed: (config) => config("checkout_bnpl_provider") === "pacer-v1",
    trap: `remote-config set ${MIN_VERSION} 7.9.4`,
    view: { name: "bnpl-errors", description: "Pacer checkout failures by app build" },
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout 5xx or loss > 5% for 5m. Mobile on-call paged: the 500s come from Android app traffic on Pacer payments." },
      { at: 35, from: "Maya Okonkwo · Support", text: "Android customers choosing Pacer get “Payment failed”. Card payments go through. iPhone customers are fine." },
      { at: 75, from: "Ana Costa · Android lead", text: "7.9.4 halted Tuesday on an ANR spike, since explained. 7.9.2 sends Pacer v2 orders without a plan_id; 7.9.4 fixed that." },
      { at: 115, from: "Ana Costa · Android lead", text: "Quickest way to get people off 7.9.2: set min_supported_version to 7.9.4. Anyone below it has to update." },
      { at: 160, from: "Lucas Moreau · iOS lead", text: "Careful with that key. Which builds read it again?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Pacer is a quarter of Android revenue this week. ETA?" },
    ],
    hints: [
      "Only one Android build fails, and only for one payment method. Check what changed for that method at lunchtime.",
      "Before you change who may run the app, check which apps read that setting.",
      "Put the failing build back on the payment integration it used this morning.",
    ],
    suggestions: ["releases status", "releases bnpl-errors", `remote-config get ${MIN_VERSION}`, "remote-config history checkout_bnpl_provider", `remote-config set ${MIN_VERSION} 7.9.4`],
    solution: [
      {
        command: 'remote-config set checkout_bnpl_provider pacer-v1 --note "Android 7.9.2 sends Pacer v2 orders without plan_id"',
        why: "Only Android 7.9.2 fails, on Pacer v2, which went live at 12:20. Back on v1 it pays again within about two minutes.",
      },
      { command: "releases bnpl-errors", why: "Every failure is BNPL-5021 (plan_id missing) from Android 7.9.2; failures fall as apps fetch the change." },
      { command: "releases status", why: "FAILED on 7.9.2 falls toward 0% and nobody is on the update screen." },
      { command: `remote-config get ${MIN_VERSION}`, why: "Read by iOS and Android alike: at 7.9.4 it would also have walled every iPhone, whose newest build is 7.8.3." },
    ],
    postmortem: {
      question: "What broke Pacer checkouts on Android after 12:20?",
      options: [
        "Android 7.9.4’s halted rollout left customers on a build Pacer had stopped supporting",
        "Pacer v2 was switched on for Android 7.9.2, which sends v2 orders without a plan",
        "Pacer’s API rejected every order from Marlow’s apps after an outage on their side",
        "checkout-api v4.12.4 dropped the plan_id field from every Pacer order it forwarded",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_bnpl_provider moved to pacer-v2 at 12:20. Android 7.9.2 reads the key but builds v2 orders without a plan_id, which checkout-api answered with a 500.",
        why: "Most Android customers were still on 7.9.2 because 7.9.4 had been halted. Raising min_supported_version to 7.9.4 would have walled those customers and every iPhone too, because both apps read the same key and iOS has no 7.9.4. pacer-v1 fixed 7.9.2 without walling anyone.",
        tell: "BNPL-5021 only from Android 7.9.2, starting when the key changed, while 7.9.4 and iOS on the same key were clean.",
      },
    },
  },
  {
    slug: "kill-switch-legacy-webview",
    title: "The checkout kill switch nobody tested",
    severity: "SEV2",
    opensAt: [10, 31],
    briefing:
      "Android 7.5.0 customers have been failing at Pay since a little before ten, and more phones pick up 7.5.0 every minute. The runbook says the native checkout sheet has a kill switch that sends every app back to the web checkout. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.25,
      current: { version: "7.5.0", defects: [fails({ remoteConfig: "checkout_native_sheet_enabled", failsWhen: "false" }, 1, "client", "LegacyCheckoutWebView: provisional navigation failed: HTTP 410 for https://m.marlow.shop/m/checkout")] },
    },
    android: {
      share: 0.3,
      current: {
        version: "7.5.0",
        defects: [
          fails(
            { all: [{ remoteConfig: "checkout_native_sheet_enabled", failsWhen: "true" }, { remoteConfig: "checkout_wallet_prefill_enabled", failsWhen: "true" }] },
            0.5,
            "server",
            serverError("ADDR-5017", "shipping_address.country_code: expected ISO 3166-1 alpha-2"),
          ),
          fails({ remoteConfig: "checkout_native_sheet_enabled", failsWhen: "false" }, 1, "client", "retrofit2.HttpException: HTTP 410 Gone"),
        ],
      },
      previous: { version: "7.4.3", defects: [fails({ remoteConfig: "checkout_native_sheet_enabled", failsWhen: "false" }, 1, "client", "retrofit2.HttpException: HTTP 410 Gone")] },
      adoption: 0.4,
      rollout: { kind: "phased", day: 5, isPaused: false, adoptionPerSecond: 0.0004 },
    },
    config: [
      key("checkout_native_sheet_enabled", "Native checkout sheet; false falls back to the legacy web checkout at /m/checkout", "ios >= 7.0.0, android >= 7.0.0", ["true", "false"], 4, [
        change(-60 * DAY, "jonah.reyes", "false", "true", "native sheet GA; legacy web checkout frozen (MOB-1210)"),
      ]),
      key("checkout_wallet_prefill_enabled", "Prefill the shipping address from Google Wallet on the native sheet", "android >= 7.5.0", ["true", "false"], 1, [
        change(-38 * MINUTE, "ana.costa", "false", "true", "Wallet address prefill for 7.5.0 (AND-2410)"),
      ]),
    ],
    isFixed: (config) => config("checkout_wallet_prefill_enabled") === "false",
    guard: { label: "The native checkout sheet stays on (checkout_native_sheet_enabled)", isMet: (config) => config("checkout_native_sheet_enabled") === "true" },
    trap: "remote-config set checkout_native_sheet_enabled false",
    view: { name: "sheet-errors", description: "Checkout failures on the checkout sheet by app build" },
    lostCheckoutsPerPoint: 120,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout 5xx or loss > 5% for 5m. Mobile on-call paged: the 500s come from Android 7.5.0." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers who let the app fill in their address get “Something went wrong” at Pay. Typing it in by hand works." },
      { at: 70, from: "Ana Costa · Android lead", text: "Wallet prefill went on for 7.5.0 at 09:53. It’s the only new thing on the sheet." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Runbook RB-7: checkout_native_sheet_enabled false is the kill switch. Everyone drops to the web checkout until we sort it." },
      { at: 165, from: "Priya Shah · Web lead", text: "Which web checkout? We froze /m/checkout two months ago and the edge started answering it with 410 last week." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "7.5.0 is at half of Android by tonight. What’s the call?" },
    ],
    hints: [
      "Only customers whose address was filled in for them fail. Find what fills it in, and which build has it.",
      "A switch is only a way out if the path behind it still works. Ask the web team what that path is now.",
      "Turn off just the new part of the sheet, not the sheet.",
    ],
    suggestions: ["releases status android", "releases sheet-errors", "remote-config list", "remote-config history checkout_wallet_prefill_enabled", "remote-config set checkout_native_sheet_enabled false"],
    solution: [
      {
        command: 'remote-config set checkout_wallet_prefill_enabled false --note "7.5.0 Wallet prefill sends full country names: ADDR-5017"',
        why: "Only Android 7.5.0 fails, only with Wallet prefill, which went on at 09:53. Off keeps the native sheet and stops the bad addresses within about two minutes.",
      },
      { command: "releases sheet-errors", why: "Failures carry ADDR-5017: the prefilled country isn’t an ISO code. They fall as apps fetch the change." },
      { command: "releases status android", why: "FAILED on 7.5.0 falls toward 0% while its rollout keeps going." },
      { command: "remote-config get checkout_native_sheet_enabled", why: "Still true. False would have sent every app to /m/checkout, which now answers 410 Gone." },
    ],
    postmortem: {
      question: "What made Android 7.5.0’s checkouts fail after 09:53?",
      options: [
        "The native checkout sheet broke on Android 7.5.0, so the kill switch was needed",
        "Wallet prefill put full country names where checkout-api wants ISO codes",
        "The edge started answering 410 on the legacy web checkout for every app customer",
        "Google Wallet stopped returning shipping addresses to apps during an outage",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_wallet_prefill_enabled went on for Android 7.5.0 at 09:53. The prefilled address carried a country name instead of an ISO 3166-1 code, and checkout-api answered those checkouts with a 500.",
        why: "The kill switch looked like the safe move, but its fallback, the legacy web checkout, had been frozen and the edge answered it with 410: every app customer on iOS and Android would have failed. Turning off just the prefill fixed 7.5.0 and kept the sheet.",
        tell: "ADDR-5017 only on Android 7.5.0, only for prefilled addresses, from the minute prefill went on; and a web lead saying /m/checkout is gone.",
      },
    },
  },
  {
    slug: "runbook-retired-host",
    title: "The failover host in the runbook is gone",
    severity: "SEV1",
    opensAt: [15, 12],
    briefing:
      "No Android customer has checked out since about 14:40. iPhone and web are fine, and checkout-api sees almost nothing failing. At 14:40 infra moved the apps’ API traffic to a new edge host through remote config. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.3,
      current: {
        version: "7.6.0",
        defects: [fails({ remoteConfig: "checkout_api_host", failsWhen: "api-v1.marlow.shop" }, 1, "client", 'Error Domain=NSURLErrorDomain Code=-1003 "A server with the specified hostname could not be found."')],
      },
    },
    android: {
      share: 0.2,
      current: {
        version: "7.6.1",
        defects: [
          fails({ remoteConfig: "checkout_api_host", failsWhen: "edge-api.marlow.shop" }, 1, "client", ANDROID_TRUST_ANCHOR),
          fails({ remoteConfig: "checkout_api_host", failsWhen: "api-v1.marlow.shop" }, 1, "client", 'java.net.UnknownHostException: Unable to resolve host "api-v1.marlow.shop": No address associated with hostname'),
        ],
      },
      previous: {
        version: "7.5.3",
        defects: [
          fails({ remoteConfig: "checkout_api_host", failsWhen: "edge-api.marlow.shop" }, 1, "client", ANDROID_TRUST_ANCHOR),
          fails({ remoteConfig: "checkout_api_host", failsWhen: "api-v1.marlow.shop" }, 1, "client", 'java.net.UnknownHostException: Unable to resolve host "api-v1.marlow.shop": No address associated with hostname'),
        ],
      },
      adoption: 0.7,
    },
    config: [
      key("checkout_api_host", "Host the apps send API and checkout traffic to", "ios >= 7.0.0, android >= 7.0.0", ["api.marlow.shop", "edge-api.marlow.shop", "api-v1.marlow.shop"], 7, [
        change(-400 * DAY, "kai.nakamura", "api-v1.marlow.shop", "api.marlow.shop", "v1 cluster decommission (INF-301)"),
        change(-32 * MINUTE, "omar.farouk", "api.marlow.shop", "edge-api.marlow.shop", "route apps through the new edge (INF-1180)"),
      ]),
    ],
    isFixed: (config) => config("checkout_api_host") === "api.marlow.shop",
    trap: "remote-config set checkout_api_host api-v1.marlow.shop",
    view: { name: "network-errors", description: "Network errors on checkout by app build" },
    lostCheckoutsPerPoint: 300,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 15% for 3m; checkout-api 5xx 0.1%. Mobile on-call paged: Android checkout volume is near zero." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers: “Can’t connect to Marlow.” Wi-Fi or mobile data, same thing. iPhone works." },
      { at: 65, from: "Omar Farouk · Infra", text: "I moved checkout_api_host to edge-api.marlow.shop at 14:40. New CDN, new certificate from a different CA. Web is already on it and happy." },
      { at: 105, from: "Jonah Reyes · Mobile lead", text: "Runbook RB-12, API failover: set checkout_api_host to api-v1.marlow.shop. Let’s just do that." },
      { at: 150, from: "Kai Nakamura · Security", text: "RB-12 is from 2024. Has anyone checked it since the v1 cluster went away?" },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "A fifth of our customers can’t buy anything. ETA?" },
    ],
    hints: [
      "checkout-api sees almost nothing. Look at what the Android app itself reports when it connects.",
      "A runbook is only as current as the last time someone checked the host it names still exists.",
      "The value that worked for every app until this afternoon is in the key’s own history.",
    ],
    suggestions: ["releases status", "releases network-errors", "remote-config history checkout_api_host", "remote-config set checkout_api_host api-v1.marlow.shop"],
    solution: [
      {
        command: 'remote-config set checkout_api_host api.marlow.shop --note "Android does not trust the edge-api CA; back to the host every app trusted"',
        why: "Android fails every connection to edge-api: its network security config doesn’t trust the new CA. api.marlow.shop worked for every app until 14:40, and apps pick it up within about two minutes.",
      },
      { command: "releases network-errors", why: "Android 7.6.1 and 7.5.3 report a missing trust anchor on edge-api; the errors fall to zero as apps fetch the change." },
      { command: "releases status", why: "FAILED on both Android builds falls from 100% toward 0%; iOS stays clean." },
      { command: "remote-config history checkout_api_host", why: "api-v1 was retired 400 days ago: the runbook value would have sent every app, iOS too, to a host that no longer resolves." },
    ],
    postmortem: {
      question: "Why did Android customers stop checking out at 14:40?",
      options: [
        "The runbook’s failover host was retired, so the apps couldn’t reach any API",
        "Android apps didn’t trust the new edge host’s CA, so every connection failed",
        "checkout-api rejected every request that arrived through the new edge host",
        "A Play Services update on Android phones broke TLS for every app on the device",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_api_host moved to edge-api.marlow.shop, whose certificate chains to a CA the Android apps’ network security config doesn’t list. Every Android connection failed the trust check before any request was sent.",
        why: "iOS and web trust that CA, so only Android broke and checkout-api saw nothing. The runbook’s failover host had been decommissioned a year earlier: setting it would have broken iOS as well. Going back to api.marlow.shop, the host every app trusted until 14:40, restored Android.",
        tell: "Trust anchor for certification path not found on every Android build, starting at 14:40, with iOS on the same host clean.",
      },
    },
  },
  {
    slug: "resume-ios-crashing-release",
    title: "Resuming the release with the fix",
    severity: "SEV2",
    opensAt: [12, 8],
    briefing:
      "Since about 11:30, iPhone customers who stack two promo codes fail at Pay. iOS 7.4.2 fixes promo stacking, but its phased release was paused yesterday after a crash spike. Almost every iPhone is on 7.4.1. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.38,
      current: { version: "7.4.2", defects: [fails("always", 0.9, "client", SWIFT_INDEX)] },
      previous: { version: "7.4.1", defects: [fails({ remoteConfig: "checkout_promo_stacking_enabled", failsWhen: "true" }, 0.45, "server", serverError("PROMO-5004", "discount_lines: duplicate line id"))] },
      adoption: 0.02,
      rollout: { kind: "phased", day: 3, isPaused: true, adoptionPerSecond: 0.0015 },
    },
    android: { share: 0.14, current: { version: "7.4.1" } },
    config: [
      key("checkout_promo_stacking_enabled", "Allow a second promo code on the checkout sheet", "ios >= 7.4.0, android >= 7.4.0", ["true", "false"], 2, [
        change(-38 * MINUTE, "lena.ortiz", "false", "true", "Autumn Sale: stack a loyalty code with the sale code (GRW-561)"),
      ]),
    ],
    isFixed: (config) => config("checkout_promo_stacking_enabled") === "false",
    guard: { label: "iOS 7.4.2 stays paused until its crash is fixed", isMet: (_config, state) => isPaused(state, "ios") },
    trap: "releases resume ios 7.4.2",
    view: { name: "crashes", description: "Checkout crashes and failures by app build" },
    lostCheckoutsPerPoint: 250,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout 5xx or loss > 5% for 5m. Mobile on-call paged: the 500s come from iOS 7.4.1." },
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers with a sale code and a loyalty code get “Something went wrong”. One code works fine." },
      { at: 70, from: "Lena Ortiz · Growth", text: "Promo stacking went live at 11:30 for the Autumn Sale. Android handles it fine." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.4.2 fixes stacking. I paused it yesterday for that crash spike, but it was probably a symbolication glitch. Resume it and the fix rolls out." },
      { at: 165, from: "Sam Tan · Eng manager", text: "The crash spike on 7.4.2 is still open in the crash reporter. Nobody has closed it." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "This is the sale’s busiest hour. What’s the plan?" },
    ],
    hints: [
      "Only customers with two codes fail, and only on the iPhone build most people run. What turned stacking on?",
      "Before you spread a build, read what it is doing on the phones that already have it.",
      "You can switch the new promo behaviour off on the phones that have it today, without any new build.",
    ],
    suggestions: ["releases status ios", "releases crashes", "remote-config history checkout_promo_stacking_enabled", "releases resume ios 7.4.2"],
    solution: [
      {
        command: 'remote-config set checkout_promo_stacking_enabled false --note "iOS 7.4.1 PROMO-5004 on stacked codes; 7.4.2 is still crashing"',
        why: "iOS 7.4.1 fails stacked codes, which went live at 11:30. Off stops the 500s on every installed 7.4.1 within about two minutes.",
      },
      { command: "releases crashes", why: "7.4.1 fails with PROMO-5004, and the few phones on 7.4.2 crash with Index out of range on most checkouts." },
      { command: "releases status ios", why: "7.4.2 stays PAUSED. Resuming it would trade a promo error for a crash on far more phones." },
      { command: "remote-config history checkout_promo_stacking_enabled", why: "Turned on for the sale at 11:30; your change is now the newest version." },
    ],
    postmortem: {
      question: "Why did iPhone checkouts with two promo codes start failing at 11:30?",
      options: [
        "iOS 7.4.2’s phased release was paused, so customers couldn’t get the fix",
        "Promo stacking went on for iOS 7.4.1, which sends duplicate discount lines",
        "checkout-api started rejecting every order that carried more than one discount line",
        "The Autumn Sale’s promo codes expired early for customers on iPhone",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_promo_stacking_enabled went on at 11:30. iOS 7.4.1 builds the second code’s discount line with the first one’s id, and checkout-api answered those checkouts with a 500.",
        why: "7.4.2 fixes stacking but crashes on most checkouts, which is why it was paused. Resuming it would have moved more iPhones from a promo failure onto a crash. Turning stacking off fixed 7.4.1 everywhere without a new build.",
        tell: "PROMO-5004 only on iOS 7.4.1 with two codes, from 11:30, while 7.4.2’s crash report was still open.",
      },
    },
  },
  {
    slug: "wildcard-allowlist",
    title: "The wildcard that matched nothing",
    severity: "SEV2",
    opensAt: [9, 20],
    briefing:
      "App customers whose bank asks for a 3-D Secure check have been failing since 09:00: the check never opens. Web is fine. Halyard Pay, our payment provider, moved its 3DS challenge pages to a new host this morning. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.34,
      current: {
        version: "7.5.1",
        defects: [
          fails({ remoteConfig: "webview_allowed_hosts", failsWithout: "challenge.halyardpay.net" }, 0.3, "client", "SecureWebView: blocked navigation to https://challenge.halyardpay.net/3ds2/challenge (host not in webview_allowed_hosts)"),
          fails({ remoteConfig: "webview_allowed_hosts", failsWithout: "checkout.marlow.shop" }, 1, "client", "SecureWebView: blocked navigation to https://checkout.marlow.shop/pay (host not in webview_allowed_hosts)"),
        ],
      },
    },
    android: {
      share: 0.16,
      current: {
        version: "7.5.0",
        defects: [
          fails({ remoteConfig: "webview_allowed_hosts", failsWithout: "challenge.halyardpay.net" }, 0.3, "client", "SecureWebView: blocked navigation to https://challenge.halyardpay.net/3ds2/challenge (host not in webview_allowed_hosts)"),
          fails({ remoteConfig: "webview_allowed_hosts", failsWithout: "checkout.marlow.shop" }, 1, "client", "SecureWebView: blocked navigation to https://checkout.marlow.shop/pay (host not in webview_allowed_hosts)"),
        ],
      },
    },
    config: [
      key("webview_allowed_hosts", "Comma-separated hosts the in-app payment webview may open; exact host match, no patterns", "ios >= 7.0.0, android >= 7.0.0", null, 5, [
        change(-150 * DAY, "kai.nakamura", "checkout.marlow.shop", "checkout.marlow.shop,acs.halyardpay.com", "Halyard 3DS ACS (SEC-901)"),
      ]),
    ],
    isFixed: (config) => has(config("webview_allowed_hosts"), "challenge.halyardpay.net") && has(config("webview_allowed_hosts"), "checkout.marlow.shop"),
    trap: 'remote-config set webview_allowed_hosts "*"',
    view: { name: "webview-log", description: "Payment webview navigations blocked by app build" },
    lostCheckoutsPerPoint: 200,
    externals: [
      {
        id: "halyard-pay-3ds",
        status: "ok",
        facts: [
          { key: "Status page", value: "3DS challenge pages now served from challenge.halyardpay.net (since 09:00)" },
          { key: "Old host", value: "acs.halyardpay.com redirects to the new host" },
        ],
      },
    ],
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: app 3DS completions dropped." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers: “Pay spins and then says verification failed.” Their bank never shows the check. Web customers are fine." },
      { at: 70, from: "Sam Tan · Eng manager", text: "Halyard’s changelog: 3DS challenges moved to challenge.halyardpay.net at 09:00, old host redirects." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Allowlists always bite us. Set webview_allowed_hosts to * for now and we’ll tighten it after." },
      { at: 160, from: "Kai Nakamura · Security", text: "Our webview matches hosts exactly. I don’t remember it ever supporting patterns." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "A third of app payments need 3DS. ETA?" },
    ],
    hints: [
      "Only payments that need a bank check fail, on every app build. Look at what the payment webview refuses to open.",
      "Read the key’s description before you trust a pattern in it.",
      "The apps need to trust one more host, and keep every host they trust now.",
    ],
    suggestions: ["releases status", "releases webview-log", "remote-config get webview_allowed_hosts", 'remote-config set webview_allowed_hosts "*"'],
    solution: [
      {
        command:
          'remote-config set webview_allowed_hosts checkout.marlow.shop,acs.halyardpay.com,challenge.halyardpay.net --note "Halyard moved 3DS challenges to challenge.halyardpay.net"',
        why: "Every app build blocks the redirect to Halyard’s new challenge host. Adding it, and keeping the hosts already there, lets 3DS open again within about two minutes.",
      },
      { command: "releases webview-log", why: "Blocked navigations to challenge.halyardpay.net fall to zero as apps fetch the new list." },
      { command: "releases status", why: "FAILED on every app build falls toward 0%." },
      { command: "remote-config get webview_allowed_hosts", why: "Exact host match, no patterns: * would have matched no host at all, checkout.marlow.shop included." },
    ],
    postmortem: {
      question: "Why did app payments that needed 3-D Secure start failing at 09:00?",
      options: [
        "Halyard Pay’s 3DS service went down for every merchant that morning",
        "The apps’ webview allowlist lacked the host Halyard moved challenges to",
        "The allowlist was replaced by a wildcard the apps’ exact host matching couldn’t read",
        "checkout-api stopped forwarding 3DS results from the apps to Halyard",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Halyard moved its 3DS challenge pages to challenge.halyardpay.net. The apps’ payment webview only opens hosts listed in webview_allowed_hosts, and the new host wasn’t there, so the challenge was blocked.",
        why: "The list is matched host by host; * is not a pattern to it, so a wildcard would have blocked every host, the checkout page too, and failed every app payment. Adding the one new host fixed 3DS on every build without loosening the list.",
        tell: "Blocked navigations to challenge.halyardpay.net on every app build from 09:00, matching Halyard’s changelog, with web unaffected.",
      },
    },
  },
  {
    slug: "autocomplete-off-locks-address",
    title: "Turning autocomplete off locks the address form",
    severity: "SEV2",
    opensAt: [16, 45],
    briefing:
      "Android 7.5.0 customers have been crashing on the address step since about 16:00, more as its staged rollout grows. At 16:00 the apps’ address autocomplete moved to a new Places API. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.3,
      current: { version: "7.4.0" },
      previous: {
        version: "7.2.6",
        defects: [fails({ remoteConfig: "checkout_address_autocomplete", failsWhen: "off" }, 1, "client", "AddressFormView: postcode field disabled (autocomplete=off), Continue never enables")],
      },
      adoption: 0.65,
    },
    android: {
      share: 0.22,
      current: {
        version: "7.5.0",
        defects: [fails({ remoteConfig: "checkout_address_autocomplete", failsWhen: "places-v2" }, 0.6, "client", "java.lang.IllegalStateException: Places must be initialized first.")],
      },
      previous: { version: "7.4.4" },
      adoption: 0.5,
      rollout: { kind: "phased", day: 6, isPaused: false, adoptionPerSecond: 0.0003 },
    },
    config: [
      key("checkout_address_autocomplete", "Address autocomplete provider on the address step; off disables autocomplete", "ios >= 7.0.0, android >= 7.0.0", ["places-v1", "places-v2", "off"], 4, [
        change(-200 * DAY, "ana.costa", "off", "places-v1", "address autocomplete GA (AND-1802)"),
        change(-45 * MINUTE, "ana.costa", "places-v1", "places-v2", "move to Places API (New) before the v1 shutdown (AND-2290)"),
      ]),
    ],
    isFixed: (config) => config("checkout_address_autocomplete") === "places-v1",
    trap: "remote-config set checkout_address_autocomplete off",
    view: { name: "address-errors", description: "Address step crashes and dead ends by app build" },
    lostCheckoutsPerPoint: 150,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: Android crash rate up on the address step." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers say the app closes as soon as they start typing their address." },
      { at: 70, from: "Ana Costa · Android lead", text: "Autocomplete moved to places-v2 at 16:00. 7.4.4 never had the v2 client; 7.5.0 does." },
      { at: 110, from: "Ana Costa · Android lead", text: "Simplest thing: autocomplete off. People type their address by hand for an hour. No harm done." },
      { at: 160, from: "Lucas Moreau · iOS lead", text: "Off? I have a vague memory of an old iOS bug with that value. Can’t remember which build." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "7.5.0 reaches more phones every minute. Decision?" },
    ],
    hints: [
      "Only Android 7.5.0 crashes, from the minute the provider changed. What does it do with the new value?",
      "Off is a value every build reads, and an old one can read it differently. Check who would fall into that.",
      "The provider every build handled until this afternoon is in the key’s history.",
    ],
    suggestions: ["releases status", "releases address-errors", "remote-config get checkout_address_autocomplete", "remote-config set checkout_address_autocomplete off"],
    solution: [
      {
        command: 'remote-config set checkout_address_autocomplete places-v1 --note "Android 7.5.0 crashes initialising Places v2"',
        why: "Android 7.5.0 crashes on places-v2: it starts the Places client the old way. places-v1 worked on every build until 16:00 and apps fetch it within about two minutes.",
      },
      { command: "releases address-errors", why: "Crashes on 7.5.0 are Places must be initialized first.; they stop as apps fetch the change." },
      { command: "releases status", why: "FAILED on 7.5.0 falls toward 0%, and iOS 7.2.6 stays clean." },
      { command: "remote-config history checkout_address_autocomplete", why: "Off would have disabled the postcode field on iOS 7.2.6, a dead end for a third of iPhone customers." },
    ],
    postmortem: {
      question: "Why did Android 7.5.0 start crashing on the address step at 16:00?",
      options: [
        "Turning autocomplete off disabled the postcode field on the oldest iOS build",
        "places-v2 made 7.5.0 use a Places client it never initialised",
        "Google’s Places API went down for every app using it that afternoon",
        "checkout-api rejected the addresses that autocomplete filled in on Android",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_address_autocomplete moved to places-v2. Android 7.5.0 initialises the Places SDK the old way, so the new client threw IllegalStateException: Places must be initialized first. on the address step.",
        why: "Only 7.5.0 had the v2 path, so only it crashed, more as its rollout grew. Off looked harmless, but iOS 7.2.6 disables the postcode field on off, a dead end for every customer on it. places-v1 fixed 7.5.0 and broke nobody.",
        tell: "Every crash on Android 7.5.0 names Places initialisation, starting at 16:00, with 7.4.4 on the same key clean.",
      },
    },
  },
  {
    slug: "hide-express-pay",
    title: "Hiding Google Pay breaks the iPhone card form",
    severity: "SEV2",
    opensAt: [11, 52],
    briefing:
      "Google Pay on Android has failed since about 11:25. The Google Pay merchant id in remote config was changed at 11:25 during a merchant profile migration. Card payments work. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.32,
      current: { version: "7.3.4", defects: [fails({ remoteConfig: "checkout_express_pay_enabled", failsWhen: "false" }, 0.6, "client", SWIFT_INDEX)] },
    },
    android: {
      share: 0.3,
      current: {
        version: "7.4.3",
        defects: [fails({ remoteConfig: "google_pay_merchant_id", failsWhen: "BCR2DN4T7Y3LQXZ7" }, 0.45, "client", "com.google.android.gms.common.api.ApiException: 10: ")],
      },
    },
    config: [
      key("google_pay_merchant_id", "Merchant id the Android app sends in Google Pay PaymentDataRequest", "android >= 7.0.0", null, 3, [
        change(-300 * DAY, "dev.raman", "", "BCR2DN4T6Y3LQXZ7", "Google Pay production merchant (PAY-410)"),
        change(-27 * MINUTE, "dev.raman", "BCR2DN4T6Y3LQXZ7", "BCR2DN4T7Y3LQXZ7", "merchant profile migration (PAY-902)"),
      ]),
      key("checkout_express_pay_enabled", "Show Apple Pay / Google Pay on the checkout sheet", "ios >= 7.1.0, android >= 7.1.0", ["true", "false"], 12, [
        change(-40 * DAY, "jonah.reyes", "false", "true", "GA"),
      ]),
    ],
    isFixed: (config) => config("google_pay_merchant_id") === "BCR2DN4T6Y3LQXZ7",
    guard: { label: "Apple Pay and Google Pay stay on (checkout_express_pay_enabled)", isMet: (config) => config("checkout_express_pay_enabled") === "true" },
    trap: "remote-config set checkout_express_pay_enabled false",
    view: { name: "wallet-errors", description: "Wallet and card form failures by app build" },
    lostCheckoutsPerPoint: 200,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: Android wallet payments dropped." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers tapping Google Pay get an error sheet and nothing happens. Cards work." },
      { at: 70, from: "Dev Raman · Payments", text: "I updated google_pay_merchant_id at 11:25 for the profile migration. Copied it from the new console." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Just hide express pay until payments sorts it out: checkout_express_pay_enabled false. Everyone pays by card." },
      { at: 165, from: "Lucas Moreau · iOS lead", text: "iOS 7.3.4 has had express pay on since it shipped. I’m not sure anyone has tested its card-only layout." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Lunchtime peak and Google Pay is a third of Android. Plan?" },
    ],
    hints: [
      "Only one way of paying fails, on one platform, from the minute one value changed. Compare the old and new values.",
      "Hiding a button changes the screen for every app that reads that key. Check what those apps show instead.",
      "The id that worked for three hundred days is in the key’s history.",
    ],
    suggestions: ["releases status", "releases wallet-errors", "remote-config history google_pay_merchant_id", "remote-config set checkout_express_pay_enabled false"],
    solution: [
      {
        command: 'remote-config set google_pay_merchant_id BCR2DN4T6Y3LQXZ7 --note "11:25 id has a typo (7 for 6): Google Pay DEVELOPER_ERROR"',
        why: "Google Pay fails with status 10, a developer error, since the id changed; the new id differs from the old one by one character. The old id brings Google Pay back within about two minutes.",
      },
      { command: "releases wallet-errors", why: "ApiException: 10 on Android 7.4.3 falls to zero as apps fetch the old id." },
      { command: "releases status", why: "FAILED on Android 7.4.3 falls toward 0%, and iOS 7.3.4 stays clean." },
      { command: "remote-config get checkout_express_pay_enabled", why: "Still true. False would have sent iOS 7.3.4 to a card-only layout that crashes with Index out of range." },
    ],
    postmortem: {
      question: "Why did Google Pay on Android start failing at 11:25?",
      options: [
        "Hiding express pay sent iOS 7.3.4 to a card-only layout it couldn’t draw",
        "The migrated merchant id had a typo, so Google Pay refused requests",
        "Google Pay had an outage for every merchant during the lunchtime peak",
        "Android 7.4.3 shipped a Google Pay button that never opened the payment sheet",
      ],
      answerIndex: 1,
      explanation: {
        cause: "google_pay_merchant_id was changed at 11:25 to an id with one wrong character. Google Pay refused the PaymentDataRequest with status code 10 (DEVELOPER_ERROR) for every Android customer who chose it.",
        why: "Hiding express pay looked like a safe fallback, but iOS 7.3.4’s card-only layout crashes, so it would have traded an Android wallet failure for iPhone crashes. Restoring the old id fixed Google Pay and touched nothing else.",
        tell: "ApiException: 10 on Google Pay only, from 11:25, with the new id one character off the one that had worked for months.",
      },
    },
  },
  {
    slug: "payment-sheet-web-fallback",
    title: "The web fallback is plain HTTP",
    severity: "SEV2",
    opensAt: [14, 3],
    briefing:
      "Since about 13:15, iPhone customers whose bank asks for a 3-D Secure check fail at Pay. At 13:15 the apps moved to HalyardSheet 5, the payment provider’s new native card sheet. Android and web look fine. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.3,
      current: {
        version: "7.5.0",
        defects: [fails({ remoteConfig: "checkout_payment_sheet", failsWhen: "halyard-sheet-5" }, 0.4, "client", "HalyardSheet: 3DS2 challenge failed: transStatus=U (messageVersion 2.3.1 not supported by ACS)")],
      },
    },
    android: {
      share: 0.22,
      current: { version: "7.5.0", defects: [fails({ remoteConfig: "checkout_payment_sheet", failsWhen: "web-fallback" }, 1, "client", "net::ERR_CLEARTEXT_NOT_PERMITTED")] },
      previous: { version: "7.4.2", defects: [fails({ remoteConfig: "checkout_payment_sheet", failsWhen: "web-fallback" }, 1, "client", "net::ERR_CLEARTEXT_NOT_PERMITTED")] },
      adoption: 0.6,
    },
    config: [
      key("checkout_payment_sheet", "Card entry on the apps: Halyard native sheet 4 or 5, or the hosted web form", "ios >= 7.2.0, android >= 7.2.0", ["halyard-sheet-4", "halyard-sheet-5", "web-fallback"], 6, [
        change(-180 * DAY, "dev.raman", "web-fallback", "halyard-sheet-4", "native card sheet GA (PAY-602)"),
        change(-48 * MINUTE, "dev.raman", "halyard-sheet-4", "halyard-sheet-5", "HalyardSheet 5 with native 3DS2 challenges (PAY-940)"),
      ]),
    ],
    isFixed: (config) => config("checkout_payment_sheet") === "halyard-sheet-4",
    trap: "remote-config set checkout_payment_sheet web-fallback",
    view: { name: "card-errors", description: "Card payment failures by app build" },
    lostCheckoutsPerPoint: 150,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: iOS card payments dropped." },
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers: “Your bank couldn’t verify this payment.” Cards that skip the bank check go through." },
      { at: 70, from: "Dev Raman · Payments", text: "HalyardSheet 5 went live at 13:15 for both apps. Their docs say 3DS2 2.3.1, and some banks only speak 2.2." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "web-fallback is the safest option: the hosted form works everywhere. Flip it and debug Halyard later." },
      { at: 165, from: "Ana Costa · Android lead", text: "When did anyone last load web-fallback on Android? It points at the old pay.marlow.shop URL, and that was never https." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "We’re losing iPhone card payments by the minute. Decision?" },
    ],
    hints: [
      "Only iPhone payments that need a bank check fail, starting with this afternoon’s sheet change.",
      "The fallback is a page loaded inside the app. Ask whether every platform will still load it.",
      "The sheet both apps ran without trouble until this afternoon is in the key’s history.",
    ],
    suggestions: ["releases status", "releases card-errors", "remote-config history checkout_payment_sheet", "remote-config set checkout_payment_sheet web-fallback"],
    solution: [
      {
        command: 'remote-config set checkout_payment_sheet halyard-sheet-4 --note "Sheet 5 3DS2 2.3.1 fails on 2.2-only ACS for iOS"',
        why: "iOS 3DS challenges fail on HalyardSheet 5, which went live at 13:15. Sheet 4 handled them on every build until then; apps fetch it within about two minutes.",
      },
      { command: "releases card-errors", why: "iOS 7.5.0 reports transStatus=U from banks without 2.3.1; the failures stop as apps fetch the change." },
      { command: "releases status", why: "FAILED on iOS 7.5.0 falls toward 0%, and both Android builds stay clean." },
      { command: "remote-config get checkout_payment_sheet", why: "halyard-sheet-4. web-fallback would have loaded a cleartext URL Android blocks: net::ERR_CLEARTEXT_NOT_PERMITTED on every card payment." },
    ],
    postmortem: {
      question: "Why did iPhone 3-D Secure payments start failing at 13:15?",
      options: [
        "The hosted web form loaded over plain HTTP, which Android refuses to open",
        "HalyardSheet 5 sent a 3DS2 version that some banks’ servers don’t support",
        "Halyard Pay’s 3DS servers went down for every merchant that afternoon",
        "iOS 7.5.0 shipped a card form that never sends the card number to the provider",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_payment_sheet moved to halyard-sheet-5 at 13:15. On iOS it starts 3DS2 challenges at message version 2.3.1, and banks whose ACS only supports 2.2 answer transStatus=U, so the payment fails.",
        why: "The hosted web fallback looked universal, but it still points at a plain-HTTP URL, and Android blocks cleartext in its webview: every Android card payment would have failed. Going back to sheet 4 fixed iOS and left Android alone.",
        tell: "transStatus=U only on iOS 7.5.0, only for 3DS payments, from 13:15; and an Android lead pointing out the fallback URL was never https.",
      },
    },
  },
  {
    slug: "token-refresh-legacy",
    title: "Back to the legacy token refresh",
    severity: "SEV2",
    opensAt: [10, 6],
    briefing:
      "Since about 09:15 Android customers get signed out at checkout and lose their basket. At 09:15 security switched the apps to rotating refresh tokens. iPhone and web are fine. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.3,
      current: { version: "7.6.0", defects: [fails({ remoteConfig: "auth_refresh_strategy", failsWhen: "legacy" }, 0.9, "client", "POST /oauth/legacy/refresh 404 Not Found")] },
    },
    android: {
      share: 0.28,
      current: {
        version: "7.6.1",
        defects: [
          fails({ remoteConfig: "auth_refresh_strategy", failsWhen: "rotating" }, 0.35, "client", '{"error":"invalid_grant","error_description":"refresh token already used"}'),
          fails({ remoteConfig: "auth_refresh_strategy", failsWhen: "legacy" }, 0.9, "client", "POST /oauth/legacy/refresh 404 Not Found"),
        ],
      },
    },
    config: [
      key("auth_refresh_strategy", "How the apps refresh access tokens: rotating (one-time refresh tokens), sliding, or legacy (/oauth/legacy/refresh)", "ios >= 7.0.0, android >= 7.0.0", ["rotating", "sliding", "legacy"], 5, [
        change(-400 * DAY, "kai.nakamura", "legacy", "sliding", "sliding sessions (SEC-640); legacy endpoint deprecated"),
        change(-51 * MINUTE, "kai.nakamura", "sliding", "rotating", "refresh-token rotation (SEC-1022)"),
      ]),
    ],
    isFixed: (config) => config("auth_refresh_strategy") === "sliding",
    trap: "remote-config set auth_refresh_strategy legacy",
    view: { name: "auth-errors", description: "Sign-in and token refresh failures at checkout by app build" },
    lostCheckoutsPerPoint: 150,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: Android sign-outs at checkout." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers get “Please sign in again” at Pay and their basket is empty afterwards." },
      { at: 70, from: "Kai Nakamura · Security", text: "Rotation went on at 09:15: each refresh token works once. It’s required for the audit next week." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Put it back to legacy, the setting we had for years. We know it works." },
      { at: 160, from: "Omar Farouk · Infra", text: "Legacy as in /oauth/legacy/refresh? I removed that route in the gateway clean-up last month." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Sign-outs at checkout are the worst kind. Plan?" },
    ],
    hints: [
      "Only Android signs people out, from the minute the refresh scheme changed. Read what the auth server says to it.",
      "“What we had for years” and “what we had until this morning” are different values. Check the key’s history.",
      "Pick the scheme every app handled until 09:15.",
    ],
    suggestions: ["releases status", "releases auth-errors", "remote-config history auth_refresh_strategy", "remote-config set auth_refresh_strategy legacy"],
    solution: [
      {
        command: 'remote-config set auth_refresh_strategy sliding --note "Android 7.6.1 refreshes twice in parallel: invalid_grant under rotation"',
        why: "Android 7.6.1 sometimes refreshes twice at once; under rotation the second use is refused and the customer is signed out. Sliding worked on every build until 09:15.",
      },
      { command: "releases auth-errors", why: "invalid_grant (refresh token already used) on Android 7.6.1; it stops as apps fetch the change." },
      { command: "releases status", why: "FAILED on Android 7.6.1 falls toward 0%, and iOS stays clean." },
      { command: "remote-config history auth_refresh_strategy", why: "Legacy was replaced 400 days ago and its endpoint is gone: it would have signed out iPhone customers too." },
    ],
    postmortem: {
      question: "Why were Android customers signed out at checkout after 09:15?",
      options: [
        "The legacy refresh endpoint was removed, so every app’s refresh failed",
        "Under rotation, Android 7.6.1’s parallel refreshes reused a spent token",
        "The auth server expired every Android session at once during a key rotation",
        "checkout-api stopped accepting access tokens issued to the Android app",
      ],
      answerIndex: 1,
      explanation: {
        cause: "auth_refresh_strategy moved to rotating at 09:15. Android 7.6.1 can fire two refreshes at once; with one-time refresh tokens the second was answered invalid_grant, and the app signed the customer out.",
        why: "iOS refreshes one at a time, so only Android broke. Legacy, the value from years ago, pointed at an endpoint infra had removed: every app would have failed to refresh. Sliding, the scheme in place until this morning, stopped the sign-outs while the Android race gets fixed.",
        tell: "invalid_grant with “refresh token already used” only from Android 7.6.1, starting at 09:15.",
      },
    },
  },
  {
    slug: "quote-ttl-zero",
    title: "Zero doesn’t mean forever on old builds",
    severity: "SEV2",
    opensAt: [18, 4],
    briefing:
      "Since about 17:30, app checkouts fail with a 500 when the customer takes more than a minute between basket and Pay. At 17:30 ops cut the apps’ price-quote lifetime for the flash sale. Web refreshes quotes on its own and is fine. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.36,
      current: { version: "7.4.0", defects: [fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "60" }, 0.35, "server", serverError("QUOTE-5009", "quote expired before checkout"))] },
      previous: {
        version: "7.3.1",
        defects: [
          fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "60" }, 0.35, "server", serverError("QUOTE-5009", "quote expired before checkout")),
          fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "0" }, 1, "server", serverError("QUOTE-5009", "quote expired before checkout")),
        ],
      },
      adoption: 0.4,
      rollout: { kind: "phased", day: 4, isPaused: false, adoptionPerSecond: 0.0001 },
    },
    android: {
      share: 0.14,
      current: { version: "7.4.0", defects: [fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "60" }, 0.35, "server", serverError("QUOTE-5009", "quote expired before checkout"))] },
      previous: {
        version: "7.3.0",
        defects: [
          fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "60" }, 0.35, "server", serverError("QUOTE-5009", "quote expired before checkout")),
          fails({ remoteConfig: "checkout_quote_ttl_seconds", failsWhen: "0" }, 1, "server", serverError("QUOTE-5009", "quote expired before checkout")),
        ],
      },
      adoption: 0.7,
    },
    config: [
      key("checkout_quote_ttl_seconds", "Seconds an app holds a price quote before checkout; 7.4.0 and later read 0 as no expiry", "ios >= 7.0.0, android >= 7.0.0", null, 8, [
        change(-180 * DAY, "ops-bot", "600", "900", "longer holds for slow payment sheets (OPS-41)"),
        change(-34 * MINUTE, "mira.santos", "900", "60", "flash sale: short quote holds so stock frees up (OPS-77)"),
      ]),
    ],
    isFixed: (config) => config("checkout_quote_ttl_seconds") === "900",
    trap: "remote-config set checkout_quote_ttl_seconds 0",
    view: { name: "quote-errors", description: "Checkouts failed on an expired price quote by app build" },
    lostCheckoutsPerPoint: 150,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 2% for 5m on QUOTE-5009. Mobile on-call paged: app traffic only." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers who stop to compare sizes get “Something went wrong” at Pay. Quick buyers are fine." },
      { at: 70, from: "Mira Santos · Ops", text: "I set the quote hold to 60 s at 17:30 so flash-sale stock frees up faster. Is that it?" },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Set it to 0. The description says 0 means no expiry. Nobody’s quote expires, problem solved." },
      { at: 160, from: "Lucas Moreau · iOS lead", text: "The no-expiry rule came in 7.4.0. Most iPhones aren’t on 7.4.0 yet." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Flash sale ends at seven. Where are we?" },
    ],
    hints: [
      "Only slow checkouts fail, on every app build, from the minute a lifetime changed.",
      "Read the key’s description to the end: which builds does the special value apply to?",
      "The lifetime every build handled until this evening is in the key’s history.",
    ],
    suggestions: ["releases status", "releases quote-errors", "remote-config get checkout_quote_ttl_seconds", "remote-config set checkout_quote_ttl_seconds 0"],
    solution: [
      {
        command: 'remote-config set checkout_quote_ttl_seconds 900 --note "60 s expires quotes mid-checkout: QUOTE-5009"',
        why: "With a 60 s hold, any customer slower than a minute reaches Pay with an expired quote and checkout-api answers 500. 900 worked on every build until 17:30.",
      },
      { command: "releases quote-errors", why: "QUOTE-5009 on every app build falls to zero as apps fetch the change." },
      { command: "releases status", why: "FAILED falls toward 0% on all four app builds." },
      { command: "remote-config history checkout_quote_ttl_seconds", why: "0 means no expiry only on 7.4.0 and later; on 7.3.x it means already expired, every checkout." },
    ],
    postmortem: {
      question: "Why did slow app checkouts start failing at 17:30?",
      options: [
        "A zero quote lifetime made every checkout on 7.3.x builds expire at once",
        "The quote hold was cut to 60 s, shorter than many customers take to pay",
        "checkout-api’s flash-sale stock check rejected every order from the apps",
        "The apps stopped refreshing their price quotes after the flash sale started",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_quote_ttl_seconds went from 900 to 60 at 17:30. Any app customer who took more than a minute reached Pay with an expired quote, and checkout-api answered it with a 500.",
        why: "Web refreshes its quote before paying, so only the apps broke. 0 means no expiry only from 7.4.0; iOS 7.3.1 and Android 7.3.0, most of the installed base, treat it as already expired, so every one of their checkouts would have failed. 900 restored the old behaviour everywhere.",
        tell: "QUOTE-5009 on every app build, only for checkouts slower than a minute, from 17:30.",
      },
    },
  },
  {
    slug: "cart-sync-off-stale-prices",
    title: "Cart sync off sends stale prices",
    severity: "SEV2",
    opensAt: [19, 37],
    briefing:
      "Since about 19:00, iPhone customers fail at Pay with “Your basket couldn’t be updated”. At 19:00 the apps moved cart sync from polling to a realtime websocket. Android and web look fine. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: {
      share: 0.34,
      current: { version: "7.5.2", defects: [fails({ remoteConfig: "cart_sync_mode", failsWhen: "realtime" }, 0.4, "client", 'Error Domain=NSPOSIXErrorDomain Code=57 "Socket is not connected"')] },
    },
    android: {
      share: 0.22,
      current: { version: "7.5.1", defects: [fails({ remoteConfig: "cart_sync_mode", failsWhen: "off" }, 1, "server", serverError("PRICE-5003", "cart line price does not match catalog"))] },
      previous: { version: "7.4.4", defects: [fails({ remoteConfig: "cart_sync_mode", failsWhen: "off" }, 1, "server", serverError("PRICE-5003", "cart line price does not match catalog"))] },
      adoption: 0.7,
    },
    config: [
      key("cart_sync_mode", "How the apps keep the basket in step with the server: realtime (websocket), poll (every 30 s) or off (local basket only)", "ios >= 7.2.0, android >= 7.2.0", ["realtime", "poll", "off"], 4, [
        change(-60 * DAY, "jonah.reyes", "off", "poll", "server-side baskets (MOB-1320)"),
        change(-37 * MINUTE, "jonah.reyes", "poll", "realtime", "websocket cart sync GA (MOB-1502)"),
      ]),
    ],
    isFixed: (config) => config("cart_sync_mode") === "poll",
    trap: "remote-config set cart_sync_mode off",
    view: { name: "cart-errors", description: "Basket sync and checkout failures by app build" },
    lostCheckoutsPerPoint: 150,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 5% for 5m; checkout-api 5xx 0.0%. Mobile on-call paged: iOS basket errors." },
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers: “Your basket couldn’t be updated” at Pay, especially on trains and lifts." },
      { at: 70, from: "Jonah Reyes · Mobile lead", text: "Realtime cart sync went GA at 19:00. Android reconnects on its own; iOS 7.5.2 doesn’t seem to." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "Let’s turn cart sync off. The apps keep the basket locally like they used to. Less moving parts." },
      { at: 160, from: "Priya Shah · Web lead", text: "Local baskets keep the price from when the item was added. Tonight’s price drop changed half the catalog at 19:00." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Evening peak. ETA?" },
    ],
    hints: [
      "Only iPhone baskets fail, on flaky connections, since the sync mode changed.",
      "Before you go back to a mode from months ago, ask what the server checks at Pay now.",
      "The mode both apps ran without trouble until tonight is in the key’s history.",
    ],
    suggestions: ["releases status", "releases cart-errors", "remote-config history cart_sync_mode", "remote-config set cart_sync_mode off"],
    solution: [
      {
        command: 'remote-config set cart_sync_mode poll --note "iOS 7.5.2 never reconnects the cart websocket"',
        why: "iOS 7.5.2 loses its basket websocket on a flaky connection and never reconnects. Polling worked on every build until 19:00; apps fetch it within about two minutes.",
      },
      { command: "releases cart-errors", why: "Socket is not connected on iOS 7.5.2 falls to zero as apps fetch the change." },
      { command: "releases status", why: "FAILED on iOS 7.5.2 falls toward 0%, and both Android builds stay clean." },
      { command: "remote-config history cart_sync_mode", why: "Off predates server-side baskets: local prices would fail checkout-api’s price check on every Android order tonight." },
    ],
    postmortem: {
      question: "Why did iPhone checkouts start failing at 19:00?",
      options: [
        "Local baskets kept old prices that checkout-api’s price check rejected",
        "Realtime cart sync on iOS 7.5.2 never reconnected after a dropped socket",
        "The price drop at 19:00 corrupted every basket stored on Marlow’s servers",
        "checkout-api started refusing websocket connections from every app build",
      ],
      answerIndex: 1,
      explanation: {
        cause: "cart_sync_mode moved to realtime at 19:00. On a flaky connection iOS 7.5.2’s basket websocket dropped and the app never reconnected, so Pay found the basket out of step and failed.",
        why: "Android reconnects, so only iOS broke. Off looked simpler, but local baskets keep the price from when the item was added, and with tonight’s price drop every Android order would have failed checkout-api’s price check. Polling, the mode until tonight, fixed iOS and left Android alone.",
        tell: "Socket is not connected only on iOS 7.5.2, starting at 19:00, with Android on the same key clean.",
      },
    },
  },
  {
    slug: "resume-android-cronet",
    title: "Resuming the Android rollout that has the fix",
    severity: "SEV2",
    opensAt: [17, 12],
    briefing:
      "Since about 16:30, Android customers who split their order across two delivery addresses fail at Pay. Android 7.6.0 fixes split shipping, but its staged rollout was halted on Friday. Almost every Android phone runs 7.5.3. You’re the mobile on-call.",
    roleBriefing: MOBILE_BRIEFING,
    ios: { share: 0.2, current: { version: "7.5.3" } },
    android: {
      share: 0.32,
      current: {
        version: "7.6.0",
        defects: [fails({ remoteConfig: "android_http_transport", failsWhen: "cronet" }, 0.85, "client", "org.chromium.net.QuicException: Exception in BidirectionalStream: net::ERR_QUIC_PROTOCOL_ERROR")],
      },
      previous: {
        version: "7.5.3",
        defects: [fails({ remoteConfig: "checkout_split_shipping_enabled", failsWhen: "true" }, 0.5, "server", serverError("SHIP-5011", "shipments[1].address_id not on order"))],
      },
      adoption: 0.02,
      rollout: { kind: "phased", day: 3, isPaused: true, adoptionPerSecond: 0.0016 },
    },
    config: [
      key("checkout_split_shipping_enabled", "Let customers send items in one order to two addresses", "ios >= 7.5.0, android >= 7.5.0", ["true", "false"], 2, [
        change(-42 * MINUTE, "mira.santos", "false", "true", "gift season: split shipping for everyone (OPS-90)"),
      ]),
      key("android_http_transport", "HTTP stack in Android 7.6.0 and later: cronet (QUIC) or okhttp", "android >= 7.6.0", ["cronet", "okhttp"], 1, [
        change(-9 * DAY, "ana.costa", "okhttp", "cronet", "Cronet with QUIC for 7.6.0 (AND-2455)"),
      ]),
    ],
    isFixed: (config) => config("checkout_split_shipping_enabled") === "false",
    guard: {
      label: "No customer is rolled onto Android 7.6.0 while it fails on Cronet",
      isMet: (config, state) => isPaused(state, "android") || config("android_http_transport") !== "cronet",
    },
    trap: "releases resume android 7.6.0",
    view: { name: "android-errors", description: "Checkout failures and network errors by app build" },
    lostCheckoutsPerPoint: 250,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout 5xx or loss > 5% for 5m. Mobile on-call paged: the 500s come from Android 7.5.3." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers sending part of an order to a second address get “Something went wrong”. One address works." },
      { at: 70, from: "Mira Santos · Ops", text: "Split shipping went on for everyone at 16:30 for gift season. iPhone handles it fine." },
      { at: 110, from: "Jonah Reyes · Mobile lead", text: "7.6.0 has the split-shipping fix. Ana halted it Friday, but just resume the rollout and the fix goes out." },
      { at: 160, from: "Ana Costa · Android lead", text: "I halted 7.6.0 because Cronet was failing requests over QUIC on some carriers. I never found out why." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Gift season traffic is only going up tonight. Plan?" },
    ],
    hints: [
      "Only customers with two delivery addresses fail, on the Android build most people run. What turned that on?",
      "Before you spread a build, read what it is doing on the phones that already have it.",
      "You can switch the new shipping option off on the phones that have it today, without any new build.",
    ],
    suggestions: ["releases status android", "releases android-errors", "remote-config history checkout_split_shipping_enabled", "releases resume android 7.6.0"],
    solution: [
      {
        command: 'remote-config set checkout_split_shipping_enabled false --note "Android 7.5.3 SHIP-5011 on split orders; 7.6.0 still failing on Cronet"',
        why: "Android 7.5.3 fails split-shipping orders, which went on at 16:30. Off stops the 500s on every installed 7.5.3 within about two minutes.",
      },
      { command: "releases android-errors", why: "7.5.3 fails with SHIP-5011, and the few phones on 7.6.0 fail most checkouts with ERR_QUIC_PROTOCOL_ERROR." },
      { command: "releases status android", why: "7.6.0 stays HALTED. Resuming it would trade a split-shipping error for a network failure on far more phones." },
      { command: "remote-config history checkout_split_shipping_enabled", why: "Turned on for gift season at 16:30; your change is now the newest version." },
    ],
    postmortem: {
      question: "Why did Android split-shipping orders start failing at 16:30?",
      options: [
        "Android 7.6.0’s rollout was halted, so customers couldn’t get the fixed build",
        "Split shipping went on for Android 7.5.3, which sends a bad second address",
        "Cronet’s QUIC traffic was dropped by carriers for every Android customer",
        "checkout-api rejected every order with more than one shipment from any client",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_split_shipping_enabled went on at 16:30. Android 7.5.3 sends the second shipment with an address id that isn’t on the order, and checkout-api answered those checkouts with a 500.",
        why: "7.6.0 fixes split shipping but fails most checkouts over Cronet’s QUIC, which is why it was halted. Resuming it would have moved more phones from a split-shipping failure onto a network failure. Turning split shipping off fixed 7.5.3 everywhere without a new build.",
        tell: "SHIP-5011 only from Android 7.5.3 on split orders, from 16:30, while 7.6.0’s few phones were failing on QUIC.",
      },
    },
  },
];

export const MOBILE_TIER3_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
