import type { Role } from "../../domain/incident.ts";
import type { CommsMessage, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { configValue, findConfig, findPlatform, type ClientBuild, type ClientDefect, type DefectTrigger, type Platform, type RemoteConfigEntry } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const MINUTE = 60;
const ROLE: Role = "mobile";
const DISPLAY_NAME = { ios: "iOS", android: "Android" } as const;

type AppPlatform = "ios" | "android";

/** A remote-config key published shortly before the page; `to` is what it holds now. */
type ConfigEdit = {
  readonly key: string;
  readonly description: string;
  readonly readBy: string;
  readonly allowed: readonly string[] | null;
  readonly by: string;
  readonly minutesAgo: number;
  readonly from: string;
  readonly to: string;
  readonly note: string;
};

/** One app build on a platform: fully released, or in a store rollout that is still spreading from `previous`. */
type Release = {
  readonly version: string;
  readonly rollout?: { readonly previous: string; readonly adoption: number; readonly day: number; readonly adoptionPerSecond: number };
};

/** One slice of the failing build's checkouts in the incident's release view; failing slices together are the defect's reach. */
type Bucket = { readonly label: string; readonly share: number; readonly isFailing?: true };

/**
 * A tier-2 mobile incident: several remote-config keys changed this hour and two app builds are live
 * or rolling out. One key (the culprit) breaks a slice of one platform's checkouts; a release view
 * and the error text single it out, and reverting the key fixes phones that already have the build.
 */
type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly briefing: string;
  readonly roleBriefing: string;
  /** The platform whose current build carries the defect. */
  readonly platform: AppPlatform;
  readonly shares: Readonly<Record<AppPlatform, number>>;
  readonly releases: Readonly<Record<AppPlatform, Release>>;
  /** `to` is the value that breaks checkout; the fix publishes `from` again. */
  readonly culprit: ConfigEdit;
  /** For a comma-separated list key: the build fails while the list lacks this entry, instead of while it equals `to`. */
  readonly failsWithout?: string;
  readonly decoys: readonly ConfigEdit[];
  /** "server": checkout-api answers 500. "client": checkout dies in the app, so the pager watches checkout loss. */
  readonly where: "server" | "client";
  readonly message: string;
  readonly view: { readonly name: string; readonly description: string; readonly dimension: string; readonly buckets: readonly Bucket[] };
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly fixNote: string;
  readonly why: { readonly view: string; readonly history: string; readonly fix: string; readonly halt?: string; readonly status: string };
  readonly postmortem: Postmortem;
};

const DEFAULT_HALT_WHY = "Stops the store offering this build to anyone new until a fixed one ships. On its own it fixes nobody who already updated.";

function iosBuildNumber(version: string): number {
  return Number(version.split(".").join("")) * 10 + 1;
}

function clientBuild(platform: AppPlatform, version: string, defects?: readonly ClientDefect[]): ClientBuild {
  return {
    version,
    userAgent: platform === "ios" ? iosUserAgent(version, iosBuildNumber(version)) : androidUserAgent(version),
    timeoutMs: platform === "ios" ? 10_000 : 30_000,
    retry: NO_RETRY,
    ...(defects ? { defects } : {}),
  };
}

function platformSetup(platform: AppPlatform, share: number, release: Release, defects?: readonly ClientDefect[]): Partial<Omit<Platform, "id">> {
  const current = clientBuild(platform, release.version, defects);
  const { rollout } = release;
  if (!rollout) return { customerShare: share, current, previous: null, adoption: 1, rollout: { kind: "instant" }, inReview: null };
  return {
    customerShare: share,
    current,
    previous: clientBuild(platform, rollout.previous),
    adoption: rollout.adoption,
    rollout: { kind: "phased", day: rollout.day, isPaused: false, adoptionPerSecond: rollout.adoptionPerSecond },
    inReview: null,
  };
}

function asConfig(edit: ConfigEdit): RemoteConfigEntry {
  return {
    key: edit.key,
    description: edit.description,
    readBy: edit.readBy,
    allowed: edit.allowed,
    baseVersion: 3 + ((edit.key.length * 7) % 40),
    history: [{ at: -edit.minutesAgo * MINUTE, by: edit.by, from: edit.from, to: edit.to, note: edit.note }],
  };
}

function failShare(row: Row): number {
  return row.view.buckets.reduce((sum, bucket) => sum + (bucket.isFailing ? bucket.share : 0), 0);
}

function trigger(row: Row): DefectTrigger {
  return row.failsWithout ? { remoteConfig: row.culprit.key, failsWithout: row.failsWithout } : { remoteConfig: row.culprit.key, failsWhen: row.culprit.to };
}

function isBreaking(row: Row, value: string): boolean {
  if (row.failsWithout) return !value.split(",").some((entry) => entry.trim() === row.failsWithout);
  return value === row.culprit.to;
}

/** Share of all checkout customers the defect reaches when the incident opens. */
function initialReach(row: Row): number {
  return row.shares[row.platform] * (row.releases[row.platform].rollout?.adoption ?? 1) * failShare(row);
}

function pageText(row: Row): string {
  return row.where === "server"
    ? `${row.severity} triggered — checkout-api 5xx > 2% for 5m, all from app user agents. Mobile on-call paged.`
    : `${row.severity} triggered — checkout loss > 5% for 3m; checkout-api 5xx 0.0%. App telemetry points at mobile; mobile on-call paged.`;
}

function isHalted(state: ClusterState, platform: AppPlatform): boolean {
  const found = state.commerce && findPlatform(state.commerce, platform);
  return found?.rollout.kind === "phased" && found.rollout.isPaused;
}

function incident(row: Row): Scenario {
  const id = `mob-t2-${row.slug}`;
  const defectTrigger = trigger(row);
  const release = row.releases[row.platform];
  const name = DISPLAY_NAME[row.platform];
  const other: AppPlatform = row.platform === "ios" ? "android" : "ios";
  const otherRelease = row.releases[other];
  const firstDecoy = row.decoys[0];

  const view = (state: ClusterState): readonly string[] => {
    const commerce = state.commerce;
    const platform = commerce && findPlatform(commerce, row.platform);
    if (!commerce || !platform) return [];
    const firing = triggerShare(defectTrigger, commerce, state.t);
    const checkouts = commerce.pulse.organicCheckoutsPerSecond * platform.customerShare * platform.adoption * WINDOW_SECONDS;
    const rows = row.view.buckets.map((bucket) => {
      const failed = bucket.isFailing ? firing : 0;
      const started = checkouts * bucket.share;
      return [bucket.label, percent(bucket.share, 0), count(started), percent(failed), count(started * (1 - failed))];
    });
    return [
      `Marlow ${name} ${release.version} · ${row.view.description} · app telemetry, last 5 min`,
      ...table([[row.view.dimension, "SHARE", "CHECKOUTS", "FAILED", "ORDERS OK"], ...rows]),
      firing * failShare(row) > 0.001 ? `Top checkout error on ${release.version}: ${row.message}` : `Top checkout error on ${release.version}: none in the last 5 min`,
    ];
  };

  const solution: SolutionStep[] = [
    { command: `releases ${row.view.name}`, why: row.why.view },
    { command: `remote-config history ${row.culprit.key}`, why: row.why.history },
    { command: `remote-config set ${row.culprit.key} ${row.culprit.from} --note "${row.fixNote}"`, why: row.why.fix },
    ...(release.rollout ? [{ command: `releases halt ${row.platform} ${release.version}`, why: row.why.halt ?? DEFAULT_HALT_WHY }] : []),
    { command: `releases status ${row.platform}`, why: row.why.status },
  ];

  const objectives = release.rollout
    ? (state: ClusterState): readonly Objective[] => [
        { role: ROLE, label: `${name} ${release.version}’s rollout is halted until a fixed build ships`, isMet: isHalted(state, row.platform) },
      ]
    : undefined;

  return {
    id,
    tier: 2,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: [ROLE],
    roleBriefings: { [ROLE]: row.roleBriefing },
    suggestions: {
      [ROLE]: [
        "releases status",
        "remote-config list",
        `releases ${row.view.name}`,
        `remote-config history ${firstDecoy.key}`,
        `remote-config set ${firstDecoy.key} ${firstDecoy.from}`,
        ...(otherRelease.rollout ? [`releases halt ${other} ${otherRelease.version}`] : []),
      ],
    },
    evidence: [{ tool: "releases", name: row.view.name, description: row.view.description, run: view }],
    opensAtSecondOfDay: row.opensAt[0] * 3600 + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [{ number: 9, tag: "v4.13.2", changeCause: "v4.13.2 /v3/checkout for app clients", traits: [] }],
        revision: 9,
        podsStartedAgo: 2 * 24 * 3600,
        commerce: checkoutCommerce({
          platforms: {
            web: { customerShare: 1 - row.shares.ios - row.shares.android },
            [row.platform]: platformSetup(row.platform, row.shares[row.platform], release, [
              { trigger: defectTrigger, failShare: failShare(row), where: row.where, message: row.message },
            ]),
            [other]: platformSetup(other, row.shares[other], otherRelease),
          },
          remoteConfig: [asConfig(row.culprit), ...row.decoys.map(asConfig), ...SHOP_REMOTE_CONFIG],
        }),
      }),
    isRootCauseFixed: (state) => {
      const entry = state.commerce && findConfig(state.commerce, row.culprit.key);
      return !!entry && !isBreaking(row, configValue(entry));
    },
    ...(objectives ? { objectives } : {}),
    ...(row.where === "client"
      ? { alertMetric: { label: "checkout loss", rate: (state: ClusterState) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) } }
      : {}),
    // The revert lands ~36 s in and takes ~120 s to reach every phone: roughly 12,000 × reach checkouts lost, under ten points.
    lostCheckoutsPerPoint: Math.max(50, Math.round(initialReach(row) * 1500)),
    externals: [],
    comms: [{ at: 0, from: "PagerDuty", text: pageText(row) }, ...row.comms],
    hints: row.hints,
    solution: { [ROLE]: solution },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "android-cleartext-vault",
    title: "Android card payments die in the app",
    severity: "SEV2",
    opensAt: [9, 42],
    briefing:
      "Since about 09:15, Android customers paying by card can’t get past Pay, and checkout-api sees nothing wrong. Android 7.4.0 is halfway through a staged rollout and three remote-config keys changed this morning. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find which change broke card payments before you touch anything, then stop it spreading.",
    platform: "android",
    shares: { ios: 0.3, android: 0.34 },
    releases: { android: { version: "7.4.0", rollout: { previous: "7.3.2", adoption: 0.42, day: 6, adoptionPerSecond: 0.0004 } }, ios: { version: "7.3.2" } },
    culprit: {
      key: "checkout_card_vault_url",
      description: "Base URL the card form tokenises card numbers against",
      readBy: "android >= 7.4.0",
      allowed: null,
      by: "tomas.lind",
      minutesAgo: 26,
      from: "https://vault.marlow.shop/v1",
      to: "http://vault-edge.marlow.shop/v1",
      note: "point Android at the new vault edge (PAY-881)",
    },
    decoys: [
      { key: "checkout_gift_message_enabled", description: "Gift message box on the review step", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "hana.sato", minutesAgo: 11, from: "false", to: "true", note: "gift messages GA (GRW-430)" },
      { key: "search_autocomplete_limit", description: "Suggestions shown under the search box", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: null, by: "dev.raman", minutesAgo: 48, from: "8", to: "12", note: "more suggestions (SRCH-330)" },
    ],
    where: "client",
    message: "java.net.UnknownServiceException: CLEARTEXT communication to vault-edge.marlow.shop not permitted by network security policy",
    view: {
      name: "payment-methods",
      description: "checkouts by payment method",
      dimension: "METHOD",
      buckets: [
        { label: "Card (new or saved)", share: 0.64, isFailing: true },
        { label: "Google Pay", share: 0.24 },
        { label: "PayPal", share: 0.12 },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers say tapping Pay with a card spins, then “Payment couldn’t start”. Google Pay works for them." },
      { at: 70, from: "Ana Costa · Android lead", text: "Play has 7.4.0 at 50% of the staged rollout. Crash-free is 99.6%, nothing new in Crashlytics." },
      { at: 115, from: "Hana Sato · App engineer", text: "Gift messages went on for both apps at 09:31. The message rides along in the checkout request." },
      { at: 165, from: "Tomas Lind · Payments engineer", text: "We’re moving the card vault behind the new edge. Android was meant to go first; I set it up at 09:16." },
      { at: 245, from: "Elena Ruiz · VP Engineering", text: "A fifth of Android checkouts failing and the rollout still running. What’s the plan?" },
    ],
    hints: [
      "Card payments fail; other ways to pay go through. Look at what only the card path talks to.",
      "Several values changed this morning. Only one of them is read by the build that fails.",
      "Android refuses some connections by policy before any request leaves the phone. Look at the address the card form now uses.",
    ],
    fixNote: "http vault URL blocked by cleartext policy on 7.4.0",
    why: {
      view: "Every failure is a card payment on Android 7.4.0, killed in the app by Android’s cleartext policy; Google Pay and PayPal are clean.",
      history: "Changed to an http:// vault host at 09:16, when card failures began.",
      fix: "Back to the https vault host. 7.4.0 apps pick it up on their next fetch, within about two minutes.",
      status: "FAILED on Android 7.4.0 falls toward 0% and the rollout shows HALTED.",
    },
    postmortem: {
      question: "Why did Android card payments fail this morning?",
      options: [
        "Google Pay’s production environment rejected Marlow’s merchant id",
        "The vault URL went to plain http, which Android 7.4.0 blocks",
        "Gift messages made the Android checkout request too large to send",
        "Android 7.4.0’s staged rollout shipped a crash in the card form",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_card_vault_url moved to an http:// host that Android’s cleartext policy refuses.",
        why: "Android 7.4.0 reads the vault URL from remote config. Plain http is blocked by the default network security policy, so card checkouts died in the app before any request; Google Pay and PayPal never touch the vault. Reverting the URL fixed installed phones; halting only stopped the spread.",
        tell: "Failures only on card payments, only on Android 7.4.0, and a CLEARTEXT error with no matching 5xx on checkout-api.",
      },
    },
  },
  {
    slug: "ios-float-total",
    title: "iPhone totals with cents won’t check out",
    severity: "SEV2",
    opensAt: [12, 8],
    briefing:
      "Checkout 5xx crossed 2% at midday, all from iPhones, and checkout-api hasn’t deployed since Monday. Android 7.4.1 is in a staged rollout, and remote config changed three times this morning. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Work out which change makes iPhones send orders checkout-api can’t take.",
    platform: "ios",
    shares: { ios: 0.36, android: 0.24 },
    releases: { ios: { version: "7.4.1" }, android: { version: "7.4.1", rollout: { previous: "7.4.0", adoption: 0.3, day: 4, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "checkout_total_source",
      description: "Who computes the order total the app posts: the server quote, or the app’s own basket",
      readBy: "ios >= 7.4.0",
      allowed: ["server_quote", "client_basket"],
      by: "lucas.moreau",
      minutesAgo: 19,
      from: "server_quote",
      to: "client_basket",
      note: "cut a quote round-trip on iOS (IOS-1502)",
    },
    decoys: [
      { key: "product_reviews_sort", description: "Default order of reviews on product pages", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: ["helpful", "recent"], by: "mei.chen", minutesAgo: 8, from: "helpful", to: "recent", note: "recent first (CAT-118)" },
      { key: "checkout_saved_address_prefill", description: "Prefill the shipping step with the last used address", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["true", "false"], by: "jonah.reyes", minutesAgo: 41, from: "false", to: "true", note: "prefill GA (CHK-771)" },
    ],
    where: "server",
    message: 'POST /v3/checkout 500 {"error":"internal","code":"CHK-5104","detail":"json: cannot unmarshal number 1998.9999999999998 into Go struct field CheckoutRequest.amount_cents of type int64"}',
    view: {
      name: "order-totals",
      description: "checkouts by order total in cents",
      dimension: "TOTAL × 100",
      buckets: [
        { label: "Whole number (e.g. $58.40 → 5840)", share: 0.31 },
        { label: "Float error (e.g. $19.99 → 1998.9999…)", share: 0.69, isFailing: true },
      ],
    },
    comms: [
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers get “We couldn’t place your order”. One says $58.40 went through and $19.99 didn’t." },
      { at: 75, from: "Ana Costa · Android lead", text: "Android 7.4.1 has been in a staged rollout since yesterday. Want me to halt it?" },
      { at: 120, from: "Sam Tan · Eng manager", text: "checkout-api team: the 500s are JSON decode errors on /v3/checkout, all iOS user agents. No deploy since Monday." },
      { at: 175, from: "Jonah Reyes · App engineer", text: "Saved-address prefill went on for both apps at 11:27. It changes what’s in the request body." },
      { at: 255, from: "Elena Ruiz · VP Engineering", text: "Most iPhone orders are failing at lunchtime. Where are we?" },
    ],
    hints: [
      "Some iPhone orders go through. Compare the totals that do with the ones that don’t.",
      "The server only fails what it can’t read. Ask who now decides the number that goes in the total.",
      "Of the values changed this morning, one is read only by iPhones.",
    ],
    fixNote: "app-computed totals post floats; checkout-api wants integer cents",
    why: {
      view: "iOS 7.4.1 fails most orders: checkout-api can’t decode amount_cents when the app’s ×100 lands on a float. Totals that land on a whole number pass.",
      history: "Switched to app-computed totals at 11:49, just before the 500s.",
      fix: "Back to the server quote, which sends integer cents. iPhones apply it within about two minutes.",
      status: "FAILED on iOS 7.4.1 falls toward 0%; Android was never involved.",
    },
    postmortem: {
      question: "Why did iPhone checkouts fail at midday?",
      options: [
        "Saved-address prefill added a field checkout-api didn’t accept",
        "Android 7.4.1’s staged rollout overloaded checkout-api for all apps",
        "iPhones started posting totals checkout-api can’t decode",
        "checkout-api’s JSON decoder broke on a Go upgrade this morning",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout_total_source made iOS compute cents as dollars × 100 in floating point.",
        why: "With client_basket, iOS 7.4.1 built amount_cents itself, and $19.99 × 100 is 1998.9999999999998 in a double. checkout-api decodes amount_cents as an integer, so any total that didn’t land exactly was a 500. The server quote sends integer cents, so reverting fixed installed iPhones.",
        tell: "500s only from iOS user agents, a Go decode error quoting a near-integer, and some totals passing.",
      },
    },
  },
  {
    slug: "ios-applepay-merchant",
    title: "Apple Pay fails on iPhone",
    severity: "SEV2",
    opensAt: [19, 34],
    briefing:
      "Checkout 5xx is over 2% this evening, all from iPhones, while the servers haven’t changed. Android 7.4.0 started a staged rollout this afternoon and remote config has changed three times since 19:00. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find which change broke iPhone checkouts; not every suspect touches them.",
    platform: "ios",
    shares: { ios: 0.38, android: 0.26 },
    releases: { ios: { version: "7.3.4" }, android: { version: "7.4.0", rollout: { previous: "7.3.4", adoption: 0.18, day: 3, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "apple_pay_merchant_identifier",
      description: "Merchant ID the app requests Apple Pay tokens for",
      readBy: "ios >= 7.0.0",
      allowed: ["merchant.com.marlow.shop", "merchant.com.marlow.shop.eu"],
      by: "noor.haddad",
      minutesAgo: 14,
      from: "merchant.com.marlow.shop",
      to: "merchant.com.marlow.shop.eu",
      note: "EU merchant entity cutover (PAY-902)",
    },
    decoys: [
      { key: "wishlist_share_enabled", description: "Share button on wishlists", readBy: "ios >= 7.1.0, android >= 7.1.0", allowed: ["true", "false"], by: "lena.ortiz", minutesAgo: 6, from: "false", to: "true", note: "wishlist sharing (GRW-461)" },
      { key: "cart_upsell_variant", description: "Which upsell strip the cart shows", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["a", "b"], by: "mei.chen", minutesAgo: 31, from: "a", to: "b", note: "upsell test arm B (GRW-458)" },
    ],
    where: "server",
    message: 'POST /v3/checkout 500 {"error":"internal","code":"CHK-5207","detail":"applepay: token encrypted for merchant.com.marlow.shop.eu; no payment processing certificate for that merchant id"}',
    view: {
      name: "payment-methods",
      description: "checkouts by payment method",
      dimension: "METHOD",
      buckets: [
        { label: "Apple Pay", share: 0.41, isFailing: true },
        { label: "Card", share: 0.47 },
        { label: "PayPal", share: 0.12 },
      ],
    },
    comms: [
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers say the Apple Pay sheet shows a tick, then the order fails. Card works." },
      { at: 70, from: "Ana Costa · Android lead", text: "Android 7.4.0 started its staged rollout this afternoon, 10% now. Should I halt it?" },
      { at: 115, from: "Noor Haddad · Payments engineer", text: "The EU merchant entity went live at 19:00. That was all gateway-side config, I think." },
      { at: 160, from: "Lena Ortiz · Growth", text: "Wishlist sharing went on for both apps at 19:28." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Apple Pay is our busiest way to pay at night. What’s the plan?" },
    ],
    hints: [
      "One way to pay fails and the others don’t. Look at what only that method depends on.",
      "The token is made on the phone and fails on the server. Ask who the phone made it for.",
      "Something every iPhone build reads changed this evening.",
    ],
    fixNote: "Apple Pay tokens for the EU merchant id can't be decrypted yet",
    why: {
      view: "Every failure on iOS is Apple Pay: checkout-api can’t decrypt tokens made for the EU merchant id. Card and PayPal are clean.",
      history: "Switched to the EU merchant id at 19:20, when Apple Pay began failing.",
      fix: "Back to the merchant id checkout-api holds a certificate for. iPhones pick it up within about two minutes.",
      status: "FAILED on iOS 7.3.4 falls toward 0%.",
    },
    postmortem: {
      question: "Why did Apple Pay fail on iPhone this evening?",
      options: [
        "The EU payment gateway was down for Apple Pay tokens all evening",
        "Android 7.4.0’s rollout broke the shared Apple Pay configuration",
        "Wishlist sharing pushed the iOS checkout sheet past its memory limit",
        "iPhones asked for tokens checkout-api had no key to decrypt",
      ],
      answerIndex: 3,
      explanation: {
        cause: "apple_pay_merchant_identifier moved to an EU merchant id with no processing certificate.",
        why: "Apple Pay tokens are encrypted for the merchant id the app asks for. checkout-api only holds the certificate for merchant.com.marlow.shop, so every token made for the EU id failed to decrypt and the order 500’d. Switching back made new tokens decryptable.",
        tell: "Failures only on Apple Pay, every iPhone build alike, with a decrypt error naming the EU merchant id.",
      },
    },
  },
  {
    slug: "android-gpay-test-env",
    title: "Google Pay charges bounce on Android",
    severity: "SEV2",
    opensAt: [15, 12],
    briefing:
      "Since just before 15:00, Android checkouts paid with Google Pay fail with a 500. Cards are fine and nothing deployed today. iOS 7.4.0 is on day 3 of a phased release, and three remote-config keys changed after lunch. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find which change breaks Google Pay before you start reverting things.",
    platform: "android",
    shares: { ios: 0.3, android: 0.33 },
    releases: { android: { version: "7.3.5" }, ios: { version: "7.4.0", rollout: { previous: "7.3.5", adoption: 0.22, day: 3, adoptionPerSecond: 0.0002 } } },
    culprit: {
      key: "google_pay_environment",
      description: "Google Pay API environment the app requests payment data from",
      readBy: "android >= 7.0.0",
      allowed: ["PRODUCTION", "TEST"],
      by: "priya.shah",
      minutesAgo: 22,
      from: "PRODUCTION",
      to: "TEST",
      note: "QA pass for AND-2290, revert after",
    },
    decoys: [
      { key: "order_tracking_map_enabled", description: "Live courier map on the order confirmation", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["true", "false"], by: "kofi.mensah", minutesAgo: 9, from: "false", to: "true", note: "courier map (OPS-208)" },
      { key: "push_prompt_timing", description: "When the app asks for notification permission", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: ["after_first_order", "on_launch"], by: "lena.ortiz", minutesAgo: 44, from: "after_first_order", to: "on_launch", note: "opt-in test (GRW-449)" },
    ],
    where: "server",
    message: 'POST /v3/checkout 500 {"error":"internal","code":"CHK-5211","detail":"googlepay: TEST environment payment token presented to live merchant account"}',
    view: {
      name: "payment-methods",
      description: "checkouts by payment method",
      dimension: "METHOD",
      buckets: [
        { label: "Google Pay", share: 0.37, isFailing: true },
        { label: "Card", share: 0.51 },
        { label: "PayPal", share: 0.12 },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers say Google Pay looks fine, then “Payment failed”. Card works." },
      { at: 75, from: "Lucas Moreau · iOS lead", text: "iOS 7.4.0 is on day 3 of its phased release. Crash reports look normal." },
      { at: 120, from: "Kofi Mensah · App engineer", text: "The courier map went on for both apps at 15:03. It loads right after checkout." },
      { at: 170, from: "Priya Shah · QA lead", text: "I flipped a value for a QA pass after lunch. It should have been the staging template… I think." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Google Pay down on Android for twenty minutes. Where are we?" },
    ],
    hints: [
      "Android customers can still pay by card. Look at the one method that fails.",
      "The server rejects the token the phone hands it, not the request’s shape. Ask where that token was minted.",
      "A change meant for testing would look exactly like this.",
    ],
    fixNote: "TEST Google Pay tokens rejected by the live merchant account",
    why: {
      view: "Every failure on Android is Google Pay, and checkout-api names a TEST environment token. Card and PayPal are clean.",
      history: "Set to TEST at 14:50 for a QA pass, on the production template.",
      fix: "Back to PRODUCTION; Android apps request real tokens again within about two minutes.",
      status: "FAILED on Android 7.3.5 falls toward 0%.",
    },
    postmortem: {
      question: "Why did Google Pay fail on Android this afternoon?",
      options: [
        "Production Android apps asked Google Pay for test tokens",
        "The courier map crashed the app right after payment succeeded",
        "iOS 7.4.0’s phased release changed the shared Google Pay merchant",
        "Google Pay had a regional outage that only affected Android phones",
      ],
      answerIndex: 0,
      explanation: {
        cause: "google_pay_environment was left on TEST in the production template.",
        why: "In TEST, Google Pay returns dummy tokens meant for sandbox merchants. Every Android build reads the key, so each Google Pay checkout reached checkout-api with a token the live account refuses. Card and PayPal never use it. Setting it back to PRODUCTION made new tokens real.",
        tell: "Failures only on Google Pay, every Android build alike, and a 500 naming a TEST environment token.",
      },
    },
  },
  {
    slug: "android-comma-fee",
    title: "German and French Android checkouts crash",
    severity: "SEV2",
    opensAt: [10, 18],
    briefing:
      "Android customers in several European languages can’t finish checkout, while checkout-api sees no errors. iOS 7.4.0 is on day 4 of a phased release and three remote-config keys changed this morning. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Work out what the failing customers have in common before you change anything.",
    platform: "android",
    shares: { ios: 0.32, android: 0.3 },
    releases: { android: { version: "7.3.3" }, ios: { version: "7.4.0", rollout: { previous: "7.3.3", adoption: 0.35, day: 4, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "shipping_fee_localized",
      description: "Send the shipping fee to the app as a localized display string instead of minor units",
      readBy: "android >= 7.3.0",
      allowed: ["true", "false"],
      by: "elif.kaya",
      minutesAgo: 31,
      from: "false",
      to: "true",
      note: "localized fees for the EU launch (GRW-455)",
    },
    decoys: [
      { key: "checkout_delivery_eta_enabled", description: "Show an estimated delivery date on the checkout summary", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "kofi.mensah", minutesAgo: 12, from: "false", to: "true", note: "delivery ETAs (OPS-212)" },
      { key: "image_cdn_quality", description: "JPEG quality the product image CDN serves to apps", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: null, by: "dev.raman", minutesAgo: 50, from: "80", to: "70", note: "save bandwidth (PERF-77)" },
    ],
    where: "client",
    message: 'java.lang.NumberFormatException: For input string: "4,99"',
    view: {
      name: "app-languages",
      description: "checkouts by app language",
      dimension: "LANGUAGE",
      buckets: [
        { label: "English", share: 0.66 },
        { label: "German", share: 0.14, isFailing: true },
        { label: "French", share: 0.11, isFailing: true },
        { label: "Spanish", share: 0.06, isFailing: true },
        { label: "Italian", share: 0.03, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Android customers in Germany and France say the app closes on the checkout summary. English-language customers are fine." },
      { at: 60, from: "Lucas Moreau · iOS lead", text: "iOS 7.4.0 is on day 4; App Store reviews mention nothing." },
      { at: 110, from: "Kofi Mensah · App engineer", text: "Delivery ETAs went live on both apps at 10:06. The ETA sits right on the checkout summary." },
      { at: 170, from: "Elif Kaya · Growth engineer", text: "We localized shipping fees for the EU launch at 09:47. iOS handled it fine in QA." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Half of Europe can’t check out on Android. ETA?" },
    ],
    hints: [
      "Only some languages fail. Ask what looks different in those languages.",
      "The crash happens in the app, before any request. Something it parses now arrives in a shape it can’t read.",
      "One change this morning is read by Android and lines up with the first crash.",
    ],
    fixNote: "localized fees crash Android's fee parser",
    why: {
      view: "Only comma-decimal languages fail on Android, with a NumberFormatException on “4,99”; English checkouts are clean.",
      history: "Turned on at 09:47, when the crashes began.",
      fix: "Back to minor units, which every Android build parses. Apps pick it up within about two minutes.",
      status: "FAILED on Android 7.3.3 falls toward 0%.",
    },
    postmortem: {
      question: "Why did Android checkouts crash for some languages?",
      options: [
        "Delivery ETAs overflowed the summary layout in long languages",
        "Android parsed a localized fee like “4,99” as a plain number",
        "iOS 7.4.0’s phased release changed the fee format for every app",
        "checkout-api returned prices in the wrong currency for the EU",
      ],
      answerIndex: 1,
      explanation: {
        cause: "shipping_fee_localized sent “4,99”, and Android parses fees with Double.parseDouble.",
        why: "With the key on, checkout-api sent shipping fees formatted for the customer’s language. English fees like 4.99 still parsed; German, French, Spanish and Italian use a decimal comma, so Android threw on the summary and the checkout died in the app. Turning the key off sent minor units again.",
        tell: "Crashes only in comma-decimal languages, only on Android, quoting “4,99”, with no 5xx on checkout-api.",
      },
    },
  },
  {
    slug: "ios-null-promo",
    title: "iOS 7.4.0 crashes on big baskets",
    severity: "SEV2",
    opensAt: [13, 46],
    briefing:
      "Since about 13:30, iPhone customers with full baskets see the app close at checkout. iOS 7.4.0 is on day 5 of its phased release, Android is fully released, and remote config changed three times today. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find what makes those checkouts crash, fix the phones that have it, and keep it from spreading.",
    platform: "ios",
    shares: { ios: 0.37, android: 0.27 },
    releases: { ios: { version: "7.4.0", rollout: { previous: "7.3.4", adoption: 0.4, day: 5, adoptionPerSecond: 0.0004 } }, android: { version: "7.3.4" } },
    culprit: {
      key: "checkout_promo_slot",
      description: "Campaign shown in the free-shipping slot on the checkout sheet",
      readBy: "ios >= 7.4.0",
      allowed: null,
      by: "lena.ortiz",
      minutesAgo: 17,
      from: "none",
      to: "free-shipping-50",
      note: "free shipping over $50 (GRW-470)",
    },
    decoys: [
      { key: "home_feed_layout", description: "Layout of the home feed", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["grid", "carousel"], by: "mei.chen", minutesAgo: 7, from: "grid", to: "carousel", note: "carousel test (GRW-466)" },
      { key: "checkout_tip_jar_enabled", description: "Optional courier tip on the checkout sheet", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "jonah.reyes", minutesAgo: 55, from: "false", to: "true", note: "courier tips (OPS-215)" },
    ],
    where: "client",
    message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[NSNull length]: unrecognized selector sent to instance 0x1f6a0c4e8'",
    view: {
      name: "basket-sizes",
      description: "checkouts by basket total",
      dimension: "BASKET",
      buckets: [
        { label: "Under $50", share: 0.53 },
        { label: "$50 and over", share: 0.47, isFailing: true },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "iPhone customers say the app closes when they open checkout. Several say it only happens with a full basket." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "7.4.0 crash-free sessions dipped to 99.1% since lunch. The phased release is on day 5." },
      { at: 120, from: "Ana Costa · Android lead", text: "Android is clean, and it reads the same campaign keys as iOS, so I doubt it’s config." },
      { at: 170, from: "Lena Ortiz · Growth", text: "The free-shipping-over-$50 promo went live at 13:29. Its card has no subtitle yet; is that okay?" },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Our biggest baskets are the ones crashing. What’s the plan?" },
    ],
    hints: [
      "Not every basket crashes. Find the line between those that do and those that don’t.",
      "Only one build crashes, and that build reads something the older ones don’t.",
      "Stopping the spread helps, but phones that already crash need a change they can pick up without an update.",
    ],
    fixNote: "free-shipping-50 card has a null subtitle; 7.4.0 crashes on it",
    why: {
      view: "Only baskets of $50 and over crash, on iOS 7.4.0, with an NSNull crash; smaller baskets are clean.",
      history: "The free-shipping campaign went into the slot at 13:29, when the crashes began.",
      fix: "Empties the slot, so 7.4.0 stops rendering the broken card. iPhones pick it up within about two minutes.",
      halt: "Stops automatic updates to 7.4.0 until a build that handles a missing subtitle ships. On its own it fixes nobody.",
      status: "FAILED on iOS 7.4.0 falls toward 0% and the release shows PAUSED.",
    },
    postmortem: {
      question: "Why did iOS checkouts crash for big baskets?",
      options: [
        "The tip jar made the checkout sheet too tall for smaller iPhones",
        "iOS 7.4.0 crashed on a promo card with a null subtitle",
        "Baskets over $50 hit a checkout-api limit that returned an error",
        "Android and iOS both crashed reading the new home feed layout",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_promo_slot showed a campaign whose subtitle was null; iOS 7.4.0 crashed on it.",
        why: "Only 7.4.0 renders the promo slot, and only for baskets that qualify. The free-shipping-50 campaign had no subtitle, so the app got NSNull where it expected a string and crashed. Emptying the slot stopped the crash on installed phones; pausing the release stopped the spread.",
        tell: "Crashes only on iOS 7.4.0, only on baskets of $50 and over, with an NSNull selector crash and no 5xx.",
      },
    },
  },
  {
    slug: "android-eu-host",
    title: "EU Android customers can’t reach checkout",
    severity: "SEV2",
    opensAt: [8, 27],
    briefing:
      "Android customers in the EU say checkout can’t connect, while checkout-api traffic looks normal. Android 7.4.2 is in a staged rollout, and remote config has changed three times since 07:30. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find why only some Android customers fail, fix the phones that have it, and stop it spreading.",
    platform: "android",
    shares: { ios: 0.3, android: 0.35 },
    releases: { android: { version: "7.4.2", rollout: { previous: "7.4.1", adoption: 0.3, day: 6, adoptionPerSecond: 0.0004 } }, ios: { version: "7.4.1" } },
    culprit: {
      key: "checkout_regional_hosts",
      description: "Comma-separated checkout API hosts; the app picks the one for the customer’s region",
      readBy: "android >= 7.4.2",
      allowed: null,
      by: "piotr.nowak",
      minutesAgo: 24,
      from: "api.marlow.shop,eu.api.marlow.shop",
      to: "api.marlow.shop,api-eu.marlow.shop",
      note: "rename EU host to the new DNS scheme (NET-318)",
    },
    failsWithout: "eu.api.marlow.shop",
    decoys: [
      { key: "referral_banner_enabled", description: "Invite-a-friend banner on the account tab", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["true", "false"], by: "lena.ortiz", minutesAgo: 5, from: "false", to: "true", note: "referrals (GRW-472)" },
      { key: "product_image_max_px", description: "Largest product image size the app downloads", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: null, by: "dev.raman", minutesAgo: 46, from: "2048", to: "1440", note: "save bandwidth on mobile data (PERF-81)" },
    ],
    where: "client",
    message: 'java.net.UnknownHostException: Unable to resolve host "api-eu.marlow.shop": No address associated with hostname',
    view: {
      name: "regions",
      description: "checkouts by customer region",
      dimension: "REGION",
      buckets: [
        { label: "US & Canada", share: 0.58 },
        { label: "EU", share: 0.36, isFailing: true },
        { label: "UK", share: 0.06 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "EU customers on Android say checkout spins, then “No connection”. Their internet works fine." },
      { at: 65, from: "Ana Costa · Android lead", text: "7.4.2 went to 50% of the staged rollout at 07:30. It moved host selection into remote config." },
      { at: 115, from: "Piotr Nowak · Network engineer", text: "Nothing changed on DNS today. The new naming scheme lands next week." },
      { at: 165, from: "Dev Raman · App engineer", text: "I shrank product images at 07:41 to save bandwidth. Could that slow checkout down?" },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Every EU customer who updates loses checkout. Where are we?" },
    ],
    hints: [
      "Only one region fails. Ask what the app does differently for it.",
      "The phone gives up before checkout-api ever sees a request. Look at the name it tries to reach.",
      "The build that fails reads a list the older one doesn’t.",
    ],
    fixNote: "api-eu.marlow.shop has no DNS record until the migration",
    why: {
      view: "Only EU checkouts fail on Android 7.4.2: the phone can’t resolve api-eu.marlow.shop. US and UK are clean.",
      history: "The EU host was renamed at 08:03, ahead of next week’s DNS migration.",
      fix: "Restores the EU host that resolves today. 7.4.2 apps pick it up within about two minutes.",
      status: "FAILED on Android 7.4.2 falls toward 0% and the rollout shows HALTED.",
    },
    postmortem: {
      question: "Why couldn’t EU Android customers check out?",
      options: [
        "EU mobile carriers blocked Marlow’s API at the network level",
        "Smaller product images slowed the app until checkout timed out",
        "Android 7.4.2 looked up an EU host that doesn’t exist yet",
        "checkout-api’s EU pods were down after a failed overnight deploy",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout_regional_hosts named api-eu.marlow.shop, a host with no DNS record yet.",
        why: "Android 7.4.2 picks its checkout host from this list by region. The rename pointed EU customers at a hostname that won’t exist until the DNS migration, so the lookup failed on the phone and no request was sent. Restoring the old host fixed installed phones; halting kept it from spreading.",
        tell: "Failures only in the EU, only on Android 7.4.2, with UnknownHostException and nothing on checkout-api.",
      },
    },
  },
  {
    slug: "ios-3ds-cleartext",
    title: "Bank checks dead-end on iPhone",
    severity: "SEV2",
    opensAt: [16, 52],
    briefing:
      "Since about 16:25, iPhone customers whose bank asks them to verify a payment can’t finish checkout. checkout-api sees no errors. Android 7.4.0 is in a staged rollout and three remote-config keys changed this afternoon. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find which step fails and which change broke it.",
    platform: "ios",
    shares: { ios: 0.36, android: 0.28 },
    releases: { ios: { version: "7.3.6" }, android: { version: "7.4.0", rollout: { previous: "7.3.6", adoption: 0.25, day: 4, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "three_ds_return_url",
      description: "Where the bank’s 3-D Secure challenge returns to when it finishes",
      readBy: "ios >= 7.2.0",
      allowed: null,
      by: "farah.iqbal",
      minutesAgo: 28,
      from: "https://pay.marlow.shop/3ds/return",
      to: "http://pay.marlow.shop/3ds/return",
      note: "match the gateway dashboard value (PAY-915)",
    },
    decoys: [
      { key: "account_deletion_flow", description: "Which account deletion flow the settings screen opens", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: ["v1", "v2"], by: "jonah.reyes", minutesAgo: 10, from: "v1", to: "v2", note: "self-serve deletion (PRIV-52)" },
      { key: "loyalty_points_preview", description: "Show points earned on the checkout sheet", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "mei.chen", minutesAgo: 39, from: "false", to: "true", note: "loyalty preview (GRW-468)" },
    ],
    where: "client",
    message: 'Error Domain=NSURLErrorDomain Code=-1022 "The resource could not be loaded because the App Transport Security policy requires the use of a secure connection."',
    view: {
      name: "card-checks",
      description: "checkouts by bank verification",
      dimension: "3-D SECURE",
      buckets: [
        { label: "No challenge (frictionless)", share: 0.53 },
        { label: "Wallets (no 3-D Secure)", share: 0.25 },
        { label: "Challenged by the bank", share: 0.22, isFailing: true },
      ],
    },
    comms: [
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers say their bank’s verification screen goes blank after they approve, then the order fails." },
      { at: 75, from: "Ana Costa · Android lead", text: "Android 7.4.0 is on day 4 of its staged rollout. Android customers aren’t complaining." },
      { at: 120, from: "Farah Iqbal · Payments engineer", text: "I copied the 3DS return URL from the gateway dashboard at 16:24 so the two match." },
      { at: 170, from: "Mei Chen · App engineer", text: "Loyalty points preview went on the checkout sheet for both apps at 16:13." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Customers are approving payments and getting nothing. What’s the plan?" },
    ],
    hints: [
      "Most card payments work. Find the step the failing ones go through that the others skip.",
      "The phone refuses to load something after the bank is done. Look at how that address is written.",
      "Of this afternoon’s changes, one is read only by iPhones, and it lines up with the first failure.",
    ],
    fixNote: "http 3DS return URL blocked by App Transport Security",
    why: {
      view: "Only bank-challenged checkouts fail on iOS, with NSURLErrorDomain -1022; frictionless cards and wallets are clean.",
      history: "Changed from https to http at 16:24, when the failures began.",
      fix: "Back to https, which App Transport Security allows. iPhones pick it up within about two minutes.",
      status: "FAILED on iOS 7.3.6 falls toward 0%.",
    },
    postmortem: {
      question: "Why did iPhone checkouts fail after bank verification?",
      options: [
        "Banks’ 3-D Secure servers went down for iOS customers this afternoon",
        "iOS refused the http return URL the bank sent customers back to",
        "Loyalty points preview hid the Pay button behind the bank screen",
        "Android 7.4.0’s staged rollout changed the shared bank callback",
      ],
      answerIndex: 1,
      explanation: {
        cause: "three_ds_return_url went to http://, which App Transport Security blocks on iOS.",
        why: "Only checkouts the bank challenges come back through the return URL. With http instead of https, iOS refused to load it, so the challenge never finished and the checkout died in the app. Frictionless cards and wallets never touch it. Restoring https fixed installed iPhones.",
        tell: "Failures only after a 3-D Secure challenge, only on iOS, with NSURLErrorDomain -1022 and no 5xx.",
      },
    },
  },
  {
    slug: "android-bank-scheme",
    title: "Pay by Bank goes nowhere on Android",
    severity: "SEV3",
    opensAt: [11, 3],
    briefing:
      "Android customers choosing Pay by Bank say nothing happens when they tap Continue. Other methods work and checkout-api is quiet. iOS 7.4.1 started a phased release this morning, and three remote-config keys changed. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find which change broke the bank handoff.",
    platform: "android",
    shares: { ios: 0.27, android: 0.38 },
    releases: { android: { version: "7.4.1" }, ios: { version: "7.4.1", rollout: { previous: "7.4.0", adoption: 0.15, day: 2, adoptionPerSecond: 0.00025 } } },
    culprit: {
      key: "open_banking_redirect_scheme",
      description: "URL scheme the app opens to hand off to the customer’s bank app",
      readBy: "android >= 7.3.0",
      allowed: null,
      by: "sven.olsen",
      minutesAgo: 21,
      from: "https",
      to: "marlowbank",
      note: "custom scheme so banks return to us directly (PAY-930)",
    },
    decoys: [
      { key: "cart_save_for_later_enabled", description: "Save for later on cart lines", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["true", "false"], by: "hana.sato", minutesAgo: 13, from: "false", to: "true", note: "save for later (GRW-474)" },
      { key: "checkout_coupon_field_position", description: "Where the coupon field sits on the checkout sheet", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["top", "bottom"], by: "elif.kaya", minutesAgo: 47, from: "top", to: "bottom", note: "fewer coupon hunts (GRW-469)" },
    ],
    where: "client",
    message: "android.content.ActivityNotFoundException: No Activity found to handle Intent { act=android.intent.action.VIEW dat=marlowbank://pay.marlow.shop/... }",
    view: {
      name: "payment-methods",
      description: "checkouts by payment method",
      dimension: "METHOD",
      buckets: [
        { label: "Card", share: 0.48 },
        { label: "Google Pay", share: 0.26 },
        { label: "Pay by Bank", share: 0.2, isFailing: true },
        { label: "PayPal", share: 0.06 },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers who pick Pay by Bank say nothing happens when they tap Continue. Cards work." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "iOS 7.4.1 started its phased release this morning. Pay by Bank works on my iPhone." },
      { at: 115, from: "Hana Sato · App engineer", text: "Save for later went on for both apps at 10:50." },
      { at: 165, from: "Sven Olsen · Payments engineer", text: "I moved the bank handoff to our own scheme at 10:42 so banks return to us directly. Worked on my test phone." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Pay by Bank is the cheapest way for us to get paid. Where are we?" },
    ],
    hints: [
      "One way to pay is dead on Android. Look at what that method does that the others don’t.",
      "The app tries to open something and nothing on the phone answers. Look at the address it opens.",
      "A change this morning lines up with the first failure, and only Android reads it.",
    ],
    fixNote: "no installed app handles marlowbank:// intents",
    why: {
      view: "Only Pay by Bank fails on Android, with ActivityNotFoundException for a marlowbank:// intent; other methods are clean.",
      history: "Switched to the custom scheme at 10:42, when the failures began.",
      fix: "Back to https, which bank app links and browsers handle. Android apps pick it up within about two minutes.",
      status: "FAILED on Android 7.4.1 falls toward 0%.",
    },
    postmortem: {
      question: "Why did Pay by Bank fail on Android this morning?",
      options: [
        "Partner banks rejected Marlow’s open banking certificate overnight",
        "Save for later removed the Pay by Bank button from the basket",
        "iOS 7.4.1’s phased release changed the open banking flow for both apps",
        "Android opened a custom scheme no installed app handles",
      ],
      answerIndex: 3,
      explanation: {
        cause: "open_banking_redirect_scheme went to marlowbank://, which no installed app handles.",
        why: "Android hands Pay by Bank off by opening a URL. With https, the bank’s app link or a browser takes it; the custom scheme matched nothing on customers’ phones (the tester’s debug build registered it), so the intent threw and the checkout died in the app. Restoring https fixed it.",
        tell: "Failures only on Pay by Bank, only on Android, with ActivityNotFoundException and no 5xx.",
      },
    },
  },
  {
    slug: "ios-slot-overflow",
    title: "Scheduled delivery crashes iOS 7.5.0",
    severity: "SEV2",
    opensAt: [17, 15],
    briefing:
      "Since about 17:00, iPhone customers picking a delivery day see the app close. iOS 7.5.0 is on day 4 of its phased release with a rebuilt delivery picker, and three remote-config keys changed this afternoon. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find what makes the picker crash, fix the phones that have it, and keep it from spreading.",
    platform: "ios",
    shares: { ios: 0.39, android: 0.25 },
    releases: { ios: { version: "7.5.0", rollout: { previous: "7.4.2", adoption: 0.33, day: 4, adoptionPerSecond: 0.0004 } }, android: { version: "7.4.2" } },
    culprit: {
      key: "delivery_slot_days",
      description: "How many days ahead the scheduled-delivery picker offers",
      readBy: "ios >= 7.5.0, android >= 7.4.0",
      allowed: ["7", "14"],
      by: "kofi.mensah",
      minutesAgo: 18,
      from: "7",
      to: "14",
      note: "two-week window for the holiday season (OPS-221)",
    },
    decoys: [
      { key: "product_video_autoplay", description: "When product videos autoplay", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["wifi", "always", "never"], by: "mei.chen", minutesAgo: 11, from: "wifi", to: "always", note: "autoplay test (CAT-121)" },
      { key: "checkout_carbon_offset_enabled", description: "Offer a carbon offset add-on at checkout", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "lena.ortiz", minutesAgo: 53, from: "false", to: "true", note: "carbon offsets (GRW-463)" },
    ],
    where: "client",
    message: "Swift/ContiguousArrayBuffer.swift:600: Fatal error: Index out of range",
    view: {
      name: "delivery-options",
      description: "checkouts by delivery choice",
      dimension: "DELIVERY",
      buckets: [
        { label: "Standard", share: 0.58 },
        { label: "Express", share: 0.14 },
        { label: "Scheduled day", share: 0.28, isFailing: true },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "iPhone customers say the app closes when they choose a delivery day. Standard delivery is fine." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "7.5.0 is on day 4 of its phased release. It rebuilt the delivery picker." },
      { at: 120, from: "Ana Costa · Android lead", text: "Android reads the slot-days key too and it’s fine there, so it can’t be that." },
      { at: 170, from: "Kofi Mensah · Ops engineer", text: "Ops asked for a two-week delivery window for the holidays; I widened it at 16:57." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Scheduled delivery is the holiday feature. What’s the plan?" },
    ],
    hints: [
      "Only one delivery choice crashes. Look at what that choice now shows.",
      "A value both apps read is fine on one and fatal on the other. The difference is in the build, not the value.",
      "Halting the spread is wise, but phones that already crash need something they pick up without an update.",
    ],
    fixNote: "7.5.0's picker indexes a 7-day array; 14 days overflows it",
    why: {
      view: "Only scheduled-day checkouts crash, on iOS 7.5.0, with an index-out-of-range fatal error.",
      history: "Widened from 7 to 14 days at 16:57, when the crashes began.",
      fix: "Back to 7 days, which the 7.5.0 picker can show. iPhones pick it up within about two minutes.",
      halt: "Stops automatic updates to 7.5.0 until a picker that sizes from the key ships. On its own it fixes nobody.",
      status: "FAILED on iOS 7.5.0 falls toward 0% and the release shows PAUSED.",
    },
    postmortem: {
      question: "Why did iOS crash on scheduled delivery?",
      options: [
        "Android and iOS both broke on two-week windows; Android just quietly",
        "Carbon offsets added a row the delivery picker couldn’t lay out",
        "iOS 7.5.0’s picker assumed seven days and got fourteen",
        "Ops closed the delivery calendar, leaving the picker with no days",
      ],
      answerIndex: 2,
      explanation: {
        cause: "delivery_slot_days went to 14; iOS 7.5.0’s rebuilt picker indexes a 7-day array.",
        why: "The new picker in 7.5.0 sizes its labels for a week but loops over however many days the key offers, so day eight was out of range and the app crashed. Android and older iOS builds size from the key. Back to 7 stopped the crash on installed phones; pausing the release stopped the spread.",
        tell: "Crashes only on iOS 7.5.0, only for scheduled delivery, with a Swift index-out-of-range error and no 5xx.",
      },
    },
  },
  {
    slug: "android-quote-v3",
    title: "Android order summary won’t load",
    severity: "SEV2",
    opensAt: [14, 36],
    briefing:
      "Android customers see “Couldn’t load your order” on the checkout summary, while checkout-api is healthy. iOS 7.4.0 is on day 4 of a phased release and three remote-config keys changed this afternoon. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Some Android customers still get through; find what separates them.",
    platform: "android",
    shares: { ios: 0.31, android: 0.31 },
    releases: { android: { version: "7.3.8" }, ios: { version: "7.4.0", rollout: { previous: "7.3.8", adoption: 0.27, day: 4, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "checkout_quote_api_version",
      description: "Which quote API version the checkout summary requests",
      readBy: "android >= 7.3.0",
      allowed: ["2", "3"],
      by: "rafael.souza",
      minutesAgo: 23,
      from: "2",
      to: "3",
      note: "move Android to quote v3 (AND-2311)",
    },
    decoys: [
      { key: "app_review_prompt_enabled", description: "Ask for a store review after a delivered order", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: ["true", "false"], by: "jonah.reyes", minutesAgo: 9, from: "false", to: "true", note: "review prompts (GRW-476)" },
      { key: "checkout_address_lookup_provider", description: "Address autocomplete provider on the shipping step", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["loqate", "google"], by: "mei.chen", minutesAgo: 45, from: "loqate", to: "google", note: "provider switch (CHK-780)" },
    ],
    where: "client",
    message: "kotlinx.serialization.MissingFieldException: Field 'currency' is required for type with serial name 'com.marlow.checkout.Quote', but it was missing at path: $",
    view: {
      name: "shipping-destinations",
      description: "checkouts by shipping destination",
      dimension: "DESTINATION",
      buckets: [
        { label: "Domestic", share: 0.71, isFailing: true },
        { label: "International", share: 0.29 },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers say the summary shows “Couldn’t load your order”. Some international customers are fine." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "iOS 7.4.0 is on day 4 of its phased release, still clean." },
      { at: 115, from: "Mei Chen · App engineer", text: "Address lookup moved to the new provider at 13:51, both apps." },
      { at: 165, from: "Rafael Souza · Android engineer", text: "Quote v3 went to Android at 14:13. v3 trims fields that match the store default, to save bytes." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Most Android checkouts can’t even see their total. Where are we?" },
    ],
    hints: [
      "International orders go through; domestic ones don’t. Ask what differs in what the app receives.",
      "The app gives up while reading a response, before Pay. Look at what the response now leaves out.",
      "Of this afternoon’s changes, one is read only by Android and lines up with the first failure.",
    ],
    fixNote: "quote v3 omits currency on domestic orders; Android requires it",
    why: {
      view: "Only domestic orders fail on Android, with a MissingFieldException for 'currency'; international orders are clean.",
      history: "Moved to quote v3 at 14:13, when the failures began.",
      fix: "Back to quote v2, which always sends currency. Android apps pick it up within about two minutes.",
      status: "FAILED on Android 7.3.8 falls toward 0%.",
    },
    postmortem: {
      question: "Why did the Android order summary fail to load?",
      options: [
        "Quote v3 left out a field Android requires on domestic orders",
        "The new address provider returned addresses Android rejected as invalid",
        "iOS 7.4.0’s phased release changed the shared quote format",
        "checkout-api crashed building quotes for domestic orders only",
      ],
      answerIndex: 0,
      explanation: {
        cause: "checkout_quote_api_version moved Android to quote v3, which omits currency at home.",
        why: "Quote v3 drops currency when it matches the store’s default, but Android’s Quote model requires it, so decoding failed for domestic orders and the summary never loaded. International quotes still carried currency. Setting the key back to 2 restored full quotes on the next fetch.",
        tell: "Failures only on domestic orders, only on Android, with a MissingFieldException and no 5xx.",
      },
    },
  },
  {
    slug: "ios-attest-enforce",
    title: "iOS 7.4.3 checkouts fail attestation",
    severity: "SEV2",
    opensAt: [20, 5],
    briefing:
      "Checkout 5xx crossed 2% at 19:50, all from iPhones, and some customers say reinstalling the app fixes it. iOS 7.4.3 is on day 5 of its phased release, and three remote-config keys changed tonight. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find what separates failing iPhones from working ones, fix them, and keep it from spreading.",
    platform: "ios",
    shares: { ios: 0.38, android: 0.26 },
    releases: { ios: { version: "7.4.3", rollout: { previous: "7.4.2", adoption: 0.38, day: 5, adoptionPerSecond: 0.0004 } }, android: { version: "7.4.2" } },
    culprit: {
      key: "checkout_app_attest_mode",
      description: "Whether checkout requests carry an App Attest assertion, and whether checkout-api enforces it",
      readBy: "ios >= 7.4.3",
      allowed: ["off", "report", "enforce"],
      by: "ines.duarte",
      minutesAgo: 16,
      from: "report",
      to: "enforce",
      note: "enforce App Attest on checkout (SEC-640)",
    },
    decoys: [
      { key: "search_voice_enabled", description: "Voice search button in the search bar", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "dev.raman", minutesAgo: 6, from: "false", to: "true", note: "voice search (SRCH-334)" },
      { key: "checkout_summary_collapsed", description: "Start the checkout order summary collapsed", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "elif.kaya", minutesAgo: 49, from: "false", to: "true", note: "shorter checkout sheet (GRW-471)" },
    ],
    where: "server",
    message: 'POST /v3/checkout 500 {"error":"internal","code":"CHK-5402","detail":"appattest: assertion signature does not verify against the public key registered for this key id"}',
    view: {
      name: "attest-keys",
      description: "checkouts by App Attest key",
      dimension: "ATTEST KEY",
      buckets: [
        { label: "Generated on 7.4.3", share: 0.57 },
        { label: "Carried over from 7.4.2", share: 0.43, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Some iPhone customers get “We couldn’t place your order”. People who reinstalled say it works." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "7.4.3 is on day 5 of its phased release. It’s the first build that attests checkout." },
      { at: 120, from: "Ines Duarte · Security engineer", text: "Report mode looked clean for a week, so I moved attestation to enforce at 19:49." },
      { at: 170, from: "Elif Kaya · Growth engineer", text: "The collapsed order summary went on for both apps at 19:16." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "We can’t tell customers to reinstall. What’s the plan?" },
    ],
    hints: [
      "Reinstalling helps. Ask what a fresh install has that an updated one doesn’t.",
      "The server can’t verify what the phone signed. Look at what changed in how strictly it checks.",
      "Pausing the build’s spread stops new cases; the phones already failing need a change they can fetch.",
    ],
    fixNote: "carried-over attest keys fail enforcement; back to report",
    why: {
      view: "iOS 7.4.3 fails only on App Attest keys carried over from 7.4.2; keys generated on 7.4.3 verify.",
      history: "Moved from report to enforce at 19:49, when the 500s began. Report mode never failed a request.",
      fix: "Back to report: assertions are logged, not enforced. iPhones pick it up within about two minutes.",
      status: "FAILED on iOS 7.4.3 falls toward 0% and the release shows PAUSED.",
    },
    postmortem: {
      question: "Why did iOS 7.4.3 checkouts fail tonight?",
      options: [
        "Apple’s App Attest service was down and rejected every assertion",
        "Enforcement failed phones whose attest key came from 7.4.2",
        "A collapsed order summary hid the Pay button on smaller iPhones",
        "checkout-api’s new certificate broke TLS for every iPhone build",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout_app_attest_mode went to enforce; attest keys carried over from 7.4.2 don't verify.",
        why: "7.4.3 reuses an App Attest key it finds from 7.4.2, but that key was registered under a different key id, so its assertions never verified. Report mode only logged it; enforce turned each into a 500. Fresh installs made a new key and passed. Back to report fixed installed phones; pausing kept it from spreading.",
        tell: "500s only from iOS 7.4.3, only on carried-over keys, with an assertion error; reinstalling fixed it.",
      },
    },
  },
  {
    slug: "android-gzip-body",
    title: "Big Android baskets fail at Pay",
    severity: "SEV2",
    opensAt: [18, 21],
    briefing:
      "Since about 17:55, Android customers with bigger baskets get a 500 at Pay; small orders are fine and checkout-api hasn’t deployed since Thursday. iOS 7.4.0 is in a phased release and three remote-config keys changed this afternoon. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Find what makes a bigger basket fail.",
    platform: "android",
    shares: { ios: 0.29, android: 0.35 },
    releases: { android: { version: "7.4.0" }, ios: { version: "7.4.0", rollout: { previous: "7.3.9", adoption: 0.3, day: 4, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "checkout_request_compression",
      description: "Compress checkout request bodies over 1 KB",
      readBy: "android >= 7.3.0",
      allowed: ["none", "gzip"],
      by: "rafael.souza",
      minutesAgo: 27,
      from: "none",
      to: "gzip",
      note: "save data on slow networks (AND-2320)",
    },
    decoys: [
      { key: "checkout_gift_wrap_enabled", description: "Offer gift wrap as a line item", readBy: "ios >= 7.3.0, android >= 7.3.0", allowed: ["true", "false"], by: "hana.sato", minutesAgo: 15, from: "false", to: "true", note: "gift wrap (GRW-477)" },
      { key: "home_recommendations_model", description: "Recommendation model behind the home feed", readBy: "ios >= 7.1.0, android >= 7.1.0", allowed: ["v4", "v5"], by: "dev.raman", minutesAgo: 42, from: "v4", to: "v5", note: "model v5 (REC-90)" },
    ],
    where: "server",
    message: `POST /v3/checkout 500 {"error":"internal","code":"CHK-5001","detail":"invalid character '\\x1f' looking for beginning of value"}`,
    view: {
      name: "basket-items",
      description: "checkouts by items in basket",
      dimension: "ITEMS",
      buckets: [
        { label: "1–3 items", share: 0.62 },
        { label: "4 or more items", share: 0.38, isFailing: true },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Android customers with bigger baskets get “Something went wrong” at Pay. Small orders go through." },
      { at: 70, from: "Lucas Moreau · iOS lead", text: "iOS 7.4.0 is on day 4 of its phased release. Should we pause it to be safe?" },
      { at: 115, from: "Sam Tan · Eng manager", text: "checkout-api team: the failing bodies aren’t JSON at all, they say. No deploy since Thursday." },
      { at: 165, from: "Hana Sato · App engineer", text: "Gift wrap went on at 18:06, and it adds a line item to the request." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Our biggest Android orders are failing on a Saturday evening. Where are we?" },
    ],
    hints: [
      "Small baskets pay fine. Ask what changes about the request as it grows.",
      "The server says the body isn’t the format it expects. Look at what the phone does to bodies before sending.",
      "One change this afternoon is read only by Android and lines up with the first 500.",
    ],
    fixNote: "checkout-api can't read gzip request bodies",
    why: {
      view: "Only baskets of four or more items fail on Android: checkout-api reads byte 0x1f, the start of a gzip stream, as JSON.",
      history: "Turned on at 17:54, when the 500s began.",
      fix: "Back to plain JSON bodies. Android apps pick it up within about two minutes.",
      status: "FAILED on Android 7.4.0 falls toward 0%.",
    },
    postmortem: {
      question: "Why did big Android baskets fail at Pay?",
      options: [
        "Gift wrap added a line item that checkout-api couldn’t price",
        "iOS 7.4.0’s phased release flooded checkout-api with large orders",
        "checkout-api’s request size limit was lowered in Thursday’s deploy",
        "Android gzipped bodies checkout-api doesn’t decompress",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout_request_compression made Android gzip bodies over 1 KB; checkout-api reads raw JSON.",
        why: "With gzip on, Android compressed any checkout body over 1 KB, roughly baskets of four items or more. checkout-api doesn’t decode a request’s Content-Encoding, so it read the gzip magic byte as JSON and answered 500. Small baskets were never compressed. Back to none sent plain JSON again.",
        tell: "500s only from Android, only on bigger baskets, with a JSON error at '\\x1f', gzip’s first byte.",
      },
    },
  },
  {
    slug: "ios-network-token",
    title: "Saved cards fail on iPhone",
    severity: "SEV2",
    opensAt: [21, 33],
    briefing:
      "Checkout 5xx is over 2% tonight, all from iPhones paying with a saved card. Typing the card in again works. Android 7.4.3 is in a staged rollout, and remote config changed three times this evening. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for rollouts and field telemetry, remote-config for what installed apps do. Two of tonight’s changes touch saved cards; find the one that broke them.",
    platform: "ios",
    shares: { ios: 0.37, android: 0.27 },
    releases: { ios: { version: "7.4.2" }, android: { version: "7.4.3", rollout: { previous: "7.4.2", adoption: 0.24, day: 3, adoptionPerSecond: 0.0003 } } },
    culprit: {
      key: "saved_card_credential",
      description: "What the app sends for a saved card: the vault token, or a card-network token",
      readBy: "ios >= 7.4.0",
      allowed: ["vault_token", "network_token"],
      by: "farah.iqbal",
      minutesAgo: 20,
      from: "vault_token",
      to: "network_token",
      note: "network tokens for better auth rates (PAY-944)",
    },
    decoys: [
      { key: "order_history_page_size", description: "Orders per page in order history", readBy: "ios >= 7.0.0, android >= 7.0.0", allowed: null, by: "mei.chen", minutesAgo: 4, from: "20", to: "50", note: "fewer page loads (ACC-61)" },
      { key: "checkout_cvc_recheck_enabled", description: "Ask for the CVC again when paying with a saved card", readBy: "ios >= 7.2.0, android >= 7.2.0", allowed: ["true", "false"], by: "noor.haddad", minutesAgo: 51, from: "true", to: "false", note: "cut saved-card friction (PAY-938)" },
    ],
    where: "server",
    message: 'POST /v3/checkout 500 {"error":"internal","code":"CHK-5230","detail":"gateway: network_token credentials are not enabled for merchant account mkt_live_marlow_us"}',
    view: {
      name: "card-entry",
      description: "checkouts by how the card was given",
      dimension: "CARD",
      buckets: [
        { label: "Saved card", share: 0.46, isFailing: true },
        { label: "New card", share: 0.3 },
        { label: "Apple Pay", share: 0.24 },
      ],
    },
    comms: [
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers paying with a saved card get “Payment failed”. Typing the card in again works." },
      { at: 75, from: "Ana Costa · Android lead", text: "Android 7.4.3 is in a staged rollout since yesterday. No saved-card complaints from Android." },
      { at: 120, from: "Noor Haddad · Payments engineer", text: "I turned off the CVC re-check for saved cards at 20:42, to cut friction. Both apps." },
      { at: 170, from: "Farah Iqbal · Payments engineer", text: "Network tokens went live for iOS at 21:13. The gateway said they were enabled on our account last week." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Saved cards are most of our repeat customers. What’s the plan?" },
    ],
    hints: [
      "Typing the card again works where a saved card fails. Look at what the app sends for each.",
      "The gateway refuses a kind of credential, not a card. Ask what made the app start sending it.",
      "Two changes this evening touch saved cards; only one lines up with the first 500.",
    ],
    fixNote: "network tokens not enabled on the live merchant account",
    why: {
      view: "Only saved cards fail on iOS: the gateway refuses network_token credentials for this merchant account. New cards and Apple Pay are clean.",
      history: "Switched to network tokens at 21:13, when the 500s began.",
      fix: "Back to vault tokens, which the gateway accepts. iPhones pick it up within about two minutes.",
      status: "FAILED on iOS 7.4.2 falls toward 0%.",
    },
    postmortem: {
      question: "Why did saved cards fail on iPhone tonight?",
      options: [
        "Dropping the CVC re-check made the gateway decline saved cards",
        "Android 7.4.3’s staged rollout invalidated every saved card token",
        "iPhones sent network tokens the merchant account can’t take",
        "The card vault lost its encryption keys and couldn’t look cards up",
      ],
      answerIndex: 2,
      explanation: {
        cause: "saved_card_credential made iOS send network tokens the live account hasn’t enabled.",
        why: "Only iOS reads the key, and only saved cards use it. With network_token, each saved-card checkout carried a credential the gateway refuses for this merchant account, so checkout-api answered 500. New cards and Apple Pay were untouched. Back to vault_token fixed it on the next fetch.",
        tell: "500s only from iOS, only on saved cards, naming network_token credentials; retyping the card worked.",
      },
    },
  },
];

export const MOBILE_TIER2_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
