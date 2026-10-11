import type { CommsMessage, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { clientDefects } from "../sim/client-defects.ts";
import { clientSegments, unsafeRetryShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import {
  configValue,
  findConfig,
  RETRY_POLICY_NAMES,
  type ClientBuild,
  type ClientDefect,
  type Commerce,
  type DefectTrigger,
  type Platform,
  type RemoteConfigEntry,
} from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { isOlderThan, updateWall } from "../sim/update-wall.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { CHECKOUT, checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

const HOUR = 3600;
const MINUTE = 60;
/** A storm opens three minutes after its surge, once it holds on its own, as in ios-retry-config. */
const STORM_WARM_UP_SECONDS = 180;
const ORGANIC_RPS = 300;
const ERRORS_VIEW = "checkout-errors";

type AppPlatform = "ios" | "android";

/** The app release in progress on the paged platform: halting it is the trap, since installed apps keep their build. */
type Release = {
  readonly platform: AppPlatform;
  readonly current: string;
  readonly previous: string;
  readonly adoption: number;
  readonly day: number;
};

/** The remote-config key whose last change caused the incident. */
type CulpritKey = {
  readonly key: string;
  readonly description: string;
  readonly readBy: string;
  readonly allowed: readonly string[] | null;
  readonly baseVersion: number;
  readonly good: string;
  readonly bad: string;
  readonly by: string;
  /** Seconds before the page the bad value was published. */
  readonly secondsAgo: number;
  readonly note: string;
};

type Defect = { readonly where: ClientDefect["where"]; readonly failShare: number; readonly message: string; readonly affects: "current" | "all" };

type Mechanic =
  /** A build bug that fires while the key holds its bad value. */
  | ({ readonly kind: "equals" } & Defect)
  /** A build bug that fires while a comma-separated list lacks one entry. */
  | ({ readonly kind: "lacks"; readonly entry: string } & Defect)
  /** The key names a minimum version above every installed app build. `floor`: an old build the minimum must still block. */
  | { readonly kind: "wall"; readonly floor: string }
  /** The key puts the build on instant retries while the gateway is degraded and a surge has passed. */
  | { readonly kind: "storm"; readonly chargesPerSecond: number; readonly surgeRps: number; readonly surgeSeconds: number; readonly gatewayStatus: string };

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly release: Release;
  readonly culprit: CulpritKey;
  readonly mechanic: Mechanic;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
};

function userAgent(platform: AppPlatform, version: string): string {
  return platform === "ios" ? iosUserAgent(version, Number(version.replaceAll(".", "")) * 10 + 1) : androidUserAgent(version);
}

function valueOf(state: ClusterState, key: string): string | undefined {
  const entry = state.commerce && findConfig(state.commerce, key);
  return entry ? configValue(entry) : undefined;
}

function listIncludes(list: string, entry: string): boolean {
  return list.split(",").some((item) => item.trim() === entry);
}

function appVersions(commerce: Commerce): readonly string[] {
  return commerce.platforms.filter((platform) => platform.id !== "web").flatMap((platform) => [platform.current.version, ...(platform.previous ? [platform.previous.version] : [])]);
}

function defectTrigger(row: Row): DefectTrigger {
  const { mechanic, culprit } = row;
  return mechanic.kind === "lacks" ? { remoteConfig: culprit.key, failsWithout: mechanic.entry } : { remoteConfig: culprit.key, failsWhen: culprit.bad };
}

function builds(row: Row): Partial<Omit<Platform, "id">> {
  const { release, mechanic, culprit } = row;
  const build = (version: string, isCurrent: boolean): ClientBuild => {
    const base = { version, userAgent: userAgent(release.platform, version), timeoutMs: release.platform === "ios" ? 10_000 : 30_000 };
    if (mechanic.kind === "storm") return { ...base, retry: isCurrent ? { kind: "remote-config", key: culprit.key } : NO_RETRY };
    if (mechanic.kind === "wall" || (mechanic.affects === "current" && !isCurrent)) return { ...base, retry: NO_RETRY };
    return { ...base, retry: NO_RETRY, defects: [{ trigger: defectTrigger(row), failShare: mechanic.failShare, where: mechanic.where, message: mechanic.message }] };
  };
  return {
    current: build(release.current, true),
    previous: build(release.previous, false),
    adoption: release.adoption,
    rollout: { kind: "phased", day: release.day, isPaused: false, adoptionPerSecond: 0.00005 },
  };
}

function culpritEntry(culprit: CulpritKey): RemoteConfigEntry {
  return {
    key: culprit.key,
    description: culprit.description,
    readBy: culprit.readBy,
    allowed: culprit.allowed,
    baseVersion: culprit.baseVersion,
    history: [{ at: -culprit.secondsAgo, by: culprit.by, from: culprit.good, to: culprit.bad, note: culprit.note }],
  };
}

function isFixed(row: Row, state: ClusterState): boolean {
  const { mechanic, culprit } = row;
  const value = valueOf(state, culprit.key);
  if (value === undefined || !state.commerce) return false;
  switch (mechanic.kind) {
    case "equals":
      return value !== culprit.bad;
    case "lacks":
      return listIncludes(value, mechanic.entry);
    case "wall":
      return appVersions(state.commerce).every((version) => !isOlderThan(version, value));
    case "storm":
      return isOnCleanBuild(state) && unsafeRetryShare(state.commerce, state.t) < 0.001;
  }
}

function objectives(row: Row): ((state: ClusterState) => readonly Objective[]) | undefined {
  const { mechanic, culprit, release } = row;
  if (mechanic.kind === "storm") {
    return (state) => [{ role: "mobile", label: `${release.platform} ${release.current} no longer retries immediately (${culprit.key})`, isMet: valueOf(state, culprit.key) !== "immediate" }];
  }
  if (mechanic.kind === "wall") {
    return (state) => [{ role: "mobile", label: `${mechanic.floor} and older still get the update screen (${culprit.key})`, isMet: isOlderThan(mechanic.floor, valueOf(state, culprit.key) ?? "") }];
  }
  return undefined;
}

/** `releases checkout-errors`: checkouts each app build lost in the last five minutes, with the error it reports. */
function checkoutErrors(row: Row, message: string) {
  return (state: ClusterState): readonly string[] => {
    const commerce = state.commerce;
    if (!commerce) return ["releases: no app telemetry in window"];
    const rows = clientSegments(commerce, state.t)
      .filter((segment) => segment.platform !== "web")
      .map((segment) => {
        const started = commerce.pulse.organicCheckoutsPerSecond * segment.share * WINDOW_SECONDS;
        const effect = clientDefects(commerce, segment, state.t);
        const failing = 1 - (1 - effect.rejectedShare) * (1 - effect.clientFailureShare) * (1 - updateWall(commerce, segment, state.t));
        return [`${segment.platform} ${segment.version}`, count(started), count(started * failing), percent(failing)];
      });
    const failing = rows.some((cells) => cells[2] !== "0");
    const source = row.mechanic.kind !== "wall" && row.mechanic.kind !== "storm" && row.mechanic.where === "server" ? "checkout-api, answering the app" : "app crash and error reports";
    return [
      "Checkouts started in the apps · last 5 min",
      ...table([["BUILD", "STARTED", "FAILED", "SHARE"], ...rows]),
      "",
      ...(failing ? [`Most common error (${source}):`, `  ${message}`] : ["No checkout errors above baseline."]),
    ];
  };
}

function incident(row: Row): Scenario {
  const id = `mob-t1-${row.slug}`;
  const { mechanic, culprit, release } = row;
  const isStorm = mechanic.kind === "storm";
  const isLoss = mechanic.kind === "wall" || ((mechanic.kind === "equals" || mechanic.kind === "lacks") && mechanic.where === "client");
  const remoteConfig = [culpritEntry(culprit), ...SHOP_REMOTE_CONFIG];
  const goal = objectives(row);
  return {
    id,
    tier: 1,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["mobile"],
    roleBriefings: { mobile: row.roleBriefing },
    suggestions: {
      mobile: [
        "releases status",
        ...(mechanic.kind === "equals" || mechanic.kind === "lacks" ? [`releases ${ERRORS_VIEW}`] : []),
        "remote-config list",
        `remote-config history ${culprit.key}`,
        `releases halt ${release.platform} ${release.current}`,
      ],
    },
    opensAtSecondOfDay: row.opensAt[0] * HOUR + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [
          { number: 7, tag: "v4.12.0", changeCause: "v4.12.0 order confirmation emails via outbox", traits: [] },
          { number: 8, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
        ],
        revision: 8,
        commerce: checkoutCommerce({
          platforms: { [release.platform]: builds(row) },
          remoteConfig,
          ...(isStorm ? { gateway: { chargesPerSecond: mechanic.chargesPerSecond, maxQueueSeconds: 8 } } : {}),
          ...(mechanic.kind === "wall" ? { updateWall: { configKey: culprit.key } } : {}),
        }),
        ...(isStorm
          ? { warmUp: { seconds: STORM_WARM_UP_SECONDS, requestsPerSecond: (second: number) => (second < mechanic.surgeSeconds ? mechanic.surgeRps : ORGANIC_RPS) } }
          : {}),
      }),
    isRootCauseFixed: (state) => isFixed(row, state),
    ...(goal ? { objectives: goal } : {}),
    ...(isLoss ? { alertMetric: { label: "checkout loss", rate: (state: ClusterState) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) } } : {}),
    ...(mechanic.kind === "equals" || mechanic.kind === "lacks"
      ? { evidence: [{ tool: "releases" as const, name: ERRORS_VIEW, description: "Checkouts each app build lost, with its most common error", run: checkoutErrors(row, mechanic.message) }] }
      : {}),
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [
      isStorm
        ? {
            id: "payment-gateway",
            status: "degraded",
            facts: [
              { key: "Status page", value: mechanic.gatewayStatus },
              { key: "Throughput for us", value: `≈${mechanic.chargesPerSecond} charges/s while degraded; excess queues FIFO` },
              { key: "checkout-api timeout", value: "3000 ms per call; queued calls still get captured" },
            ],
          }
        : {
            id: "payment-gateway",
            status: "ok",
            facts: [
              { key: "Status page", value: "All systems operational" },
              { key: "checkout-api timeout", value: "3000 ms per call" },
            ],
          },
    ],
    comms: row.comms,
    hints: row.hints,
    solution: { mobile: row.solution },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "stripe-test-key",
    title: "Android cards land in test mode",
    severity: "SEV2",
    opensAt: [10, 42],
    briefing:
      "Since about 10:24, card payments from the Android app fail with “Payment could not be completed”. Google Pay still works, iOS and web are fine, and checkout-api hasn’t deployed today. You’re the mobile on-call. Android 7.3.1 is on day 4 of its staged rollout.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. The Android payments squad was setting up a QA build this morning.",
    release: { platform: "android", current: "7.3.1", previous: "7.2.4", adoption: 0.35, day: 4 },
    culprit: {
      key: "android_stripe_publishable_key",
      description: "Stripe publishable key the Android app tokenizes cards with",
      readBy: "android >= 7.0.0",
      allowed: null,
      baseVersion: 6,
      good: "pk_live_51MarlowQx7Lp2Vh",
      bad: "pk_test_51MarlowQx7Lp2Vh",
      by: "tariq.bello",
      secondsAgo: 18 * MINUTE,
      note: "point QA builds at Stripe test mode (MOB-2207)",
    },
    mechanic: {
      kind: "equals",
      where: "server",
      failShare: 0.86,
      affects: "all",
      message: "POST /checkout 500 · stripe: No such token: 'tok_1Q8xFh2eZvKYlo2C'; a similar object exists in test mode, but a live mode key was used to make this request.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 4% on POST /checkout, all from Android user agents. Mobile on-call paged." },
      { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Start with the checkout errors per app build. If every Android build fails the same way, it isn’t the new build." },
      { at: 50, from: "Maya Okonkwo · Support", text: "Android customers: “Payment could not be completed” on card. Google Pay goes through. Nobody on iPhone is complaining." },
      { at: 90, from: "Lucas Moreau · Android lead", text: "7.3.1 is on 35% of phones. Should I halt the staged rollout to be safe?" },
      { at: 130, from: "Tariq Bello · Android payments", text: "I switched our Stripe key for the QA build around 10:24. It should have only gone to the QA condition… let me check." },
      { at: 200, from: "Sam Tan · Eng manager", text: "One in eight customers is on Android. How long until card payments work again?" },
    ],
    hints: [
      "Old and new Android builds fail the same way, so the release in progress isn’t the difference.",
      "The error comes from the card processor and says which mode the card token was made in.",
      "Find what tells installed Android apps which processor key to tokenize cards with, and what changed it this morning.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both Android builds fail: Stripe says the card token was made in test mode but checkout-api charges with a live key." },
      { command: 'remote-config set android_stripe_publishable_key pk_live_51MarlowQx7Lp2Vh --note "test key reached prod template, not just QA"', why: "Android apps tokenize with the live key again on their next fetch, within about two minutes." },
      { command: "remote-config history android_stripe_publishable_key", why: "tariq.bello published the pk_test_ key at 10:24, when the 500s began; your change restores the live key." },
      { command: "releases status android", why: "FAILED on both Android builds falls toward zero as apps fetch the live key." },
    ],
    postmortem: {
      question: "Why did Android card payments fail this morning?",
      options: [
        "Android 7.3.1 shipped a card form that drops the card’s expiry date",
        "The Android app made card tokens with Stripe’s test key",
        "Stripe’s live API was rejecting tokens from every merchant on Android devices",
        "checkout-api rotated its secret key and lost access to old tokens",
      ],
      answerIndex: 1,
      explanation: {
        cause: "android_stripe_publishable_key was set to the pk_test_ key in the production template instead of the QA condition, so every Android build tokenized cards in Stripe test mode.",
        why: "checkout-api charges with the live secret key, and a test-mode token doesn’t exist in live mode, so Stripe answered “No such token” and checkout-api returned 500. Google Pay used a different path and kept working. Remote config reaches installed apps, so restoring the live key fixed every build.",
        tell: "Every Android build failing card payments at once, Google Pay fine, and Stripe’s “a similar object exists in test mode” message.",
      },
    },
    lostCheckoutsPerPoint: 160,
  },
  {
    slug: "request-schema-early",
    title: "iOS sends a schema nobody accepts",
    severity: "SEV2",
    opensAt: [13, 6],
    briefing:
      "From 12:51, every checkout from iOS 7.4.0 fails with a server error. iOS 7.3.2, Android and web check out normally. You’re the mobile on-call. iOS 7.4.0 is on day 5 of its phased release; checkout-api is still on v4.12.1.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. 7.4.0 shipped a new checkout request format behind remote config.",
    release: { platform: "ios", current: "7.4.0", previous: "7.3.2", adoption: 0.42, day: 5 },
    culprit: {
      key: "checkout_request_schema",
      description: "Version of the POST /checkout body the app sends",
      readBy: "ios >= 7.4.0",
      allowed: ["2", "3"],
      baseVersion: 2,
      good: "2",
      bad: "3",
      by: "nora.lindqvist",
      secondsAgo: 15 * MINUTE,
      note: "schema 3 on, checkout-api v4.13 ships today (MOB-2251)",
    },
    mechanic: {
      kind: "equals",
      where: "server",
      failShare: 1,
      affects: "current",
      message: 'POST /checkout 500 · checkout-api: unsupported request schema "3" (v4.12.1 accepts 1–2)',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 4% for 3m. Errors carry Marlow/7.4.0 user agents. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Compare the builds. If only 7.4.0 fails, ask what 7.4.0 does differently that we can still switch from here." },
      { at: 55, from: "Priya Shah · Backend lead", text: "checkout-api v4.13 got pushed to tomorrow; a migration failed review. We’re on v4.12.1 all day." },
      { at: 95, from: "Lucas Moreau · iOS lead", text: "Halting 7.4.0? It’s on 42% of phones already." },
      { at: 140, from: "Nora Lindqvist · iOS", text: "I turned on schema 3 at 12:51 because v4.13 was supposed to be out by now. Sorry, didn’t see it slipped." },
    ],
    hints: [
      "Only the newest iOS build fails, and it fails every time.",
      "checkout-api names what it didn’t accept, and its backend team just told you which version is running.",
      "The new request format is switchable on phones that already have the build.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Only iOS 7.4.0 fails: checkout-api v4.12.1 rejects request schema 3." },
      { command: 'remote-config set checkout_request_schema 2 --note "checkout-api v4.13 slipped; v4.12.1 only takes schema 2"', why: "7.4.0 goes back to schema 2, which v4.12.1 accepts, within about two minutes." },
      { command: "remote-config history checkout_request_schema", why: "Schema 3 went on at 12:51, ahead of the backend release that would accept it." },
      { command: "releases status ios", why: "FAILED on 7.4.0 falls to the same level as 7.3.2." },
    ],
    postmortem: {
      question: "Why did iOS 7.4.0 checkouts fail?",
      options: [
        "7.4.0 sent request schema 3 before checkout-api could accept it",
        "The phased release pushed 7.4.0 to too many phones at once, overloading checkout-api",
        "checkout-api v4.13 broke schema 2 for older apps",
        "iOS 7.3.2 corrupted the cart when phones updated to 7.4.0",
      ],
      answerIndex: 0,
      explanation: {
        cause: "checkout_request_schema was set to 3 for v4.13, which slipped a day. checkout-api v4.12.1 accepts schemas 1–2 and answered every schema-3 request with a 500.",
        why: "Only 7.4.0 reads the key, so only 7.4.0 failed. Halting the phased release would have stopped new installs but left 42% of iPhones broken; setting the key back to 2 fixed them in place.",
        tell: "100% failures on one build only, an error naming schema 3, and a backend team still on v4.12.1.",
      },
    },
    lostCheckoutsPerPoint: 250,
  },
  {
    slug: "loyalty-half-points",
    title: "Half-point redemptions crash checkout",
    severity: "SEV3",
    opensAt: [16, 20],
    briefing:
      "Since 16:02, iOS customers redeeming loyalty points at checkout get “Something went wrong”. Checkouts without points are fine, and Android and web customers redeeming points are fine too. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Loyalty ran an afternoon promotion on the iOS app.",
    release: { platform: "ios", current: "7.3.3", previous: "7.3.0", adoption: 0.6, day: 6 },
    culprit: {
      key: "ios_loyalty_redeem_step",
      description: "Smallest number of loyalty points the iOS slider redeems at a time",
      readBy: "ios >= 7.1.0",
      allowed: null,
      baseVersion: 4,
      good: "1",
      bad: "0.5",
      by: "harper.quinn",
      secondsAgo: 18 * MINUTE,
      note: "double-points promo: finer slider (LOY-77)",
    },
    mechanic: {
      kind: "equals",
      where: "server",
      failShare: 0.3,
      affects: "all",
      message: "POST /checkout 500 · checkout-api: java.lang.ArithmeticException: Rounding necessary (LoyaltyLedger.redeem, points=12.5)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx > 4% for 3m on POST /checkout, all from the iOS app. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Look at which builds fail and what checkout-api says back. Then look at what changed on the iOS side around 16:00." },
      { at: 50, from: "Maya Okonkwo · Support", text: "Customers using points on iPhone: “Something went wrong.” Same customers can check out if they don’t use points." },
      { at: 100, from: "Harper Quinn · Loyalty", text: "For double points I made the slider move in half points at 16:02. That’s just a UI thing, right?" },
      { at: 160, from: "Priya Shah · Backend lead", text: "The loyalty ledger stores whole points. It has never seen a fraction." },
    ],
    hints: [
      "Only checkouts that redeem points fail, and on every iOS build.",
      "checkout-api says exactly which number it couldn’t store, and it isn’t a whole number.",
      "Something set this afternoon lets the iOS slider pick amounts the ledger can’t hold.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both iOS builds lose about a third of checkouts: the loyalty ledger throws “Rounding necessary” on fractional points." },
      { command: 'remote-config set ios_loyalty_redeem_step 1 --note "ledger stores whole points only"', why: "The slider goes back to whole points on every iOS build within about two minutes." },
      { command: "remote-config history ios_loyalty_redeem_step", why: "The step went to 0.5 at 16:02 for the promotion, when the 500s started." },
      { command: "releases status ios", why: "FAILED falls back to baseline on 7.3.3 and 7.3.0." },
    ],
    postmortem: {
      question: "Why did iOS checkouts that redeemed points fail?",
      options: [
        "The double-points promotion overloaded the loyalty database with traffic from every platform",
        "iOS 7.3.3 sent the wrong customer id with redemptions",
        "The iOS slider let customers redeem half points the ledger can’t store",
        "Android customers had already used up the promotion’s budget",
      ],
      answerIndex: 2,
      explanation: {
        cause: "ios_loyalty_redeem_step was set to 0.5, so the iOS slider produced fractional point amounts, and checkout-api’s ledger, which rounds with RoundingMode.UNNECESSARY into whole points, threw ArithmeticException.",
        why: "Every iOS build reads the step, so the failures were on all iOS builds and only for redemptions. Setting the step back to 1 stopped the slider producing fractions, without a build or a backend change.",
        tell: "Failures only on checkouts with points, only on iOS, and “Rounding necessary” on a points value ending in .5.",
      },
    },
    lostCheckoutsPerPoint: 170,
  },
  {
    slug: "structured-address-array",
    title: "Structured addresses break Android orders",
    severity: "SEV2",
    opensAt: [9, 38],
    briefing:
      "Since 09:21, checkouts from Android 7.3.0 fail with a server error. Android 7.2.4, iOS and web are fine. You’re the mobile on-call. Android 7.3.0 has been rolling out all week and is on most phones.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Android 7.3.0 shipped a new address form, off by default.",
    release: { platform: "android", current: "7.3.0", previous: "7.2.4", adoption: 0.9, day: 6 },
    culprit: {
      key: "address_form_variant",
      description: "Which shipping address form the app shows",
      readBy: "android >= 7.3.0",
      allowed: ["classic", "structured"],
      baseVersion: 1,
      good: "classic",
      bad: "structured",
      by: "felix.adeyemi",
      secondsAgo: 17 * MINUTE,
      note: "structured address form to 100% (ADDR-40)",
    },
    mechanic: {
      kind: "equals",
      where: "server",
      failShare: 1,
      affects: "current",
      message:
        "POST /checkout 500 · checkout-api: JSON parse error: Cannot deserialize value of type `java.lang.String` from Array value (token `JsonToken.START_ARRAY`) at [\"shippingAddress\"]->[\"line1\"]",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 4% for 3m. Errors carry okhttp user agents from Marlow/7.3.0. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "checkout-api tells you what it couldn’t parse. Match that to what changed in the app this morning." },
      { at: 60, from: "Felix Adeyemi · Android", text: "I turned the structured address form on at 09:21. It splits street lines into a list. QA tested it against staging…" },
      { at: 100, from: "Lucas Moreau · Android lead", text: "Should I halt 7.3.0? It’s on 90% of Android phones." },
      { at: 150, from: "Priya Shah · Backend lead", text: "Prod checkout-api still expects line1 as one string. Staging has the list change, prod doesn’t until v4.13." },
    ],
    hints: [
      "One Android build fails every checkout; the build before it doesn’t.",
      "checkout-api names the field it couldn’t read and what shape it got instead.",
      "The new form is already on those phones, and it can be switched without a new build.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Only Android 7.3.0 fails: checkout-api can’t read shippingAddress.line1 as a list." },
      { command: 'remote-config set address_form_variant classic --note "prod checkout-api expects line1 as a string"', why: "7.3.0 goes back to the classic form, which sends line1 as one string, within about two minutes." },
      { command: "remote-config history address_form_variant", why: "The structured form went to 100% at 09:21, when the 500s began." },
      { command: "releases status android", why: "FAILED on 7.3.0 falls to baseline." },
    ],
    postmortem: {
      question: "Why did Android 7.3.0 checkouts fail this morning?",
      options: [
        "Android 7.2.4 phones updating to 7.3.0 lost their saved addresses during the migration",
        "checkout-api rejected addresses outside the United States",
        "The staged rollout put 7.3.0 on too many phones",
        "The new address form sent line1 as a list prod didn’t accept",
      ],
      answerIndex: 3,
      explanation: {
        cause: "address_form_variant was set to structured, and that form sends shippingAddress.line1 as an array. Production checkout-api v4.12.1 still maps line1 to a String, so Jackson refused the body and checkout-api returned 500.",
        why: "Only 7.3.0 has the new form, so only 7.3.0 failed. Staging ran the backend change already, which is why QA passed. Setting the key back to classic fixed installed phones; halting wouldn’t have.",
        tell: "Every 7.3.0 checkout failing, a Jackson START_ARRAY error on line1, and a key change at the minute the 500s began.",
      },
    },
    lostCheckoutsPerPoint: 175,
  },
  {
    slug: "device-tax-estimate",
    title: "iOS totals don’t match the server",
    severity: "SEV2",
    opensAt: [14, 33],
    briefing:
      "Since 14:15, about half of iOS checkouts fail with a server error, mostly for orders shipping to US states with local sales tax. Android and web are fine. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. The tax team wanted faster totals on the iOS checkout screen.",
    release: { platform: "ios", current: "7.4.1", previous: "7.3.3", adoption: 0.3, day: 3 },
    culprit: {
      key: "ios_tax_estimate_source",
      description: "Where the iOS checkout screen gets the tax line: server quote or on-device table",
      readBy: "ios >= 7.2.0",
      allowed: ["server", "device"],
      baseVersion: 3,
      good: "server",
      bad: "device",
      by: "ines.carvalho",
      secondsAgo: 18 * MINUTE,
      note: "on-device tax table for faster totals (TAX-19)",
    },
    mechanic: {
      kind: "equals",
      where: "server",
      failShare: 0.45,
      affects: "all",
      message: "POST /checkout 500 · checkout-api: total_mismatch client_total=6412 server_total=6398 (tax_source=device, ship_to=CO 80202)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 4% for 3m on POST /checkout from the iOS app. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "checkout-api compares the total the app shows with its own. Find out why they disagree." },
      { at: 60, from: "Maya Okonkwo · Support", text: "iPhone customers in Colorado and Louisiana can’t pay. Customers in Oregon say it works." },
      { at: 110, from: "Ines Carvalho · Tax", text: "We switched iOS to the on-device tax table at 14:15. It only has state rates, not city and county ones yet." },
      { at: 170, from: "Lucas Moreau · iOS lead", text: "7.4.1 is only on 30%. Old builds fail too, so it’s not 7.4.1, right?" },
    ],
    hints: [
      "Both iOS builds fail, and only for some destinations.",
      "checkout-api refuses orders whose total differs from its own calculation; look at which line differs.",
      "The tax line on iPhones changed where it comes from this afternoon.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both iOS builds fail with total_mismatch where on-device tax missed local rates." },
      { command: 'remote-config set ios_tax_estimate_source server --note "device table lacks local rates; totals mismatch"', why: "iOS shows the server’s tax quote again, so totals match, within about two minutes." },
      { command: "remote-config history ios_tax_estimate_source", why: "The source went to device at 14:15, when the 500s started." },
      { command: "releases status ios", why: "FAILED falls to baseline on both builds." },
    ],
    postmortem: {
      question: "Why did iOS checkouts to some states fail?",
      options: [
        "The iOS app computed tax on the device without local rates",
        "checkout-api lost its connection to the tax provider for every state with local sales taxes",
        "iOS 7.4.1 rounded every price down by a cent",
        "Support refunded orders in Colorado by mistake",
      ],
      answerIndex: 0,
      explanation: {
        cause: "ios_tax_estimate_source was set to device, and the on-device table held state rates only. Where city or county tax applied, the app’s total was lower than checkout-api’s, which rejects a mismatch with a 500.",
        why: "Every iOS build reads the key, so the failures were on both builds and only where local tax applied. Switching back to the server’s quote made the totals agree.",
        tell: "Failures on all iOS builds, clustered by destination, with total_mismatch showing tax_source=device.",
      },
    },
    lostCheckoutsPerPoint: 260,
  },
  {
    slug: "compact-sheet-index",
    title: "The compact pay sheet crashes",
    severity: "SEV2",
    opensAt: [11, 12],
    briefing:
      "Since 10:55, iPhone customers say the app closes the moment they tap Checkout. checkout-api shows no errors because the requests never arrive. Android and web are fine. You’re the mobile on-call. iOS 7.4.0 is on day 5 of its phased release.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Design was trying a denser checkout sheet on iOS today.",
    release: { platform: "ios", current: "7.4.0", previous: "7.3.2", adoption: 0.45, day: 5 },
    culprit: {
      key: "checkout_sheet_layout",
      description: "Layout of the iOS checkout sheet",
      readBy: "ios >= 7.4.0",
      allowed: ["standard", "compact"],
      baseVersion: 1,
      good: "standard",
      bad: "compact",
      by: "mira.sato",
      secondsAgo: 17 * MINUTE,
      note: "compact sheet for everyone (DES-310)",
    },
    mechanic: {
      kind: "equals",
      where: "client",
      failShare: 0.9,
      affects: "current",
      message: "Fatal error: Index out of range · CheckoutSheetView.swift:212 (CompactSummaryRow.lineItems[3])",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 3m. checkout-api 5xx 0.1%; iOS checkout requests have dropped. Mobile on-call paged." },
      { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "No 5xx means the app dies before it calls us. Crash reports per build will tell you where." },
      { at: 50, from: "Maya Okonkwo · Support", text: "iPhone customers: “App closes when I tap Checkout.” Some say it only happens with four or more items in the bag." },
      { at: 100, from: "Mira Sato · Design", text: "We rolled the compact checkout sheet to everyone at 10:55. It looked great in TestFlight with two items." },
      { at: 160, from: "Lucas Moreau · iOS lead", text: "We can’t pull 7.4.0 back off phones. If it’s the sheet, can we just turn it off?" },
    ],
    hints: [
      "The server sees nothing wrong. The app is failing before it sends anything.",
      "Only the newest iOS build crashes, and the crash points at the checkout sheet’s summary rows.",
      "The sheet’s layout changed this morning, and installed apps can be told to use the old one.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "iOS 7.4.0 crashes in CheckoutSheetView with Index out of range; 7.3.2 is fine." },
      { command: 'remote-config set checkout_sheet_layout standard --note "compact sheet crashes with 4+ items"', why: "7.4.0 shows the standard sheet again on its next fetch, within about two minutes." },
      { command: "remote-config history checkout_sheet_layout", why: "The compact layout went to everyone at 10:55, when the crashes began." },
      { command: "releases status ios", why: "FAILED on 7.4.0 falls to baseline." },
    ],
    postmortem: {
      question: "Why did iPhone customers lose their checkout?",
      options: [
        "checkout-api timed out on bags with four or more items",
        "The phased release installed 7.4.0 on phones that couldn’t run it",
        "The compact sheet indexed past the end of short line-item lists",
        "Apple Pay refused payments while the App Store was rolling 7.4.0 out to more phones",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout_sheet_layout was set to compact. The compact summary row read lineItems[3] without checking the bag’s size, a Swift array index out of range that crashed the app before any request was sent.",
        why: "No request reached checkout-api, so 5xx stayed flat while checkout loss rose. Only 7.4.0 has the compact layout. Setting the key back to standard fixed installed phones; halting the release couldn’t.",
        tell: "Checkout loss with no 5xx, crash reports only from 7.4.0, all inside the compact summary row.",
      },
    },
    lostCheckoutsPerPoint: 240,
  },
  {
    slug: "carrier-quote-decode",
    title: "Carrier quotes without a currency",
    severity: "SEV2",
    opensAt: [15, 47],
    briefing:
      "Since 15:30, most iPhone customers are stuck on “Calculating shipping…” and can’t continue to payment. Android and web are fine, checkout-api shows no errors. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Logistics trialled a direct carrier integration this week.",
    release: { platform: "ios", current: "7.3.3", previous: "7.3.0", adoption: 0.55, day: 6 },
    culprit: {
      key: "ios_shipping_quote_provider",
      description: "Which service the iOS app asks for shipping quotes",
      readBy: "ios >= 7.0.0",
      allowed: ["marlow-rates", "carrier-direct"],
      baseVersion: 8,
      good: "marlow-rates",
      bad: "carrier-direct",
      by: "omari.wells",
      secondsAgo: 17 * MINUTE,
      note: "carrier-direct trial: all iOS (LOG-58)",
    },
    mechanic: {
      kind: "equals",
      where: "client",
      failShare: 0.8,
      affects: "all",
      message:
        'ShippingQuoteService: keyNotFound(CodingKeys(stringValue: "currency", intValue: nil), Swift.DecodingError.Context(codingPath: [], debugDescription: "No value associated with key CodingKeys(stringValue: \\"currency\\", intValue: nil) (\\"currency\\").", underlyingError: nil))',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 3m. checkout-api 5xx flat; iOS checkouts stop before payment. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "If the app never gets to payment, the error is in the app. Check what each build reports." },
      { at: 60, from: "Maya Okonkwo · Support", text: "iPhone customers: “Calculating shipping…” forever. A few on old iPhones say the same, so it’s not just the update." },
      { at: 110, from: "Omari Wells · Logistics", text: "At 15:30 I moved all iOS to the carrier-direct quotes. Their API returns amounts in cents; maybe the field names differ a bit?" },
    ],
    hints: [
      "Every iOS build is stuck in the same place, so the release isn’t it.",
      "The app reports which field it expected in the shipping quote and didn’t find.",
      "iPhones changed where they ask for shipping quotes this afternoon.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both iOS builds fail to decode the shipping quote: the carrier response has no currency key." },
      { command: 'remote-config set ios_shipping_quote_provider marlow-rates --note "carrier-direct quotes have no currency field"', why: "iOS asks Marlow’s own rates service again, whose quotes decode, within about two minutes." },
      { command: "remote-config history ios_shipping_quote_provider", why: "carrier-direct went to all iOS at 15:30, when the stalls began." },
      { command: "releases status ios", why: "FAILED falls back to baseline on both builds." },
    ],
    postmortem: {
      question: "Why were iPhone customers stuck on shipping?",
      options: [
        "The carrier’s quotes lacked a currency field iOS requires",
        "iOS 7.3.3 stopped sending the delivery address to the shipping service on every checkout",
        "Marlow’s rates service went down at 15:30",
        "checkout-api rejected orders with free shipping",
      ],
      answerIndex: 0,
      explanation: {
        cause: "ios_shipping_quote_provider was moved to carrier-direct, whose quotes return amount_cents with no currency key. The iOS app’s Decodable ShippingQuote requires currency, so decoding failed and the screen never finished calculating.",
        why: "All iOS builds read the key, so old and new builds stalled alike, and no request reached checkout-api. Pointing the key back at marlow-rates fixed installed phones in place.",
        tell: "Checkout loss without 5xx, every iOS build stuck on shipping, and a keyNotFound for currency.",
      },
    },
    lostCheckoutsPerPoint: 460,
  },
  {
    slug: "eu-host-unresolved",
    title: "Android points at a host that doesn’t exist",
    severity: "SEV2",
    opensAt: [8, 52],
    briefing:
      "Since 08:34, the Android app says “No connection” at checkout for everyone, on every build. iOS and web are fine and checkout-api looks healthy. You’re the mobile on-call. Android 7.3.1 is on day 3 of its staged rollout.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Platform is preparing an EU region for the apps.",
    release: { platform: "android", current: "7.3.1", previous: "7.2.4", adoption: 0.25, day: 3 },
    culprit: {
      key: "android_api_base_host",
      description: "Host the Android app sends API calls to",
      readBy: "android >= 6.4.0",
      allowed: null,
      baseVersion: 2,
      good: "api.marlow.shop",
      bad: "api-eu.marlow.shop",
      by: "ruth.okafor",
      secondsAgo: 18 * MINUTE,
      note: "EU region: route Android to eu host (PLAT-903)",
    },
    mechanic: {
      kind: "equals",
      where: "client",
      failShare: 1,
      affects: "all",
      message: 'java.net.UnknownHostException: Unable to resolve host "api-eu.marlow.shop": No address associated with hostname',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 3m. Android checkout requests have dropped to zero; checkout-api 5xx 0.1%. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Every Android build at once? That’s config, not code. See what the apps report." },
      { at: 60, from: "Ruth Okafor · Platform", text: "I switched Android to the EU host at 08:34 for the region test. Infra creates its DNS record next week, though…" },
      { at: 100, from: "Lucas Moreau · Android lead", text: "Should I halt 7.3.1 while we look?" },
      { at: 150, from: "Sam Tan · Eng manager", text: "No Android orders for twenty minutes. What’s the plan?" },
    ],
    hints: [
      "Every Android build fails the same way, so no release decision changes this.",
      "The apps can’t find the server they’re told to call.",
      "Something told installed Android apps to call a different host this morning.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Every Android build fails with UnknownHostException for api-eu.marlow.shop, a name with no DNS record yet." },
      { command: 'remote-config set android_api_base_host api.marlow.shop --note "eu host has no DNS record yet"', why: "Android apps call the US host again on their next fetch, within about two minutes." },
      { command: "remote-config history android_api_base_host", why: "The host moved to api-eu at 08:34, when Android checkouts stopped." },
      { command: "releases status android", why: "FAILED falls from 100% to baseline on both builds." },
    ],
    postmortem: {
      question: "Why couldn’t Android customers check out?",
      options: [
        "Android 7.3.1 broke the networking layer for older phones",
        "Google Play revoked the app’s network permission during the staged rollout of 7.3.1",
        "checkout-api blocked requests from the EU",
        "The apps were sent to a host with no DNS record",
      ],
      answerIndex: 3,
      explanation: {
        cause: "android_api_base_host was set to api-eu.marlow.shop, which has no DNS record yet. Every Android build failed to resolve it and showed “No connection”.",
        why: "No request reached checkout-api, so 5xx stayed flat. Every Android build reads the key, so release controls were irrelevant; setting the host back fixed installed apps in place.",
        tell: "Android checkouts falling to zero on every build at once, with UnknownHostException naming the new host.",
      },
    },
    lostCheckoutsPerPoint: 190,
  },
  {
    slug: "threshold-decimal-comma",
    title: "A comma in the free-shipping threshold",
    severity: "SEV2",
    opensAt: [12, 18],
    briefing:
      "Since 12:01, Android 7.3.1 crashes when customers open their bag to check out. Android 7.2.4, iOS and web are fine. You’re the mobile on-call. Android 7.3.1 is on most phones.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Marketing ran a free-shipping change from the Berlin office today.",
    release: { platform: "android", current: "7.3.1", previous: "7.2.4", adoption: 0.85, day: 6 },
    culprit: {
      key: "free_shipping_threshold",
      description: "Order subtotal (USD) above which shipping is free; the bag shows progress toward it",
      readBy: "android >= 7.3.0",
      allowed: null,
      baseVersion: 11,
      good: "49.00",
      bad: "49,00",
      by: "jana.vogel",
      secondsAgo: 17 * MINUTE,
      note: "free shipping from $49 (MKT-622)",
    },
    mechanic: {
      kind: "equals",
      where: "client",
      failShare: 1,
      affects: "current",
      message: 'java.lang.NumberFormatException: For input string: "49,00" · at com.marlow.bag.FreeShippingBanner.bind(FreeShippingBanner.kt:41)',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 8% for 3m. Android crash-free sessions falling; checkout-api 5xx flat. Mobile on-call paged." },
      { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Crashes on one build and not the other. Read the crash, then ask what that build reads that the old one doesn’t." },
      { at: 60, from: "Jana Vogel · Marketing", text: "I lowered the free-shipping threshold to 49 at 12:01. Our German keyboard… did I type a comma?" },
      { at: 110, from: "Lucas Moreau · Android lead", text: "7.3.1 added the free-shipping progress banner. 7.2.4 doesn’t have it." },
    ],
    hints: [
      "Only the newest Android build crashes, and it crashes when the bag opens.",
      "The crash is a number that couldn’t be parsed. Look at the exact text it got.",
      "That number reaches installed phones without a release, and somebody edited it at noon.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Android 7.3.1 crashes with NumberFormatException on \"49,00\" in the free-shipping banner." },
      { command: 'remote-config set free_shipping_threshold 49.00 --note "decimal comma crashed the 7.3.1 bag"', why: "7.3.1 parses 49.00 on its next fetch and the bag opens again, within about two minutes." },
      { command: "remote-config history free_shipping_threshold", why: "jana.vogel published 49,00 at 12:01; the previous value used a decimal point." },
      { command: "releases status android", why: "FAILED on 7.3.1 falls to baseline." },
    ],
    postmortem: {
      question: "Why did Android 7.3.1 crash when customers opened their bag?",
      options: [
        "Free shipping made checkout-api reject orders under $49",
        "A comma-decimal threshold couldn’t be parsed by 7.3.1’s banner",
        "Android 7.3.1 crashed on every phone set to a German locale, whatever the threshold was",
        "Google Play delivered a corrupted 7.3.1 package",
      ],
      answerIndex: 1,
      explanation: {
        cause: "free_shipping_threshold was published as \"49,00\". 7.3.1’s new free-shipping banner parses it with toDouble(), which accepts only a decimal point, so it threw NumberFormatException as the bag opened.",
        why: "7.2.4 doesn’t read the key, so only 7.3.1 crashed, and checkout-api saw nothing. Republishing the value with a decimal point fixed installed phones without a build.",
        tell: "A crash only on 7.3.1, a NumberFormatException quoting “49,00”, and a config edit at the minute crashes began.",
      },
    },
    lostCheckoutsPerPoint: 165,
  },
  {
    slug: "native-3ds-nil",
    title: "Native 3-D Secure unwraps nil",
    severity: "SEV3",
    opensAt: [17, 4],
    briefing:
      "Since 16:47, iPhone customers whose bank asks for a 3-D Secure check see the app close instead of the bank’s screen. Other card payments go through. Android and web are fine. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Payments has wanted a native 3-D Secure screen on iOS for months.",
    release: { platform: "ios", current: "7.3.2", previous: "7.2.4", adoption: 0.6, day: 6 },
    culprit: {
      key: "ios_three_ds_challenge_ui",
      description: "How iOS shows a bank’s 3-D Secure challenge: web view or native screen",
      readBy: "ios >= 7.3.2",
      allowed: ["webview", "native"],
      baseVersion: 1,
      good: "webview",
      bad: "native",
      by: "dmitri.volkov",
      secondsAgo: 17 * MINUTE,
      note: "native 3DS challenge screen GA (PAY-415)",
    },
    mechanic: {
      kind: "equals",
      where: "client",
      failShare: 0.3,
      affects: "current",
      message: "Fatal error: Unexpectedly found nil while unwrapping an Optional value · ThreeDSChallengeView.swift:88 (acsSignedContent)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout loss > 4% for 3m. iOS crash-free sessions down; checkout-api 5xx flat. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Crashes only when a bank challenges the card? Find which build, and which screen." },
      { at: 70, from: "Dmitri Volkov · Payments", text: "Native 3-D Secure went GA on iOS at 16:47. Some banks don’t send acsSignedContent in the challenge… I assumed they all did." },
      { at: 130, from: "Lucas Moreau · iOS lead", text: "7.2.4 doesn’t have the native screen at all, it always uses the web view." },
    ],
    hints: [
      "Only card payments that need the bank’s extra check crash, and only on the newest iOS build.",
      "The crash names a value the app expected the bank to send.",
      "The native challenge screen was turned on this afternoon, and installed apps can go back to the old one.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "iOS 7.3.2 crashes in ThreeDSChallengeView unwrapping a missing acsSignedContent." },
      { command: 'remote-config set ios_three_ds_challenge_ui webview --note "native screen crashes when the ACS omits signed content"', why: "7.3.2 shows the bank’s challenge in the web view again, within about two minutes." },
      { command: "remote-config history ios_three_ds_challenge_ui", why: "native went GA at 16:47, when the crashes started." },
      { command: "releases status ios", why: "FAILED on 7.3.2 falls back to baseline." },
    ],
    postmortem: {
      question: "Why did iPhone 3-D Secure checkouts crash?",
      options: [
        "Banks stopped supporting 3-D Secure on iOS",
        "The phased release replaced the payment SDK on every iPhone, including ones still on iOS 7.2.4",
        "The native challenge screen force-unwrapped a field some banks omit",
        "checkout-api declined every card that needed a challenge",
      ],
      answerIndex: 2,
      explanation: {
        cause: "ios_three_ds_challenge_ui was set to native. The native screen force-unwraps acsSignedContent, which some banks’ access control servers leave out, so the app crashed on their challenges.",
        why: "Only 7.3.2 has the native screen and only challenged cards hit it, so failures were a slice of one build. The web view renders whatever the bank sends; switching back fixed installed phones.",
        tell: "Crashes only on challenged cards, only on 7.3.2, with a nil unwrap in ThreeDSChallengeView.",
      },
    },
    lostCheckoutsPerPoint: 105,
  },
  {
    slug: "card-method-dropped",
    title: "The card option vanished on iOS",
    severity: "SEV2",
    opensAt: [10, 9],
    briefing:
      "Since 09:52, iPhone customers without Apple Pay or PayPal can’t finish checkout: the payment step shows no card option. Android and web are fine. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Growth reordered the iOS payment step this morning.",
    release: { platform: "ios", current: "7.4.0", previous: "7.3.2", adoption: 0.4, day: 5 },
    culprit: {
      key: "ios_checkout_payment_methods",
      description: "Payment methods the iOS payment step offers, in order (comma-separated)",
      readBy: "ios >= 7.0.0",
      allowed: null,
      baseVersion: 14,
      good: "card,apple_pay,paypal",
      bad: "apple_pay,paypal",
      by: "zoe.whitaker",
      secondsAgo: 17 * MINUTE,
      note: "wallet-first payment step: Apple Pay on top (GRO-512)",
    },
    mechanic: {
      kind: "lacks",
      entry: "card",
      where: "client",
      failShare: 0.6,
      affects: "all",
      message: 'PaymentMethodPicker: no usable payment method (offered: apple_pay,paypal; wallet: none) · checkout abandoned at payment step',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 3m. iOS payment-step abandonment up sharply; checkout-api 5xx flat. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Look at what the app logs at the payment step on each build." },
      { at: 60, from: "Maya Okonkwo · Support", text: "iPhone customers: “Where do I enter my card?” Only Apple Pay and PayPal are shown." },
      { at: 100, from: "Zoe Whitaker · Growth", text: "I reordered the iOS payment methods at 09:52 to put Apple Pay first. I only moved things… I think." },
      { at: 150, from: "Lucas Moreau · iOS lead", text: "Old builds too? Then halting 7.4.0 won’t do anything." },
    ],
    hints: [
      "Every iOS build is affected, and only customers who pay by card.",
      "The app logs which payment methods it was told to offer.",
      "The list the payment step reads changed this morning. Compare it with the version before.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both iOS builds abandon at the payment step: the offered methods are only apple_pay and paypal." },
      { command: "remote-config history ios_checkout_payment_methods", why: "At 09:52 the list went from card,apple_pay,paypal to apple_pay,paypal: card was dropped, not moved." },
      { command: 'remote-config set ios_checkout_payment_methods card,apple_pay,paypal --note "reorder dropped card"', why: "iPhones offer card again on their next fetch, within about two minutes." },
      { command: "releases status ios", why: "FAILED falls to baseline on both builds." },
    ],
    postmortem: {
      question: "Why couldn’t iPhone customers pay by card?",
      options: [
        "Apple Pay replaced card payments in iOS 7.4.0",
        "The card processor was down for iOS",
        "Card payments needed a newer iOS version than most customers run, after Apple’s latest update",
        "Reordering the payment-method list dropped card",
      ],
      answerIndex: 3,
      explanation: {
        cause: "ios_checkout_payment_methods was republished as apple_pay,paypal when the goal was to move Apple Pay first; card fell out of the list, so the payment step stopped offering it.",
        why: "Every iOS build reads the list, so the failures were on old and new builds alike, only for customers without a wallet. Restoring card to the list fixed installed phones without a release.",
        tell: "Payment-step abandonment on every iOS build, no 5xx, and a list change at the minute it began.",
      },
    },
    lostCheckoutsPerPoint: 345,
  },
  {
    slug: "webview-acs-origin",
    title: "The bank’s page is blocked in the app",
    severity: "SEV3",
    opensAt: [19, 26],
    briefing:
      "Since 19:08, some Android card payments stall on a blank screen where the bank’s security check should load. iOS and web are fine. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. Security tidied up the Android web view allowlist this evening.",
    release: { platform: "android", current: "7.3.1", previous: "7.2.4", adoption: 0.45, day: 5 },
    culprit: {
      key: "android_webview_allowed_origins",
      description: "Origins the Android in-app web view may load (comma-separated)",
      readBy: "android >= 7.0.0",
      allowed: null,
      baseVersion: 5,
      good: "https://www.marlow.shop,https://help.marlow.shop,https://acs.halyardpay.com",
      bad: "https://www.marlow.shop,https://help.marlow.shop",
      by: "kai.nakamura",
      secondsAgo: 18 * MINUTE,
      note: "remove origins we don't own (SEC-1044)",
    },
    mechanic: {
      kind: "lacks",
      entry: "https://acs.halyardpay.com",
      where: "client",
      failShare: 0.3,
      affects: "all",
      message: "MarlowWebView: blocked navigation to https://acs.halyardpay.com/challenge (origin not in android_webview_allowed_origins)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout loss > 3% for 3m. Android card checkouts stalling; checkout-api 5xx flat. Mobile on-call paged." },
      { at: 20, from: "Jonah Reyes · Mobile lead (your mentor)", text: "A blank screen in the app usually means the web view refused to load something. Check the app’s errors." },
      { at: 70, from: "Kai Nakamura · Security", text: "At 19:08 I removed origins from the Android web view allowlist that aren’t ours. halyardpay.com looked unfamiliar." },
      { at: 120, from: "Dmitri Volkov · Payments", text: "Halyard Pay runs the 3-D Secure pages for our card processor. Every challenged card goes there." },
    ],
    hints: [
      "Only card payments that need the bank’s check stall, on every Android build.",
      "The app logs which page it refused to load, and why.",
      "Something that decides which pages the app may open was edited this evening.",
    ],
    solution: [
      { command: `releases ${ERRORS_VIEW}`, why: "Both Android builds block navigation to acs.halyardpay.com: it’s not in the allowlist." },
      { command: "remote-config history android_webview_allowed_origins", why: "At 19:08 the 3-D Secure origin was removed from the list." },
      {
        command: 'remote-config set android_webview_allowed_origins https://www.marlow.shop,https://help.marlow.shop,https://acs.halyardpay.com --note "halyardpay hosts 3DS challenges"',
        why: "Android apps load the bank’s challenge again on their next fetch, within about two minutes.",
      },
      { command: "releases status android", why: "FAILED falls to baseline on both builds." },
    ],
    postmortem: {
      question: "Why did Android 3-D Secure payments stall?",
      options: [
        "The web view allowlist lost the 3-D Secure provider’s origin",
        "Android 7.3.1 removed the web view from the app",
        "Halyard Pay’s challenge pages were down for every merchant using them that evening",
        "checkout-api declined cards that needed a challenge",
      ],
      answerIndex: 0,
      explanation: {
        cause: "android_webview_allowed_origins was trimmed to Marlow’s own origins, dropping acs.halyardpay.com, which hosts the card processor’s 3-D Secure challenges. The app’s web view refused to load them.",
        why: "Every Android build enforces the list, and only challenged cards navigate there, so a slice of every build stalled with no server error. Putting the origin back fixed installed apps.",
        tell: "Blank challenge screens on every Android build, no 5xx, and the app logging a blocked navigation to the ACS host.",
      },
    },
    lostCheckoutsPerPoint: 60,
  },
  {
    slug: "force-update-typo",
    title: "Everyone is told to update",
    severity: "SEV1",
    opensAt: [7, 45],
    briefing:
      "Since 07:28, every iPhone and Android customer sees “A new version of Marlow is required” and can’t check out, even on the newest builds. Updating from the store doesn’t help: there’s nothing newer to install. Web is fine. You’re the mobile on-call.",
    roleBriefing: "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. A release manager meant to retire 7.0.x builds this morning; they have a bug that double-submits orders.",
    release: { platform: "ios", current: "7.3.0", previous: "7.2.4", adoption: 0.5, day: 6 },
    culprit: {
      key: "force_update_below",
      description: "App builds older than this version get a blocking update screen",
      readBy: "ios >= 6.0.0, android >= 6.0.0",
      allowed: null,
      baseVersion: 6,
      good: "7.0.0",
      bad: "7.10",
      by: "amara.diallo",
      secondsAgo: 17 * MINUTE,
      note: "retire 7.0.x: double-submit bug (MOB-2190)",
    },
    mechanic: { kind: "wall", floor: "7.0.9" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. App checkouts have stopped; checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "A forced-update screen comes from remote config. Look at the release console first: it says how many sessions are walled." },
      { at: 50, from: "Maya Okonkwo · Support", text: "App customers: “A new version is required,” and the App Store and Play Store say they’re up to date." },
      { at: 100, from: "Amara Diallo · Release manager", text: "I set the minimum at 07:28 to retire 7.0.x. I meant 7.1.0. Did I…?" },
      { at: 160, from: "Elena Ruiz · VP Engineering", text: "Half our customers are on the apps. ETA?" },
    ],
    hints: [
      "Every app build shows the update screen, including the newest, so no release can fix this.",
      "Version numbers compare part by part, as numbers. Read the minimum carefully.",
      "Set the minimum to what was meant, so 7.0.x stays retired.",
    ],
    solution: [
      { command: "releases status", why: "Every iOS and Android build has nearly all of its sessions on the forced-update screen." },
      { command: "remote-config history force_update_below", why: "07:28: 7.0.0 → 7.10. As versions, 7.10 is above 7.3.0 (10 > 3), so every installed build is too old." },
      { command: 'remote-config set force_update_below 7.1.0 --note "7.10 was a typo for 7.1.0"', why: "Builds 7.2.4 and up pass again on their next fetch, within about two minutes, and 7.0.x stays retired." },
      { command: "releases status", why: "The forced-update share falls to zero on every build." },
    ],
    postmortem: {
      question: "Why did every app customer see the update screen?",
      options: [
        "The App Store and Play Store hid the newest builds from customers in every region",
        "The minimum was set to 7.10, which outranks every build",
        "iOS 7.3.0’s phased release forced older phones to update",
        "checkout-api refused requests from 7.0.x builds",
      ],
      answerIndex: 1,
      explanation: {
        cause: "force_update_below was published as 7.10 instead of 7.1.0. Versions compare part by part as numbers, and 10 is greater than every installed build’s minor version, so every app build fell below the minimum.",
        why: "The update screen stops checkout before any request, so 5xx stayed at zero. No newer build existed, so updating couldn’t help; setting the minimum to 7.1.0 let current builds through and kept 7.0.x blocked.",
        tell: "Every app build walled, newest included, and a minimum whose minor version is larger than any shipped build’s.",
      },
    },
    lostCheckoutsPerPoint: 770,
  },
  {
    slug: "android-retry-flip",
    title: "Android retries every charge at once",
    severity: "SEV2",
    opensAt: [14, 3],
    briefing:
      "The payment gateway has been degraded since 13:40. A flash-sale push went out at 14:00, and checkout hasn’t recovered since the rush ended. The gateway says we’re sending far more charge attempts than orders. You’re the mobile on-call. Android 7.3.0 is on day 6 of its staged rollout.",
    roleBriefing:
      "You own the iOS and Android apps: releases for builds and their field telemetry, remote-config for what installed apps do. An Android engineer changed checkout retries during the gateway blips before the sale.",
    release: { platform: "android", current: "7.3.0", previous: "7.2.4", adoption: 0.8, day: 6 },
    culprit: {
      key: "android_checkout_retry",
      description: "How Android 7.3.0 retries POST /checkout on timeout or 5xx",
      readBy: "android >= 7.3.0",
      allowed: RETRY_POLICY_NAMES,
      baseVersion: 3,
      good: "none",
      bad: "immediate",
      by: "lucas.moreau",
      secondsAgo: 11 * MINUTE,
      note: "hide gateway blips from customers: retry right away",
    },
    mechanic: {
      kind: "storm",
      chargesPerSecond: 140,
      surgeRps: 480,
      surgeSeconds: 50,
      gatewayStatus: "Elevated latency on card authorisations — merchants should retry with backoff (since 13:40)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% for 3m. Mobile on-call paged: Android checkout requests per order are up." },
      { at: 15, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Compare REQ/ORDER across builds in the release console. One request per order reads 1.00." },
      { at: 60, from: "Sam Tan · Eng manager", text: "The gateway TAM says the sale rush is over but we’re still sending three or four charge attempts per order. They want us to back off." },
      { at: 110, from: "Lucas Moreau · Android lead", text: "I set Android to retry right away at 13:52 so customers wouldn’t see the gateway blips. Could that be feeding this?" },
      { at: 160, from: "Jonah Reyes · Mobile lead (your mentor)", text: "Halting 7.3.0 won’t change phones that have it. Its retry behaviour comes from remote config; give it one with backoff." },
    ],
    hints: [
      "Compare how many checkout requests each app build sends for every order.",
      "The rush is over but the gateway queue never drains. Something keeps refilling it.",
      "The newest Android build takes its retry behaviour from remote config, and the value it was given this afternoon has no backoff.",
    ],
    solution: [
      { command: "releases status android", why: "Android 7.3.0 sends several checkout requests per order; 7.2.4 sends one." },
      { command: 'remote-config set android_checkout_retry backoff --note "instant retries keep the gateway queue full"', why: "7.3.0 retries with backoff, jitter, a retry budget and an Idempotency-Key, within about two minutes." },
      { command: "remote-config history android_checkout_retry", why: "lucas.moreau set immediate at 13:52; your change is now the newest version." },
      { command: "releases status android", why: "REQ/ORDER on 7.3.0 falls toward 1.00 as apps fetch the new policy." },
    ],
    postmortem: {
      question: "What kept checkout failing after the flash-sale rush had passed?",
      options: [
        "The gateway went down for every merchant at 14:00 and has not come back up since",
        "iOS 7.3.0 double-submitted every order",
        "Android 7.3.0 retried every failed charge at once",
        "checkout-api ran out of pods during the sale",
      ],
      answerIndex: 2,
      explanation: {
        cause: "android_checkout_retry was set to immediate at 13:52: up to three instant retries per failed checkout, no backoff and no Idempotency-Key.",
        why: "With the gateway degraded, the sale rush pushed its queue past checkout-api’s 3 s timeout. Every timeout made Android 7.3.0 send more charge attempts, so the queue never drained after the rush. Backoff with a retry budget brought demand back under the gateway’s capacity.",
        tell: "REQ/ORDER well above 1 on Android 7.3.0 only, with organic traffic back to normal and the gateway still degraded.",
      },
    },
    lostCheckoutsPerPoint: 1000,
  },
];

/** Fourteen guided mobile incidents: one remote-config change caused each, and setting it right fixes installed apps. */
export const MOBILE_TIER1_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
