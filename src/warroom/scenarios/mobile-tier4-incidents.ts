import type { CommsMessage, Objective, Postmortem, Scenario } from "../scenario.ts";
import { clientSegments, triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { configValue, findConfig, type ClientBuild, type ClientDefect, type Commerce, type DefectTrigger, type Platform, type RemoteConfigEntry } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";
import { androidUserAgent, checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_REMOTE_CONFIG } from "./checkout-commerce.ts";

/**
 * Mobile tier 4: a remote-config value every installed build reads has broken checkout. Pausing the
 * release in progress, or reverting the change that looks guilty, does nothing; some incidents also
 * offer a shortcut that restores checkout by switching a safeguard off.
 */

const MIN = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
const BOTH_APPS = "ios >= 7.0.0, android >= 7.0.0";

type AppId = "ios" | "android";

/** What the key holds while checkout fails: a value that must go, or a list that must gain an entry. */
type Cause =
  | { readonly entry: RemoteConfigEntry; readonly bad: string; readonly fixValue: string }
  | { readonly entry: RemoteConfigEntry; readonly requires: string; readonly fixValue: string };

/** A safeguard whose off position also restores checkout, and the objective that says it must stay on. */
type Shortcut = {
  readonly key: string;
  /** Absent when the key is one of SHOP_REMOTE_CONFIG's. */
  readonly entry?: RemoteConfigEntry;
  readonly safe: string;
  readonly unsafe: string;
  readonly objective: string;
  /** OUTCOME column while the shortcut lets the failing checkouts through. */
  readonly bypassed: string;
};

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly service: string;
  readonly opensAt: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  /** The release in progress; halting it is the move that does nothing. */
  readonly phased: { readonly platform: AppId; readonly current: string; readonly previous: string; readonly adoption: number; readonly day: number };
  /** The other app's single, fully released build. */
  readonly steady: string;
  readonly affects: readonly AppId[];
  /** Share of an affected build's checkouts that fail while the cause holds. */
  readonly failShare: number;
  readonly messages: Partial<Record<AppId, string>>;
  readonly cause: Cause;
  readonly fixNote: string;
  /** A list entry the fix must keep, for incidents where reverting the list would undo a launch. */
  readonly keeps?: { readonly entry: string; readonly objective: string };
  readonly shortcut?: Shortcut;
  /** The recent change everyone suspects; reverting it changes nothing. */
  readonly decoy: RemoteConfigEntry;
  readonly evidence: { readonly name: string; readonly description: string; readonly title: string; readonly outcome: string; readonly samples: readonly string[]; readonly clean: string };
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly why: { readonly view: string; readonly fix: string; readonly status: string; readonly check: string };
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
};

function config(key: string, description: string, allowed: readonly string[] | null, baseVersion: number, history: RemoteConfigEntry["history"], readBy = BOTH_APPS): RemoteConfigEntry {
  return { key, description, readBy, allowed, baseVersion, history };
}

function iosBuildNumber(version: string): number {
  return Number(version.split(".").join("")) * 10 + 1;
}

function causeTrigger(cause: Cause): DefectTrigger {
  return "bad" in cause ? { remoteConfig: cause.entry.key, failsWhen: cause.bad } : { remoteConfig: cause.entry.key, failsWithout: cause.requires };
}

function fullTrigger(row: Row): DefectTrigger {
  const cause = causeTrigger(row.cause);
  return row.shortcut ? { all: [cause, { remoteConfig: row.shortcut.key, failsWhen: row.shortcut.safe }] } : cause;
}

function configOf(state: ClusterState, key: string): string | undefined {
  const entry = state.commerce && findConfig(state.commerce, key);
  return entry ? configValue(entry) : undefined;
}

function listHas(value: string, item: string): boolean {
  return value.split(",").some((part) => part.trim() === item);
}

function isCauseFixed(row: Row, state: ClusterState): boolean {
  const value = configOf(state, row.cause.entry.key) ?? "";
  return "bad" in row.cause ? value !== row.cause.bad : listHas(value, row.cause.requires);
}

function commerce(row: Row): Commerce {
  const defects = (app: AppId): readonly ClientDefect[] => {
    const message = row.messages[app];
    return row.affects.includes(app) && message ? [{ trigger: fullTrigger(row), failShare: row.failShare, where: "client", message }] : [];
  };
  const build = (app: AppId, version: string): ClientBuild => ({
    version,
    userAgent: app === "ios" ? iosUserAgent(version, iosBuildNumber(version)) : androidUserAgent(version),
    timeoutMs: app === "ios" ? 10_000 : 30_000,
    retry: NO_RETRY,
    defects: defects(app),
  });
  const { phased } = row;
  const steadyApp: AppId = phased.platform === "ios" ? "android" : "ios";
  const inRelease: Partial<Omit<Platform, "id">> = {
    current: build(phased.platform, phased.current),
    previous: build(phased.platform, phased.previous),
    adoption: phased.adoption,
    rollout: { kind: "phased", day: phased.day, isPaused: false, adoptionPerSecond: 0.00004 },
  };
  const released: Partial<Omit<Platform, "id">> = { current: build(steadyApp, row.steady) };
  return checkoutCommerce({
    platforms: phased.platform === "ios" ? { ios: inRelease, android: released } : { android: inRelease, ios: released },
    remoteConfig: [row.cause.entry, ...(row.shortcut?.entry ? [row.shortcut.entry] : []), row.decoy, ...SHOP_REMOTE_CONFIG],
  });
}

function evidenceLines(row: Row, state: ClusterState): readonly string[] {
  const shop = state.commerce;
  if (!shop) return [];
  const failing = triggerShare(causeTrigger(row.cause), shop, state.t);
  const blocking = triggerShare(fullTrigger(row), shop, state.t);
  const apps = clientSegments(shop, state.t).filter((segment) => (row.affects as readonly string[]).includes(segment.platform));
  const perMinute = (share: number) => Math.round(shop.pulse.organicCheckoutsPerSecond * share * failing * row.failShare * 60).toLocaleString("en-US");
  const outcome = failing === 0 ? "—" : blocking > 0 ? row.evidence.outcome : (row.shortcut?.bypassed ?? row.evidence.outcome);
  const rows = apps.map((segment) => [`${segment.platform} ${segment.version}`.padEnd(16), perMinute(segment.share).padStart(14), outcome].join("   "));
  const header = [`${row.evidence.title}, last 5 min`, `${"BUILD".padEnd(16)}   ${"FAILURES/MIN".padStart(14)}   OUTCOME`, ...rows];
  return failing === 0 ? [...header, "", row.evidence.clean] : [...header, "", ...row.evidence.samples];
}

function fixCommand(row: Row): string {
  return `remote-config set ${row.cause.entry.key} ${row.cause.fixValue} --note "${row.fixNote}"`;
}

function toScenario(row: Row): Scenario {
  const id = `mob-t4-${row.slug}`;
  const { shortcut, keeps } = row;
  const causeKey = row.cause.entry.key;
  const objectives = (state: ClusterState): readonly Objective[] => [
    ...(shortcut ? [{ role: "mobile" as const, label: shortcut.objective, isMet: configOf(state, shortcut.key) === shortcut.safe }] : []),
    ...(keeps ? [{ role: "mobile" as const, label: keeps.objective, isMet: listHas(configOf(state, causeKey) ?? "", keeps.entry) }] : []),
  ];
  return {
    id,
    title: row.title,
    tier: 4,
    severity: row.severity,
    service: row.service,
    briefing: row.briefing,
    roles: ["mobile"],
    roleBriefings: { mobile: row.roleBriefing },
    suggestions: {
      mobile: [
        "releases status",
        `releases ${row.evidence.name}`,
        "remote-config list",
        `releases halt ${row.phased.platform} ${row.phased.current}`,
        `remote-config history ${row.decoy.key}`,
        shortcut ? `remote-config set ${shortcut.key} ${shortcut.unsafe}` : `remote-config get ${causeKey}`,
      ],
    },
    opensAtSecondOfDay: row.opensAt,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [
          { number: 8, tag: "v4.12.1", changeCause: "v4.12.1 order export batching", traits: [] },
          { number: 9, tag: "v4.12.4", changeCause: "v4.12.4 bump netty to 4.1.114", traits: [] },
        ],
        revision: 9,
        podsStartedAgo: 3 * DAY,
        commerce: commerce(row),
      }),
    alertMetric: { label: "checkout loss", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
    evidence: [{ tool: "releases", name: row.evidence.name, description: row.evidence.description, run: (state) => evidenceLines(row, state) }],
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    isRootCauseFixed: (state) => isOnCleanBuild(state) && isCauseFixed(row, state),
    ...(shortcut || keeps ? { objectives } : {}),
    externals: [],
    comms: row.comms,
    hints: row.hints,
    solution: {
      mobile: [
        { command: `releases ${row.evidence.name}`, why: row.why.view },
        { command: fixCommand(row), why: row.why.fix },
        { command: "releases status", why: row.why.status },
        { command: shortcut ? `remote-config get ${shortcut.key}` : `remote-config history ${causeKey}`, why: row.why.check },
      ],
    },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "cleartext-edge-url",
    title: "The CDN cutover the apps refuse to use",
    severity: "SEV1",
    service: "api-edge",
    opensAt: 9 * HOUR + 41 * MIN,
    briefing:
      "Since about 09:32 no iOS or Android customer has completed a checkout. checkout-api traffic from the apps has fallen to nothing, web is fine, and every installed app build fails the same way. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and their field telemetry, remote-config for what installed apps do. Infra moved the API behind a new CDN edge this morning; the apps learn the API’s address from remote config.",
    phased: { platform: "ios", current: "7.4.0", previous: "7.3.2", adoption: 0.18, day: 3 },
    steady: "7.3.4",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: "App Transport Security has blocked a cleartext HTTP (http) resource load since it is insecure. Use HTTPS instead or add Exception Domains to your app's Info.plist.",
      android: "java.net.UnknownServiceException: CLEARTEXT communication to edge.marlow.shop not permitted by network security policy",
    },
    cause: {
      entry: config("api_base_url", "Base URL every API call is made against", null, 6, [
        { at: -400 * DAY, by: "kai.nakamura", from: "https://api.marlow.app", to: "https://api.marlow.shop", note: "domain move" },
        { at: -9 * MIN, by: "ines.duarte", from: "https://api.marlow.shop", to: "http://edge.marlow.shop", note: "CDN cutover (INFRA-1190)" },
      ]),
      bad: "http://edge.marlow.shop",
      fixValue: "https://edge.marlow.shop",
    },
    fixNote: "edge URL needs https; ATS and the network security config block cleartext",
    decoy: config("image_cdn_host", "Host product images load from", null, 4, [
      { at: -5 * MIN, by: "ines.duarte", from: "images.marlow.shop", to: "media.marlow.shop", note: "CDN cutover (INFRA-1190)" },
    ]),
    evidence: {
      name: "net-errors",
      description: "Network-layer failures on API calls by app build (app telemetry)",
      title: "API calls refused by the OS networking stack, from app telemetry",
      outcome: "blocked before sending",
      samples: [
        "Sample, ios 7.4.0 (URLSession, forwarded by the app's logger):",
        "App Transport Security has blocked a cleartext HTTP (http) resource load since it is insecure. Use HTTPS instead or add Exception Domains to your app's Info.plist.",
        "  request: POST http://edge.marlow.shop/v2/checkout",
        "",
        "Sample, android 7.3.4 (OkHttp):",
        "java.net.UnknownServiceException: CLEARTEXT communication to edge.marlow.shop not permitted by network security policy",
        "  request: POST http://edge.marlow.shop/v2/checkout",
      ],
      clean: "No API calls refused by the OS.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%; app checkout volume has fallen to zero. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Apps say “Something went wrong. Please try again.” on every screen that loads data. Product images still show. Web is fine." },
      { at: 70, from: "Ines Duarte · Infra", text: "The CDN cutover went out at 09:32 and 09:36. Edge dashboards are green: TLS handshakes fine, cache hit rate normal, zero errors." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.4.0 is on day 3 of its phased release. Pause it? It touched the networking layer." },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "The image host moved in the same cutover. Revert image_cdn_host and see if that clears it?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Every app customer, and the edge says it’s healthy. Where are we?" },
    ],
    hints: [
      "The edge reports no errors because the apps never send it anything. Ask the apps why.",
      "Old builds and new builds fail together, so the build is not the variable. What did every build learn this morning?",
      "Look closely at the address the apps were given, character by character.",
    ],
    why: {
      view: "Both operating systems refuse the call before it leaves the phone: iOS App Transport Security and Android’s network security config block cleartext, and the request line shows http://.",
      fix: "The cutover published the edge URL without TLS. Publishing it as https lets every installed build reach the edge within about two minutes.",
      status: "FAILED falls toward 0% on every build. Pausing 7.4.0 would have changed nothing: 7.3.2 and Android read the same URL.",
      check: "The history shows the 09:32 change that dropped the s, and the fix after it.",
    },
    postmortem: {
      question: "Why did app checkouts stop at 09:32?",
      options: [
        "The new CDN edge was failing its TLS handshakes with every phone",
        "Remote config sent the apps an http:// URL, which both OSes block",
        "iOS 7.4.0 shipped a networking change that broke every API request it made, and older builds followed",
        "The image host change exhausted the apps’ connection pool",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The CDN cutover published api_base_url as http://edge.marlow.shop. iOS ATS and Android’s default network security config refuse cleartext, so every API call failed on the phone.",
        why: "Nothing reached the edge, so its dashboards stayed green and checkout-api saw no errors. Every build reads the same URL, so pausing the release or reverting the image host could not help; publishing the https URL did.",
        tell: "Zero server errors, every app build failing at once right after a config publish, and OS-level cleartext refusals naming the new host.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "dr-drill-region",
    title: "Routed to a region that isn’t there",
    severity: "SEV1",
    service: "api-edge",
    opensAt: 14 * HOUR + 6 * MIN,
    briefing:
      "From about 13:58 every app customer sees “Cannot connect to Marlow.” Web customers check out normally and checkout-api shows no errors. Every app build on both platforms is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the iOS and Android apps: releases for builds and telemetry, remote-config for what installed apps do. The apps pick their API region from remote config; SRE runs a disaster-recovery drill this afternoon.",
    phased: { platform: "android", current: "7.3.3", previous: "7.3.1", adoption: 0.22, day: 4 },
    steady: "7.3.0",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: 'Error Domain=NSURLErrorDomain Code=-1003 "A server with the specified hostname could not be found."',
      android: 'java.net.UnknownHostException: Unable to resolve host "sin.edge.marlow.shop": No address associated with hostname',
    },
    cause: {
      entry: config("edge_region_override", "Pins the apps to one API region; auto lets latency routing choose", ["auto", "iad", "fra", "sin"], 11, [
        { at: -60 * DAY, by: "ravi.menon", from: "fra", to: "auto", note: "end of fra maintenance" },
        { at: -8 * MIN, by: "ravi.menon", from: "auto", to: "sin", note: "DR drill step 3: pin clients to sin (DR-26-Q4)" },
      ]),
      bad: "sin",
      fixValue: "auto",
    },
    fixNote: "sin is only provisioned in staging; back to latency routing",
    decoy: config("api_request_compression", "Compress request bodies above 1 KB", ["none", "gzip"], 2, [
      { at: -3 * MIN, by: "dev.raman", from: "none", to: "gzip", note: "cut upload bytes on cart sync (MOB-771)" },
    ]),
    evidence: {
      name: "dns-errors",
      description: "Name resolution failures on API calls by app build (app telemetry)",
      title: "API hostname resolution failures, from app telemetry",
      outcome: "host not found",
      samples: [
        "Sample, ios 7.3.0 (URLSession):",
        'Error Domain=NSURLErrorDomain Code=-1003 "A server with the specified hostname could not be found."',
        "  NSErrorFailingURLStringKey=https://sin.edge.marlow.shop/v2/checkout",
        "",
        "Sample, android 7.3.3 (OkHttp):",
        'java.net.UnknownHostException: Unable to resolve host "sin.edge.marlow.shop": No address associated with hostname',
        "",
        "Resolver check from the office: sin.edge.marlow.shop → NXDOMAIN; iad.edge, fra.edge → OK",
      ],
      clean: "No hostname resolution failures.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Every app user: “Cannot connect to Marlow. Check your connection.” Some say they’re on home Wi-Fi with everything else working." },
      { at: 65, from: "Ravi Menon · SRE", text: "DR drill is running in staging right now, nothing in prod. The prod edges in iad and fra are healthy." },
      { at: 105, from: "Priya Shah · Android lead", text: "7.3.3 is at 20% in Play. Halt it? It’s the newest thing out there." },
      { at: 150, from: "Jonah Reyes · Mobile lead", text: "Dev turned on request gzip three minutes before the page. Some proxies choke on that. Revert it?" },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "The drill is supposed to be in staging. Is it?" },
    ],
    hints: [
      "The servers are healthy and nobody is reaching them. Find out where the apps are trying to go.",
      "Every build, both platforms, the same minute: something every build reads changed, and it wasn’t a build.",
      "Drills have runbooks with steps. Check which environment each step really touched.",
    ],
    why: {
      view: "Every build fails to resolve sin.edge.marlow.shop, a name that only exists in staging DNS.",
      fix: "DR drill step 3 pinned the production apps to sin instead of the staging apps. Back to auto, apps fetch it and return to the iad and fra edges.",
      status: "FAILED drops on every build as apps fetch the change. Halting Android 7.3.3 would have stopped nothing: every build reads the same region.",
      check: "The history shows the drill’s publish at 13:58 and the fix.",
    },
    postmortem: {
      question: "Why could no app customer connect after 13:58?",
      options: [
        "A prod edge region failed and latency routing kept sending phones to it",
        "Turning on request compression broke the API for proxies on home networks and mobile carriers",
        "The drill pinned prod apps to a region only staging has",
        "Android 7.3.3 shipped a broken DNS resolver",
      ],
      answerIndex: 2,
      explanation: {
        cause: "DR drill step 3 published edge_region_override = sin to the production template. sin.edge.marlow.shop exists only in staging DNS, so every app build failed name resolution.",
        why: "Requests never left the phone, so checkout-api and the edges saw nothing wrong. Every build reads the region from remote config, so halting a rollout or reverting gzip could not help; setting auto did.",
        tell: "NXDOMAIN for one regional hostname on every build, starting the minute a drill step ran.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "revoked-publishable-key",
    title: "The payment key nobody updated",
    severity: "SEV1",
    service: "payments-sdk",
    opensAt: 10 * HOUR + 4 * MIN,
    briefing:
      "Since about 09:55 every app checkout fails at the payment step with “Payment could not be processed.” Browsing, cart and sign-in work. Web checkout is fine. Old and new app builds fail alike. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The apps talk to the Tollgate payments SDK with a publishable key they read from remote config; payments rotated keys this morning.",
    phased: { platform: "ios", current: "7.3.5", previous: "7.3.3", adoption: 0.35, day: 5 },
    steady: "7.3.2",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: "TollgateSDK: 401 authentication_failed — publishable key pk_live_51Mrl…K3yQ2t has been revoked",
      android: "TollgateException: 401 authentication_failed — publishable key pk_live_51Mrl…K3yQ2t has been revoked",
    },
    cause: {
      entry: config("payments_publishable_key", "Tollgate publishable key the payment sheet initialises with", null, 3, [
        { at: -380 * DAY, by: "sofia.brandt", from: "pk_live_51Mrl0wA0pX9z", to: "pk_live_51Mrl0wK3yQ2t", note: "annual rotation (PAY-204)" },
      ]),
      requires: "pk_live_51Mrl0wR8vN6c",
      fixValue: "pk_live_51Mrl0wR8vN6c",
    },
    fixNote: "new Tollgate key from PAY-388; the old one was revoked at 09:55",
    decoy: config("payments_sdk_log_level", "Log level of the Tollgate SDK in release builds", ["error", "warn", "debug"], 5, [
      { at: -7 * MIN, by: "sofia.brandt", from: "warn", to: "debug", note: "watch the key rotation (PAY-388)" },
    ]),
    evidence: {
      name: "payment-errors",
      description: "Payment SDK errors at checkout by app build (app telemetry)",
      title: "Tollgate SDK errors when the payment sheet opens, from app telemetry",
      outcome: "401 from Tollgate",
      samples: [
        "Sample, ios 7.3.5 (TollgateSDK 24.6.0, debug logging):",
        "TollgateSDK: initialising PaymentSheet with key pk_live_51Mrl…K3yQ2t",
        "TollgateSDK: 401 authentication_failed — publishable key pk_live_51Mrl…K3yQ2t has been revoked",
        "",
        "Sample, android 7.3.2 (tollgate-android 21.3.1):",
        "TollgateException: 401 authentication_failed — publishable key pk_live_51Mrl…K3yQ2t has been revoked",
      ],
      clean: "No payment SDK errors.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.1%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers get to the payment step and see “Payment could not be processed.” Web customers are paying fine." },
      { at: 75, from: "Sofia Brandt · Payments", text: "We rotated the Tollgate keys this morning (PAY-388): new publishable key is pk_live_51Mrl0wR8vN6c, old one revoked at 09:55. Web picked it up from the server config." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.3.5 is on day 5 of its phased release and it bumped the Tollgate SDK. Pause it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Sofia turned the SDK to debug logging just before this. Debug mode in release builds has bitten us before. Revert it?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Web works and apps don’t. What do the apps have that web doesn’t?" },
    ],
    hints: [
      "Web uses the same payment provider and works. Find what the apps hand the provider that web doesn’t.",
      "Old builds and new builds fail alike, so the SDK version isn’t it.",
      "Payments told you something specific in the channel. Check whether the apps got the same news.",
    ],
    why: {
      view: "Every build initialises the payment sheet with the old publishable key, and Tollgate answers 401: revoked.",
      fix: "The web reads its key from server config, which payments updated; the apps read theirs from remote config, which nobody did. Publishing the new key fixes every installed build.",
      status: "FAILED falls on every build. Pausing 7.3.5 would not have helped: 7.3.3 and Android hold the same revoked key.",
      check: "The key had not changed in over a year until the fix.",
    },
    postmortem: {
      question: "Why did every app payment fail after 09:55?",
      options: [
        "Debug logging in the payment SDK crashed the payment sheet in release builds of both apps",
        "Tollgate had a regional outage that affected only mobile traffic",
        "iOS 7.3.5’s SDK bump broke payments",
        "The apps still held a publishable key that had been revoked",
      ],
      answerIndex: 3,
      explanation: {
        cause: "Payments rotated the Tollgate keys and revoked the old publishable key at 09:55. Web reads its key from server config, which was updated; the apps read theirs from payments_publishable_key in remote config, which still held the old key.",
        why: "The key is data every build reads at runtime, so no rollout, pause or logging change could matter. Publishing the new key let installed apps pay again within two minutes.",
        tell: "Web paying fine, every app build failing with 401 authentication_failed naming a revoked key, right after a planned key rotation.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "country-list-paste",
    title: "Checkout vanished for one country",
    severity: "SEV2",
    service: "checkout-eligibility",
    opensAt: 11 * HOUR + 22 * MIN,
    briefing:
      "Since about 11:10 app customers shipping to the UK can’t check out: the Place order button is gone. Customers in other countries are fine, and so is web everywhere. All app builds on both platforms behave the same. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The apps decide which shipping countries can check out from a remote-config list. The Netherlands launched in the apps this morning.",
    phased: { platform: "ios", current: "7.3.6", previous: "7.3.4", adoption: 0.12, day: 2 },
    steady: "7.3.5",
    affects: ["ios", "android"],
    failShare: 0.3,
    messages: {
      ios: "CheckoutEligibility: shipping country GB not in checkout_supported_countries; Place order hidden",
      android: "CheckoutEligibility: shipping country GB not in checkout_supported_countries; Place order hidden",
    },
    cause: {
      entry: config("checkout_supported_countries", "Shipping countries the apps allow to check out (ISO 3166-1 alpha-2)", null, 17, [
        { at: -120 * DAY, by: "lena.ortiz", from: "US,CA,GB,IE,FR", to: "US,CA,GB,IE,FR,DE", note: "Germany launch" },
        { at: -12 * MIN, by: "tom.becker", from: "US,CA,GB,IE,FR,DE", to: "US,CA,IE,FR,DE,NL", note: "Netherlands launch (GROW-412)" },
      ]),
      requires: "GB",
      fixValue: "US,CA,IE,FR,DE,NL,GB",
    },
    fixNote: "restore GB, dropped by the NL launch edit",
    keeps: { entry: "NL", objective: "The Netherlands launch stays live (NL still in checkout_supported_countries)" },
    decoy: config("vat_display_mode", "How the cart shows VAT", ["inclusive", "exclusive"], 3, [
      { at: -6 * MIN, by: "tom.becker", from: "inclusive", to: "exclusive", note: "NL B2B customers expect ex-VAT prices (GROW-412)" },
    ]),
    evidence: {
      name: "eligibility",
      description: "Checkout eligibility refusals by app build (app telemetry)",
      title: "Carts where the app hid Place order, from app telemetry",
      outcome: "Place order hidden",
      samples: [
        "Refusals by shipping country: GB 100%; every other country 0%",
        "",
        "Sample, ios 7.3.6:",
        "CheckoutEligibility: shipping country GB not in checkout_supported_countries; Place order hidden",
        "  list (v19): US,CA,IE,FR,DE,NL",
        "",
        "Sample, android 7.3.5:",
        "CheckoutEligibility: shipping country GB not in checkout_supported_countries; Place order hidden",
      ],
      clean: "No checkouts refused for eligibility.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "UK customers on the app: the Place order button is just gone. They can add to cart and see prices." },
      { at: 70, from: "Tom Becker · Growth", text: "Netherlands went live in the apps at 11:10, very smooth. NL orders are coming in already. Please don’t roll that back, it’s been announced." },
      { at: 115, from: "Lucas Moreau · iOS lead", text: "7.3.6 started its phased release yesterday. Pause it to be safe?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Tom also flipped VAT display to exclusive. UK prices are VAT-inclusive by law; maybe the app refuses ex-VAT prices for GB. Revert vat_display_mode?" },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "UK is our second market. What’s the plan?" },
    ],
    hints: [
      "Only one country, every build, both platforms. Builds don’t know about countries; something they read does.",
      "Read what changed this morning entry by entry, not just what was added.",
      "Growth needs their launch kept. The fix doesn’t have to undo it.",
    ],
    why: {
      view: "Only GB carts are refused, on every build, and the list the apps hold has no GB in it.",
      fix: "The NL launch edit replaced the list and dropped GB. Adding GB back, and keeping NL, lets UK carts check out within two minutes.",
      status: "FAILED falls on every build. Pausing 7.3.6 would have done nothing: every build reads the same list.",
      check: "The history shows the 11:10 edit that dropped GB while adding NL, and the fix.",
    },
    postmortem: {
      question: "Why could UK customers not check out in the apps after 11:10?",
      options: [
        "The VAT display change made the apps refuse prices that UK law requires to include VAT, on every build",
        "The Netherlands launch edit dropped GB from the country list",
        "iOS 7.3.6 broke address validation for UK postcodes",
        "Royal Mail rates stopped loading for the apps",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Adding NL to checkout_supported_countries at 11:10 rewrote the list as US,CA,IE,FR,DE,NL: GB was lost in the edit, so every app build hid Place order for UK carts.",
        why: "Eligibility is a runtime list every build reads, so pausing a release or reverting VAT display could not help, and reverting the whole list would have pulled NL. Adding GB back fixed it and kept the launch.",
        tell: "One country failing on every build at once, starting the minute the country list was edited.",
      },
    },
    lostCheckoutsPerPoint: 300,
  },
  {
    slug: "tls13-legacy-pay-host",
    title: "A stricter TLS floor than checkout can meet",
    severity: "SEV1",
    service: "pay-edge",
    opensAt: 16 * HOUR + 12 * MIN,
    briefing:
      "From about 16:03 every app checkout fails at Place order with a secure connection error. Browsing and cart work in the apps, web checkout works, and checkout-api sees no app checkout requests at all. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. App checkout calls go to pay.marlow.shop, an older load balancer in front of checkout-api; everything else goes through the CDN edge.",
    phased: { platform: "android", current: "7.4.1", previous: "7.3.4", adoption: 0.4, day: 6 },
    steady: "7.3.8",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: 'Error Domain=NSURLErrorDomain Code=-1200 "An SSL error has occurred and a secure connection to the server cannot be made."',
      android: "javax.net.ssl.SSLHandshakeException: Received fatal alert: protocol_version",
    },
    cause: {
      entry: config("api_tls_min_version", "Lowest TLS version the apps will negotiate with Marlow hosts", ["1.2", "1.3"], 2, [
        { at: -9 * MIN, by: "hana.sato", from: "1.2", to: "1.3", note: "pen-test PT-2026-08: drop TLS 1.2 for app traffic" },
      ]),
      bad: "1.3",
      fixValue: "1.2",
    },
    fixNote: "pay.marlow.shop only speaks TLS 1.2 until its LB is replaced (INFRA-1302)",
    decoy: config("api_http3_enabled", "Let the apps use HTTP/3 to the CDN edge", ["true", "false"], 1, [
      { at: -12 * MIN, by: "ines.duarte", from: "false", to: "true", note: "HTTP/3 on the edge (INFRA-1240)" },
    ]),
    evidence: {
      name: "tls-handshakes",
      description: "TLS handshake failures by app build and host (app telemetry)",
      title: "TLS handshake failures by host, from app telemetry",
      outcome: "handshake failed",
      samples: [
        "Failures by host: pay.marlow.shop 100% of handshakes; edge.marlow.shop 0%",
        "",
        "Sample, ios 7.3.8 (URLSession):",
        'Error Domain=NSURLErrorDomain Code=-1200 "An SSL error has occurred and a secure connection to the server cannot be made."',
        "  _kCFStreamErrorCodeKey=-9836, host pay.marlow.shop",
        "",
        "Sample, android 7.4.1 (OkHttp, ConnectionSpec tlsVersions=[TLS_1_3]):",
        "javax.net.ssl.SSLHandshakeException: Received fatal alert: protocol_version",
        "",
        "Host scan: pay.marlow.shop offers TLS 1.2 only; edge.marlow.shop offers TLS 1.2, 1.3",
      ],
      clean: "No TLS handshake failures.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers can browse and fill the cart, then Place order says “A secure connection could not be made.”" },
      { at: 70, from: "Hana Sato · Security", text: "We closed pen-test finding PT-2026-08 at 16:03: the apps now require TLS 1.3. The edge has supported 1.3 for a year." },
      { at: 110, from: "Priya Shah · Android lead", text: "7.4.1 is our big networking release, staged at 50%. Halt it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "HTTP/3 went on at 16:00. QUIC gets blocked on lots of corporate networks. Turn it off?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Browsing works and paying doesn’t. Get me a cause." },
    ],
    hints: [
      "Browsing works and Place order doesn’t. Find what is different about the one call that fails.",
      "Every build fails alike, so look past the build to what every build was told about connections.",
      "Not every Marlow host is as modern as the CDN edge.",
    ],
    why: {
      view: "Handshakes fail only to pay.marlow.shop, which offers TLS 1.2, and every build now insists on 1.3.",
      fix: "Requiring TLS 1.3 was fine for the edge but not for the legacy pay host. Back to 1.2 until that load balancer is replaced, and every build can check out again.",
      status: "FAILED falls on every build. Halting 7.4.1 would have done nothing: every build reads the same TLS floor.",
      check: "The history shows the 16:03 change and the fix, with the ticket that must land before 1.3 can return.",
    },
    postmortem: {
      question: "Why did every app checkout fail from 16:03?",
      options: [
        "HTTP/3 was blocked on many networks, so the apps lost their connection to the edge",
        "Android 7.4.1’s networking rewrite broke TLS for both platforms through a shared library",
        "The apps began requiring TLS 1.3, which the pay host can’t speak",
        "pay.marlow.shop’s certificate expired at 16:03",
      ],
      answerIndex: 2,
      explanation: {
        cause: "Security raised api_tls_min_version to 1.3 at 16:03. The CDN edge supports 1.3, but checkout calls go to pay.marlow.shop, an older load balancer that only offers TLS 1.2, so every handshake failed.",
        why: "The failure was in the handshake, before checkout-api, and every build reads the TLS floor from remote config. Halting a rollout or turning off HTTP/3 could not change it; lowering the floor for now did.",
        tell: "Handshake protocol_version and -1200 errors to one host only, on every build, from the minute the TLS floor changed.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "integrity-strong-verdict",
    title: "Only flagship phones may pay",
    severity: "SEV2",
    service: "integrity-gate",
    opensAt: 12 * HOUR + 47 * MIN,
    briefing:
      "Since about 12:38 most Android customers are refused at Place order with “This device can’t be verified.” A few Android customers on recent Pixels and Galaxies can still pay; iOS and web are fine. Every Android build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The Android app attaches a Play Integrity verdict to checkout and refuses to send it when the verdict falls short of a remote-config minimum. Fraud requires integrity checks enforced.",
    phased: { platform: "android", current: "7.3.9", previous: "7.3.7", adoption: 0.3, day: 5 },
    steady: "7.3.6",
    affects: ["android"],
    failShare: 0.82,
    messages: {
      android: "IntegrityGate: verdict [MEETS_BASIC_INTEGRITY, MEETS_DEVICE_INTEGRITY] lacks MEETS_STRONG_INTEGRITY; checkout refused",
    },
    cause: {
      entry: config(
        "integrity_required_verdict",
        "Play Integrity device verdict an Android device needs to check out",
        ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"],
        4,
        [
          { at: -200 * DAY, by: "marta.silva", from: "MEETS_BASIC_INTEGRITY", to: "MEETS_DEVICE_INTEGRITY", note: "FRAUD-77 emulator farms" },
          { at: -9 * MIN, by: "marta.silva", from: "MEETS_DEVICE_INTEGRITY", to: "MEETS_STRONG_INTEGRITY", note: "FRAUD-140 rooted-device chargebacks" },
        ],
        "android >= 7.1.0",
      ),
      bad: "MEETS_STRONG_INTEGRITY",
      fixValue: "MEETS_DEVICE_INTEGRITY",
    },
    fixNote: "most devices lack hardware-backed attestation; back to device integrity",
    shortcut: {
      key: "integrity_enforcement",
      entry: config("integrity_enforcement", "enforce: refuse checkout below the verdict. monitor: allow it and report", ["enforce", "monitor"], 2, [
        { at: -190 * DAY, by: "marta.silva", from: "monitor", to: "enforce", note: "FRAUD-77" },
      ], "android >= 7.1.0"),
      safe: "enforce",
      unsafe: "monitor",
      objective: "Play Integrity is still enforced at checkout (integrity_enforcement)",
      bypassed: "allowed, reported",
    },
    decoy: config("integrity_nonce_ttl_seconds", "How long a Play Integrity request nonce stays valid", null, 3, [
      { at: -4 * MIN, by: "marta.silva", from: "300", to: "120", note: "FRAUD-140 shorter replay window" },
    ], "android >= 7.1.0"),
    evidence: {
      name: "integrity",
      description: "Play Integrity verdicts and checkout refusals by Android build (app telemetry)",
      title: "Checkouts refused on the Play Integrity verdict, from app telemetry",
      outcome: "refused on verdict",
      samples: [
        "Verdicts seen on checkout, all Android builds:",
        "  MEETS_STRONG_INTEGRITY present   18%",
        "  MEETS_DEVICE_INTEGRITY present   97%",
        "",
        "Sample, android 7.3.9:",
        "IntegrityGate: verdict [MEETS_BASIC_INTEGRITY, MEETS_DEVICE_INTEGRITY] lacks MEETS_STRONG_INTEGRITY; checkout refused",
      ],
      clean: "No checkouts refused on the integrity verdict.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Android customers: “This device can’t be verified.” One says her Pixel 8 Pro works and her husband’s Moto doesn’t." },
      { at: 75, from: "Marta Silva · Fraud", text: "Rooted-device chargebacks are up 4x this month, so we tightened Play Integrity at 12:38 and shortened the nonce window. Integrity enforcement stays on, please, that’s policy." },
      { at: 115, from: "Priya Shah · Android lead", text: "7.3.9 is in staged rollout. Halt it?" },
      { at: 165, from: "Jonah Reyes · Mobile lead", text: "Quickest: flip integrity_enforcement to monitor and sort it out tomorrow." },
      { at: 245, from: "Elena Ruiz · VP Engineering", text: "Most of Android can’t buy. Fraud wants the check, I want the revenue. Both, please." },
    ],
    hints: [
      "A few Android phones work and most don’t, on every build. Find what the working phones have in common.",
      "The new requirement depends on hardware most phones don’t have.",
      "Fraud asked for the check to stay on. It can stay on and still let ordinary phones through.",
    ],
    why: {
      view: "Only 18% of devices carry MEETS_STRONG_INTEGRITY, which needs hardware-backed attestation; everyone else is refused on every Android build.",
      fix: "Strong integrity was the wrong bar for a consumer app. Back to device integrity, with enforcement still on, and ordinary phones can pay within two minutes.",
      status: "Android FAILED falls on every build. Halting 7.3.9 would have done nothing: every build reads the same minimum.",
      check: "Still enforce. Monitor would have restored checkout by switching the check off.",
    },
    postmortem: {
      question: "Why were most Android customers refused at checkout after 12:38?",
      options: [
        "The shorter nonce window expired integrity tokens before checkout could use them on slower devices",
        "Android 7.3.9 broke the Play Integrity client on older devices",
        "Google Play Integrity had an outage for most device models",
        "The required verdict rose to strong integrity, which most phones lack",
      ],
      answerIndex: 3,
      explanation: {
        cause: "Fraud raised integrity_required_verdict to MEETS_STRONG_INTEGRITY at 12:38. That label needs hardware-backed attestation and recent security patches, which only about a fifth of customers’ phones have, so every Android build refused the rest.",
        why: "The requirement is remote config every Android build reads, so halting a rollout or changing the nonce window could not help. Monitor mode would have dropped the check entirely; going back to device integrity kept it enforced.",
        tell: "Android only, every build, recent flagships unaffected, verdict lists lacking exactly the newly required label.",
      },
    },
    lostCheckoutsPerPoint: 200,
  },
  {
    slug: "signing-key-ahead",
    title: "Signed with a key the gateway hasn’t met",
    severity: "SEV1",
    service: "api-gateway",
    opensAt: 8 * HOUR + 53 * MIN,
    briefing:
      "From about 08:44 every app checkout fails with “Request could not be verified.” The apps can browse with cached data, but anything that writes fails. Web is fine. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The apps sign every write request with an HMAC key chosen by id from remote config, and the API gateway rejects unsigned or unknown-key requests. Security requires request signing on.",
    phased: { platform: "ios", current: "7.4.2", previous: "7.4.0", adoption: 0.27, day: 4 },
    steady: "7.4.0",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: 'RequestSigner: 401 from api-gateway {"error":"unknown_signing_key","kid":"rk-2026-10"}',
      android: 'RequestSigner: 401 from api-gateway {"error":"unknown_signing_key","kid":"rk-2026-10"}',
    },
    cause: {
      entry: config("request_signing_key_id", "Which embedded HMAC key the apps sign write requests with", ["rk-2026-04", "rk-2026-07", "rk-2026-10"], 8, [
        { at: -95 * DAY, by: "hana.sato", from: "rk-2026-04", to: "rk-2026-07", note: "quarterly rotation (SEC-1022)" },
        { at: -9 * MIN, by: "hana.sato", from: "rk-2026-07", to: "rk-2026-10", note: "quarterly rotation (SEC-1188)" },
      ]),
      bad: "rk-2026-10",
      fixValue: "rk-2026-07",
    },
    fixNote: "gateway learns rk-2026-10 tomorrow (SEC-1188 step 2); sign with rk-2026-07 until then",
    shortcut: {
      key: "request_signing_enabled",
      entry: config("request_signing_enabled", "Sign write requests with an HMAC the gateway verifies", ["true", "false"], 1, [
        { at: -300 * DAY, by: "hana.sato", from: "false", to: "true", note: "SEC-640 replayed cart writes" },
      ]),
      safe: "true",
      unsafe: "false",
      objective: "Write requests are still signed (request_signing_enabled)",
      bypassed: "unsigned, accepted",
    },
    decoy: config("session_refresh_window_seconds", "Refresh the access token this long before it expires", null, 6, [
      { at: -6 * MIN, by: "mei.lin", from: "600", to: "300", note: "fewer refreshes (ID-118)" },
    ]),
    evidence: {
      name: "gateway-rejects",
      description: "Write requests the API gateway rejected, by app build (app telemetry)",
      title: "Write requests rejected by api-gateway, from app telemetry",
      outcome: "401 unknown key",
      samples: [
        "Sample, ios 7.4.2:",
        "RequestSigner: signing POST /v2/checkout with kid rk-2026-10",
        'RequestSigner: 401 from api-gateway {"error":"unknown_signing_key","kid":"rk-2026-10"}',
        "",
        "Sample, android 7.4.0:",
        'RequestSigner: 401 from api-gateway {"error":"unknown_signing_key","kid":"rk-2026-10"}',
        "",
        "api-gateway trusted kids (from its /health page): rk-2026-04, rk-2026-07",
      ],
      clean: "No write requests rejected by api-gateway.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 25, from: "Maya Okonkwo · Support", text: "App customers can’t add to cart or pay: “Request could not be verified.” Web is fine." },
      { at: 65, from: "Hana Sato · Security", text: "Quarterly key rotation, SEC-1188: apps switched to rk-2026-10 at 08:44. Step 2, loading the new key into the gateway, is scheduled for tomorrow." },
      { at: 105, from: "Lucas Moreau · iOS lead", text: "7.4.2 is mid phased release. Pause it?" },
      { at: 150, from: "Jonah Reyes · Mobile lead", text: "Turn request_signing_enabled off and the gateway lets everything through. Fastest fix." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Security says signing has to stay on. What else have we got?" },
    ],
    hints: [
      "Reads work and writes fail. Find what writes carry that reads don’t.",
      "Look at the order of the rotation steps, and which one has happened.",
      "Signing can stay on; it just has to use a key both sides know today.",
    ],
    why: {
      view: "Every build signs with rk-2026-10, and the gateway only trusts rk-2026-04 and rk-2026-07.",
      fix: "The rotation switched the apps before the gateway knew the new key. Signing with rk-2026-07 again, which every build embeds and the gateway trusts, restores writes with signing still on.",
      status: "FAILED falls on every build. Pausing 7.4.2 would have changed nothing: every build reads the same key id.",
      check: "Still true. Turning signing off would have restored checkout by dropping the protection.",
    },
    postmortem: {
      question: "Why did every app write request fail after 08:44?",
      options: [
        "The apps switched to a signing key the gateway didn’t trust yet",
        "The shorter token refresh window let access tokens expire mid-request, so writes were rejected as unauthenticated",
        "iOS 7.4.2 shipped a broken HMAC implementation",
        "api-gateway lost its key store in a restart",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Rotation SEC-1188 set request_signing_key_id to rk-2026-10 at 08:44, but loading that key into the gateway is step 2, scheduled for tomorrow. Every signed write named a key the gateway didn’t know.",
        why: "The key id is remote config every build reads, so pausing a release or changing token refresh could not help. Disabling signing would have worked by removing the protection; signing with rk-2026-07 kept it.",
        tell: "Reads fine, writes 401 unknown_signing_key on every build, starting at a rotation whose gateway step hadn’t run.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "threeds-return-host",
    title: "Stuck at the bank’s page",
    severity: "SEV2",
    service: "payments-redirect",
    opensAt: 13 * HOUR + 19 * MIN,
    briefing:
      "Since about 13:05 app customers whose card asks for bank verification approve it and then sit on a blank page; their order never completes. Cards without verification pay fine, and so does web. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. 3-D Secure opens the bank page in an in-app browser, and the app only follows a redirect back to hosts on a remote-config allowlist.",
    phased: { platform: "ios", current: "7.3.7", previous: "7.3.6", adoption: 0.51, day: 6 },
    steady: "7.3.3",
    affects: ["ios", "android"],
    failShare: 0.35,
    messages: {
      ios: "PaymentRedirect: blocked navigation to https://pay.marlow.shop/3ds/return; host not in payment_return_hosts",
      android: "PaymentRedirect: blocked navigation to https://pay.marlow.shop/3ds/return; host not in payment_return_hosts",
    },
    cause: {
      entry: config("payment_return_hosts", "Hosts the in-app payment browser may redirect back to", null, 5, [
        { at: -500 * DAY, by: "sofia.brandt", from: "marlow.shop", to: "marlow.shop,www.marlow.shop", note: "www redirect" },
      ]),
      requires: "pay.marlow.shop",
      fixValue: "marlow.shop,www.marlow.shop,pay.marlow.shop",
    },
    fixNote: "3DS return moved to pay.marlow.shop at 13:05 (PAY-402)",
    decoy: config("threeds_challenge_ui", "How the apps show a 3DS challenge", ["native", "web"], 2, [
      { at: -7 * MIN, by: "sofia.brandt", from: "native", to: "web", note: "native challenge SDK deprecated by the acquirer (PAY-402)" },
    ]),
    evidence: {
      name: "redirects",
      description: "Payment redirects the in-app browser blocked, by app build (app telemetry)",
      title: "3-D Secure redirects blocked by the in-app browser, from app telemetry",
      outcome: "redirect blocked",
      samples: [
        "Checkouts needing 3-D Secure: 35%. Of those, returned to the app: 0%",
        "",
        "Sample, ios 7.3.7 (WKWebView decidePolicyFor):",
        "PaymentRedirect: blocked navigation to https://pay.marlow.shop/3ds/return; host not in payment_return_hosts",
        "  allowlist (v6): marlow.shop,www.marlow.shop",
        "",
        "Sample, android 7.3.3 (Custom Tabs):",
        "PaymentRedirect: blocked navigation to https://pay.marlow.shop/3ds/return; host not in payment_return_hosts",
      ],
      clean: "No payment redirects blocked.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers approve the payment in their banking app, come back and see a blank white page. No order, no charge." },
      { at: 75, from: "Sofia Brandt · Payments", text: "Acquirer migration went live at 13:05: 3DS returns now land on pay.marlow.shop instead of www. Web is fine. We also switched the challenge UI to web." },
      { at: 115, from: "Lucas Moreau · iOS lead", text: "7.3.7 is mid phased release and touched the web view. Pause it?" },
      { at: 165, from: "Jonah Reyes · Mobile lead", text: "Switch threeds_challenge_ui back to native? That’s the change on our side." },
      { at: 245, from: "Elena Ruiz · VP Engineering", text: "A third of app checkouts lost at the last step. ETA?" },
    ],
    hints: [
      "Only customers who go through the bank’s page are stuck. Follow where they are sent afterwards.",
      "Web follows any redirect; the apps are pickier about where they go.",
      "Payments moved something at 13:05. Check whether the apps were told.",
    ],
    why: {
      view: "Every build blocks the bank’s redirect back to pay.marlow.shop: it isn’t on the allowlist.",
      fix: "The acquirer migration moved the 3DS return to a new host; adding it to the allowlist lets every installed build follow the redirect home within two minutes.",
      status: "FAILED falls from about 35% on every build. Pausing 7.3.7 would have done nothing: every build reads the same allowlist.",
      check: "The allowlist had not changed in over a year until the fix.",
    },
    postmortem: {
      question: "Why were 3-D Secure customers stuck after 13:05?",
      options: [
        "The web challenge UI can’t hand control back to the apps after the bank approves the payment",
        "iOS 7.3.7 broke the in-app browser",
        "The return moved to a host missing from the apps’ allowlist",
        "The acquirer declined every 3-D Secure authentication",
      ],
      answerIndex: 2,
      explanation: {
        cause: "The acquirer migration moved the 3-D Secure return URL to pay.marlow.shop at 13:05. The apps only follow redirects to hosts in payment_return_hosts, which listed marlow.shop and www.marlow.shop, so the redirect was blocked on every build.",
        why: "Web browsers follow any redirect, which is why web was fine. The allowlist is remote config every build reads, so pausing a release or switching the challenge UI could not help; adding the host did.",
        tell: "Only 3DS checkouts failing, every app build, web fine, blocked navigations to one new host.",
      },
    },
    lostCheckoutsPerPoint: 300,
  },
  {
    slug: "fail-fast-timeout",
    title: "Fail fast, fail everything",
    severity: "SEV1",
    service: "checkout-api",
    opensAt: 15 * HOUR + 31 * MIN,
    briefing:
      "From about 15:22 nearly every app checkout ends in “The request timed out.” checkout-api serves app checkouts at its normal latency and logs no errors; web is fine. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. Each API call’s client timeout comes from remote config. Checkout takes 1–2 s server-side because it waits on the payment gateway.",
    phased: { platform: "android", current: "7.3.5", previous: "7.3.2", adoption: 0.15, day: 3 },
    steady: "7.3.4",
    affects: ["ios", "android"],
    failShare: 0.88,
    messages: {
      ios: 'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."',
      android: "java.net.SocketTimeoutException: timeout",
    },
    cause: {
      entry: config("checkout_request_timeout_ms", "Client timeout for POST /v2/checkout", null, 3, [
        { at: -250 * DAY, by: "jonah.reyes", from: "30000", to: "15000", note: "MOB-301" },
        { at: -9 * MIN, by: "carla.mendes", from: "15000", to: "800", note: "fail fast: p50 is 420 ms (PERF-88)" },
      ]),
      bad: "800",
      fixValue: "15000",
    },
    fixNote: "checkout p50 is 1.4 s; PERF-88 quoted catalog latency",
    decoy: config("search_request_timeout_ms", "Client timeout for GET /v2/search", null, 2, [
      { at: -3 * MIN, by: "carla.mendes", from: "5000", to: "1500", note: "fail fast (PERF-88)" },
    ]),
    evidence: {
      name: "timeouts",
      description: "Client-side request timeouts by app build and endpoint (app telemetry)",
      title: "Client timeouts on POST /v2/checkout, from app telemetry",
      outcome: "client timed out",
      samples: [
        "Timeouts by endpoint: POST /v2/checkout 88%; GET /v2/catalog 0.2%; GET /v2/search 0.4%",
        "Server time for POST /v2/checkout: p50 1,410 ms · p90 2,050 ms (unchanged)",
        "",
        "Sample, ios 7.3.4 (URLSession, timeoutInterval 0.8 s):",
        'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."',
        "",
        "Sample, android 7.3.5 (OkHttp callTimeout 800 ms):",
        "java.net.SocketTimeoutException: timeout",
      ],
      clean: "No client timeouts on checkout.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%, p99 normal. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers: “The request timed out.” Some say their card was charged anyway." },
      { at: 70, from: "Carla Mendes · Performance", text: "We tightened client timeouts at 15:22 so customers fail fast instead of staring at spinners: p50 is 420 ms per the latency dashboard." },
      { at: 110, from: "Priya Shah · Android lead", text: "7.3.5 is staged at 10%. Halt it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Carla changed the search timeout too, a few minutes before the page. Revert that one first?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Customers say they’re being charged without an order. This needs to stop now." },
    ],
    hints: [
      "The server answers in its usual time. The apps stop listening before it does.",
      "One endpoint times out, others don’t. Compare how long each normally takes with how long the apps now wait.",
      "A dashboard number started this. Check which endpoint it measured.",
    ],
    why: {
      view: "88% of checkout calls time out on every build: the apps wait 800 ms and checkout takes 1.4 s at p50.",
      fix: "The 420 ms p50 was the catalog’s, not checkout’s. Back to 15 s lets the apps wait out the gateway again.",
      status: "FAILED falls on every build. Halting 7.3.5 would have changed nothing: every build reads the same timeout.",
      check: "The history shows the 15:22 change, its PERF-88 note, and the fix.",
    },
    postmortem: {
      question: "Why did app checkouts time out after 15:22?",
      options: [
        "checkout-api slowed down at 15:22",
        "The shorter search timeout made the apps abandon their sessions, which took checkout down with it",
        "Android 7.3.5 changed the networking stack’s timeout handling",
        "The checkout timeout dropped below checkout’s normal latency",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout_request_timeout_ms went from 15000 to 800 at 15:22 on a p50 of 420 ms that was the catalog endpoint’s. Checkout waits on the payment gateway and takes about 1.4 s, so most calls were abandoned mid-flight.",
        why: "The server finished normally, which is why checkout-api showed no errors and some cards were charged. Every build reads the timeout from remote config, so halting a rollout or reverting search could not help; restoring the checkout timeout did.",
        tell: "Client -1001 and SocketTimeoutException on one endpoint only, every build, with server latency unchanged.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "checkout-flow-v3",
    title: "A checkout flow with no server behind it",
    severity: "SEV1",
    service: "api-gateway",
    opensAt: 9 * HOUR + 8 * MIN,
    briefing:
      "Since about 08:59 every app checkout ends in “Checkout is unavailable right now.” checkout-api handles web checkouts normally and has received no app checkouts at all. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. Every build since 7.1 contains both the v2 checkout and the new v3 flow; remote config picks which one they use.",
    phased: { platform: "ios", current: "7.3.9", previous: "7.3.8", adoption: 0.08, day: 1 },
    steady: "7.3.6",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: 'CheckoutV3Client: POST /v3/checkout → 404 {"error":"route_not_found"}',
      android: 'CheckoutV3Client: POST /v3/checkout → 404 {"error":"route_not_found"}',
    },
    cause: {
      entry: config("checkout_flow_version", "Which checkout flow the apps run", ["v2", "v3"], 2, [
        { at: -9 * MIN, by: "nadia.farouk", from: "v2", to: "v3", note: "v3 checkout GA (CHK-500), backend shipped last night" },
      ], "ios >= 7.1.0, android >= 7.1.0"),
      bad: "v3",
      fixValue: "v2",
    },
    fixNote: "backend v3 routes were rolled back overnight (CHK-517)",
    decoy: config("cart_drawer_style", "Cart presentation on product pages", ["sheet", "drawer"], 6, [
      { at: -5 * MIN, by: "nadia.farouk", from: "sheet", to: "drawer", note: "v3 checkout GA (CHK-500)" },
    ]),
    evidence: {
      name: "api-errors",
      description: "HTTP errors on checkout calls by app build (app telemetry)",
      title: "HTTP errors on checkout calls, from app telemetry",
      outcome: "404 at gateway",
      samples: [
        "Errors by route: POST /v3/checkout 404 (100%); POST /v2/checkout — no calls",
        "",
        "Sample, ios 7.3.9:",
        'CheckoutV3Client: POST /v3/checkout → 404 {"error":"route_not_found"}',
        "",
        "Sample, android 7.3.6:",
        'CheckoutV3Client: POST /v3/checkout → 404 {"error":"route_not_found"}',
        "",
        "api-gateway routes for checkout: POST /v2/checkout → checkout-api (v3 route removed 02:14 by deploy-bot, CHK-517)",
      ],
      clean: "No HTTP errors on checkout calls.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers: “Checkout is unavailable right now.” They mention a new cart drawer that slides in from the side." },
      { at: 70, from: "Nadia Farouk · Checkout PM", text: "v3 checkout went GA in the apps at 08:59, as planned in CHK-500. Backend said v3 shipped last night." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.3.9 started its phased release this morning. Coincidence? Pause it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "The new cart drawer went out with GA too. Switch it back to sheet?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Backend says they rolled something back overnight. Does anyone know what?" },
    ],
    hints: [
      "checkout-api hasn’t seen a single app checkout. Find where the apps are sending them instead.",
      "Every build has both flows inside it. Something decides which one runs.",
      "Plans made yesterday may not have survived the night. Check what the server side offers today.",
    ],
    why: {
      view: "Every build calls POST /v3/checkout, and the gateway has no such route: it was removed overnight.",
      fix: "v3 went GA in the apps after its backend was rolled back. Back to v2, which every build still contains, and checkouts reach checkout-api again.",
      status: "FAILED falls on every build. Pausing 7.3.9 would have done nothing: every build reads the same flow switch.",
      check: "The history shows the GA publish at 08:59 and the fix.",
    },
    postmortem: {
      question: "Why did every app checkout fail after 08:59?",
      options: [
        "The new cart drawer dropped the cart before checkout on every build that received the GA config",
        "The apps switched to a v3 flow whose server route had been removed",
        "iOS 7.3.9 shipped a broken checkout",
        "checkout-api rejected app user agents",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Remote config moved checkout_flow_version to v3 at 08:59, but the v3 backend had been rolled back at 02:14 and its gateway route removed. Every build called a route that returned 404.",
        why: "The 404 came from the gateway, so checkout-api saw nothing. Every build since 7.1 contains both flows and obeys remote config, so pausing a release or reverting the cart drawer could not help; switching back to v2 did.",
        tell: "404 route_not_found on /v3/checkout from every build, and no v2 calls at all, from the minute of the GA publish.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "staging-challenge-key",
    title: "A bot check nobody can pass",
    severity: "SEV1",
    service: "bot-challenge",
    opensAt: 17 * HOUR + 26 * MIN,
    briefing:
      "From about 17:17 every app checkout gets stuck on the “Verifying you’re human” step, which spins and then fails. Web customers pass the same check and pay. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. App checkout runs a Turnpike bot challenge with a site key from remote config. Security requires the challenge on during the card-testing wave.",
    phased: { platform: "android", current: "7.4.0", previous: "7.3.8", adoption: 0.45, day: 6 },
    steady: "7.4.1",
    affects: ["ios", "android"],
    failShare: 1,
    messages: {
      ios: "TurnpikeChallenge: site key tp_test_2b77c0 is not valid for domain marlow.shop (sitekey_domain_mismatch)",
      android: "TurnpikeChallenge: site key tp_test_2b77c0 is not valid for domain marlow.shop (sitekey_domain_mismatch)",
    },
    cause: {
      entry: config("bot_challenge_site_key", "Turnpike site key the checkout challenge loads", null, 4, [
        { at: -30 * DAY, by: "aleks.kowalski", from: "tp_live_4f19a2", to: "tp_live_8e1c55", note: "key rotation (SEC-1120)" },
        { at: -9 * MIN, by: "aleks.kowalski", from: "tp_live_8e1c55", to: "tp_test_2b77c0", note: "harder difficulty profile (SEC-1201)" },
      ]),
      bad: "tp_test_2b77c0",
      fixValue: "tp_live_8e1c55",
    },
    fixNote: "tp_test key is staging-only; back to the live key",
    shortcut: {
      key: "bot_challenge_enabled",
      entry: config("bot_challenge_enabled", "Run the Turnpike challenge before checkout", ["true", "false"], 3, [
        { at: -2 * DAY, by: "aleks.kowalski", from: "false", to: "true", note: "card-testing wave (SEC-1199)" },
      ]),
      safe: "true",
      unsafe: "false",
      objective: "The bot challenge still runs at app checkout (bot_challenge_enabled)",
      bypassed: "challenge skipped",
    },
    decoy: config("bot_challenge_difficulty", "Turnpike difficulty profile", ["easy", "normal", "hard"], 2, [
      { at: -6 * MIN, by: "aleks.kowalski", from: "normal", to: "hard", note: "card-testing wave (SEC-1201)" },
    ]),
    evidence: {
      name: "challenge-errors",
      description: "Bot challenge failures at checkout by app build (app telemetry)",
      title: "Turnpike challenge failures at checkout, from app telemetry",
      outcome: "challenge failed",
      samples: [
        "Challenges solved: 0.0% (yesterday 97.8%)",
        "",
        "Sample, ios 7.4.1:",
        "TurnpikeChallenge: site key tp_test_2b77c0 is not valid for domain marlow.shop (sitekey_domain_mismatch)",
        "",
        "Sample, android 7.4.0:",
        "TurnpikeChallenge: site key tp_test_2b77c0 is not valid for domain marlow.shop (sitekey_domain_mismatch)",
        "",
        "Web checkout challenge key (from the web config): tp_live_8e1c55",
      ],
      clean: "No challenge failures.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 40% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers stuck on “Verifying you’re human”: it spins, then says verification failed. Every time." },
      { at: 70, from: "Aleks Kowalski · Security", text: "Card testers are back. At 17:17 we moved the apps to a harder challenge profile. The challenge stays on, please; we’re blocking thousands of card tests an hour." },
      { at: 110, from: "Priya Shah · Android lead", text: "7.4.0 is staged at 50% in Play. Halt it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Hard difficulty is probably too hard for humans. Drop it back to normal? Or just turn the challenge off for now." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Security needs the challenge and we need checkout. Find a way to have both." },
    ],
    hints: [
      "Nobody passes, not even easy cases. That isn’t a difficulty problem.",
      "Web passes the same provider’s challenge. Compare what web and the apps load.",
      "Keys come in live and test flavours.",
    ],
    why: {
      view: "Every build loads a tp_test key that Turnpike refuses for marlow.shop; web loads the live key and works.",
      fix: "The harder profile was published with the staging site key. Back to the live key keeps the challenge on and lets humans pass.",
      status: "FAILED falls on every build. Halting 7.4.0 would have done nothing: every build reads the same key.",
      check: "Still true. Turning the challenge off would have restored checkout and let the card testers in.",
    },
    postmortem: {
      question: "Why did every app customer fail the bot challenge after 17:17?",
      options: [
        "The hard difficulty profile was too difficult for real people to solve on small phone screens",
        "Turnpike was down for mobile SDK traffic",
        "The apps were sent a staging-only challenge key",
        "Android 7.4.0 broke the challenge web view",
      ],
      answerIndex: 2,
      explanation: {
        cause: "The 17:17 publish put tp_test_2b77c0, a staging key, into bot_challenge_site_key. Turnpike rejects a test key on the production domain, so the challenge failed for every customer on every build.",
        why: "No one passes a challenge loaded with an invalid key, whatever its difficulty. The key is remote config every build reads, so halting a release or lowering difficulty could not help; turning the challenge off would have let card testers through. The live key fixed it.",
        tell: "0% solve rate, sitekey_domain_mismatch on every build, a tp_test key where web uses tp_live.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
  {
    slug: "apple-pay-sandbox-merchant",
    title: "Apple Pay points at the sandbox",
    severity: "SEV2",
    service: "apple-pay",
    opensAt: 19 * HOUR + 14 * MIN,
    briefing:
      "Since about 19:05 iPhone customers who tap Apple Pay see nothing happen; those who type a card in pay fine. Android and web are unaffected. Every iOS build behaves the same. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The iOS app reads its Apple Pay merchant identifier from remote config; the identifiers it may use are fixed in its entitlements. Product wants Apple Pay offered at all times.",
    phased: { platform: "ios", current: "7.4.3", previous: "7.4.1", adoption: 0.33, day: 4 },
    steady: "7.3.9",
    affects: ["ios"],
    failShare: 0.55,
    messages: {
      ios: "[ApplePay] merchant identifier merchant.shop.marlow.sandbox is not in this app's entitlements; payment sheet not presented",
    },
    cause: {
      entry: config("apple_pay_merchant_id", "Apple Pay merchant identifier for the payment request", null, 2, [
        { at: -9 * MIN, by: "nikhil.rao", from: "merchant.shop.marlow", to: "merchant.shop.marlow.sandbox", note: "copy payments config from staging template (PAY-415)" },
      ], "ios >= 7.0.0"),
      bad: "merchant.shop.marlow.sandbox",
      fixValue: "merchant.shop.marlow",
    },
    fixNote: "sandbox merchant id leaked in from the staging template",
    shortcut: {
      key: "checkout_express_pay_enabled",
      safe: "true",
      unsafe: "false",
      objective: "Apple Pay is still offered at checkout (checkout_express_pay_enabled)",
      bypassed: "button hidden",
    },
    decoy: config("apple_pay_supported_networks", "Card networks offered in the Apple Pay sheet", null, 5, [
      { at: -6 * MIN, by: "nikhil.rao", from: "visa,mastercard,amex", to: "visa,mastercard,amex,discover", note: "copy payments config from staging template (PAY-415)" },
    ], "ios >= 7.0.0"),
    evidence: {
      name: "apple-pay",
      description: "Apple Pay sheet failures by iOS build (app telemetry)",
      title: "Apple Pay taps that showed no payment sheet, from app telemetry",
      outcome: "sheet not shown",
      samples: [
        "Apple Pay taps: 55% of iOS checkouts. Sheets presented: 0.0% (yesterday 99.1%)",
        "",
        "Sample, ios 7.4.3 (forwarded by the app's logger):",
        "[ApplePay] merchant identifier merchant.shop.marlow.sandbox is not in this app's entitlements; payment sheet not presented",
        "  entitlements com.apple.developer.in-app-payments: merchant.shop.marlow",
      ],
      clean: "Apple Pay sheets presenting normally.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "iPhone customers: tapping Apple Pay does nothing. Typing a card works. Android is fine." },
      { at: 70, from: "Nikhil Rao · Payments", text: "At 19:05 I synced the payments keys from the staging template to prod to add Discover. Only additions, I think." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.4.3 is on day 4 of its phased release. Pause it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Hide the express pay buttons for now; people will type their card. Or revert the Discover change?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Product says Apple Pay is half our iOS conversions. Keep it on if you can." },
    ],
    hints: [
      "Card payments work on the same phones. Find what only Apple Pay depends on.",
      "Every iOS build, old and new, fails alike, so look at what they were all told.",
      "A sync from staging touches more than the line it was meant for.",
    ],
    why: {
      view: "Every iOS build asks for merchant.shop.marlow.sandbox, which isn’t in the app’s entitlements, so iOS won’t present the sheet.",
      fix: "The staging sync brought the sandbox merchant id with it. Back to the production id, which every build is entitled to, and the sheet presents again.",
      status: "iOS FAILED falls on every build. Pausing 7.4.3 would have done nothing: every build reads the same merchant id.",
      check: "Still true. Hiding express pay would have restored checkout by taking Apple Pay away.",
    },
    postmortem: {
      question: "Why did Apple Pay stop working on every iOS build at 19:05?",
      options: [
        "Adding Discover made the payment request invalid for cards on other networks in the customer’s wallet",
        "iOS 7.4.3 removed the Apple Pay entitlement",
        "Apple Pay had a regional outage",
        "The merchant id was swapped for one the app isn’t entitled to",
      ],
      answerIndex: 3,
      explanation: {
        cause: "Syncing payments config from the staging template at 19:05 set apple_pay_merchant_id to merchant.shop.marlow.sandbox. The app’s entitlements list only merchant.shop.marlow, so iOS refused to present the payment sheet on every build.",
        why: "Card entry doesn’t use the merchant id, which is why it kept working. The id is remote config every build reads, so pausing a release or removing Discover could not help; hiding express pay would have given up Apple Pay. Restoring the production id fixed it.",
        tell: "iOS only, Apple Pay only, every build, sheet never presented, merchant id ending in .sandbox.",
      },
    },
    lostCheckoutsPerPoint: 300,
  },
  {
    slug: "strings-bundle-gap",
    title: "The button with no words",
    severity: "SEV2",
    service: "localization",
    opensAt: 7 * HOUR + 37 * MIN,
    briefing:
      "Since about 07:28 app customers using German, French or Spanish see a checkout screen with no Place order button. English-language customers are fine, and so is web. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. The apps download their UI strings as a bundle named in remote config; a screen hides any control whose label is missing rather than show a raw key.",
    phased: { platform: "android", current: "7.3.7", previous: "7.3.5", adoption: 0.2, day: 3 },
    steady: "7.3.8",
    affects: ["ios", "android"],
    failShare: 0.6,
    messages: {
      ios: 'LocalizedStrings: missing key "checkout.cta.place_order" in bundle 2026.10.10-1 (de); control hidden',
      android: 'LocalizedStrings: missing key "checkout.cta.place_order" in bundle 2026.10.10-1 (fr); control hidden',
    },
    cause: {
      entry: config("strings_bundle_version", "UI string bundle the apps download", null, 42, [
        { at: -2 * DAY, by: "loc-bot", from: "2026.10.06-2", to: "2026.10.08-3", note: "weekly translations" },
        { at: -9 * MIN, by: "loc-bot", from: "2026.10.08-3", to: "2026.10.10-1", note: "weekly translations (checkout copy refresh)" },
      ]),
      bad: "2026.10.10-1",
      fixValue: "2026.10.08-3",
    },
    fixNote: "10.10-1 renamed checkout.cta keys without translations; back to 10.08-3",
    decoy: config("font_pack_version", "Font pack the apps download", null, 7, [
      { at: -4 * MIN, by: "design-bot", from: "3.1.0", to: "3.2.0", note: "new display face for the Autumn Sale" },
    ]),
    evidence: {
      name: "missing-strings",
      description: "UI strings missing from the downloaded bundle, by app build (app telemetry)",
      title: "Checkouts where a control was hidden for a missing string, from app telemetry",
      outcome: "Place order hidden",
      samples: [
        "By app language: de 100%, fr 100%, es 100%, en 0% (en falls back to strings built into the app)",
        "",
        "Sample, ios 7.3.8:",
        'LocalizedStrings: missing key "checkout.cta.place_order" in bundle 2026.10.10-1 (de); control hidden',
        "",
        "Sample, android 7.3.7:",
        'LocalizedStrings: missing key "checkout.cta.place_order" in bundle 2026.10.10-1 (fr); control hidden',
        "",
        "Bundle 2026.10.10-1 has checkout.cta.place_order_v2 (en only) and no checkout.cta.place_order",
      ],
      clean: "No controls hidden for missing strings.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Customers in Germany and France send screenshots: checkout screen, prices, address — and no button at the bottom." },
      { at: 70, from: "Clara Weiss · Localization", text: "The weekly bundle went out at 07:28 with the checkout copy refresh. Translations for the new strings arrive Monday." },
      { at: 110, from: "Priya Shah · Android lead", text: "7.3.7 is staged at 20%. Halt it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Design shipped a new font pack at 07:33. A font missing glyphs could render the button invisible. Revert it?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "All of continental Europe can’t buy in the app. What’s the plan?" },
    ],
    hints: [
      "Language decides who fails, not device or build. Find what the apps load per language.",
      "English survives because it has a fallback the others lack.",
      "Last week’s copy worked in every language.",
    ],
    why: {
      view: "In de, fr and es the bundle lacks checkout.cta.place_order, so every build hides the button; English falls back to built-in strings.",
      fix: "The copy refresh renamed the key before translations existed. Back to last week’s bundle restores the button in every language within two minutes.",
      status: "FAILED falls on every build. Halting 7.3.7 would have changed nothing: every build reads the same bundle.",
      check: "The history shows the 07:28 bundle publish and the fix.",
    },
    postmortem: {
      question: "Why did non-English app customers lose the Place order button at 07:28?",
      options: [
        "The new font pack lacked glyphs for accented characters, so the button’s label rendered invisible",
        "Android 7.3.7 broke right-to-left and accented layouts",
        "The new string bundle dropped the button’s key in those languages",
        "Prices failed to load for EU currencies",
      ],
      answerIndex: 2,
      explanation: {
        cause: "Bundle 2026.10.10-1 renamed checkout.cta.place_order to place_order_v2 with only an English translation. Apps hide controls whose label is missing, so in German, French and Spanish every build hid Place order.",
        why: "English builds carry built-in strings as a fallback, which is why they were fine. The bundle is remote config every build reads, so halting a rollout or reverting the font pack could not help; going back to last week’s bundle did.",
        tell: "Failure by app language, not build, starting with a bundle publish, and a missing-key log naming the checkout button.",
      },
    },
    lostCheckoutsPerPoint: 400,
  },
  {
    slug: "refresh-lead-storm",
    title: "Signed out at the till",
    severity: "SEV1",
    service: "auth-service",
    opensAt: 18 * HOUR + 2 * MIN,
    briefing:
      "Since about 17:53 most app customers are thrown back to the sign-in screen when they tap Place order. Browsing works; web customers stay signed in and pay. Every app build is affected. You’re the mobile on-call.",
    roleBriefing:
      "You own the apps: releases for builds and telemetry, remote-config for what installed apps do. Access tokens live 15 minutes; the apps refresh them ahead of expiry by a lead time from remote config, and auth-service limits how often one session may refresh.",
    phased: { platform: "ios", current: "7.4.4", previous: "7.4.2", adoption: 0.06, day: 1 },
    steady: "7.4.0",
    affects: ["ios", "android"],
    failShare: 0.7,
    messages: {
      ios: 'AuthInterceptor: token refresh rejected 429 {"error":"refresh_rate_limited","retry_after":60}; signing out',
      android: 'AuthInterceptor: token refresh rejected 429 {"error":"refresh_rate_limited","retry_after":60}; signing out',
    },
    cause: {
      entry: config("token_refresh_lead_seconds", "Refresh the access token this many seconds before it expires", null, 4, [
        { at: -160 * DAY, by: "mei.lin", from: "30", to: "60", note: "ID-71 clock skew on old Android" },
        { at: -9 * MIN, by: "mei.lin", from: "60", to: "3600", note: "refresh early so long checkouts never expire (ID-130)" },
      ]),
      bad: "3600",
      fixValue: "60",
    },
    fixNote: "a lead longer than the 15 min token life refreshes on every request",
    decoy: config("login_passkeys_enabled", "Offer passkey sign-in in the apps", ["true", "false"], 2, [
      { at: -5 * MIN, by: "mei.lin", from: "false", to: "true", note: "passkeys GA in apps (ID-90)" },
    ]),
    evidence: {
      name: "auth-errors",
      description: "Token refresh failures and forced sign-outs by app build (app telemetry)",
      title: "Forced sign-outs at checkout, from app telemetry",
      outcome: "signed out (429)",
      samples: [
        "Token refreshes per session per minute: 14.2 (yesterday 0.07)",
        "",
        "Sample, ios 7.4.0:",
        "AuthInterceptor: token expires in 894 s < refresh lead 3600 s; refreshing before POST /v2/checkout",
        'AuthInterceptor: token refresh rejected 429 {"error":"refresh_rate_limited","retry_after":60}; signing out',
        "",
        "Sample, android 7.4.4:",
        'AuthInterceptor: token refresh rejected 429 {"error":"refresh_rate_limited","retry_after":60}; signing out',
      ],
      clean: "No forced sign-outs.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout loss > 30% for 3m. checkout-api 5xx 0.0%. Mobile on-call paged." },
      { at: 30, from: "Maya Okonkwo · Support", text: "App customers get logged out exactly when they press Place order. Signing back in and trying again logs them out again." },
      { at: 70, from: "Mei Lin · Identity", text: "auth-service is healthy, but refresh calls from the apps are up 200x since 17:53 and the per-session limiter is doing its job. We changed refresh timing and launched passkeys this afternoon." },
      { at: 110, from: "Lucas Moreau · iOS lead", text: "7.4.4 went into phased release this afternoon. Pause it?" },
      { at: 160, from: "Jonah Reyes · Mobile lead", text: "Passkeys GA'd five minutes before the page. New sign-in, new sessions, new bugs. Turn it off?" },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Raising the auth limiter would be quick, but Identity says no. What’s ours to fix?" },
    ],
    hints: [
      "auth-service is healthy and the limiter is doing its job. Ask why the apps are asking so often.",
      "Compare how long a token lives with how early the apps now try to replace it.",
      "Every build behaves the same, so the answer isn’t in a build.",
    ],
    why: {
      view: "Every build refreshes before every request because the lead time is longer than a token’s whole life, so the limiter answers 429 and the app signs the customer out.",
      fix: "A one-hour lead on a 15-minute token means always refreshing. Back to 60 s and refreshes return to one every quarter hour.",
      status: "FAILED falls on every build. Pausing 7.4.4 would have done nothing: every build reads the same lead time.",
      check: "The history shows the 17:53 change and the fix.",
    },
    postmortem: {
      question: "Why were app customers signed out at checkout after 17:53?",
      options: [
        "Passkey sign-in created sessions that auth-service could not refresh once the first token expired",
        "The refresh lead outlasted the token, so apps refreshed constantly and got rate limited",
        "auth-service’s limiter was misconfigured",
        "iOS 7.4.4 lost the refresh token on resume",
      ],
      answerIndex: 1,
      explanation: {
        cause: "token_refresh_lead_seconds went from 60 to 3600 at 17:53. Tokens live 900 s, so every request found its token “about to expire” and refreshed first; auth-service’s per-session limiter answered 429 and the apps signed customers out.",
        why: "The limiter was working as designed and every build reads the lead time from remote config, so pausing a release or turning off passkeys could not help. Restoring a lead shorter than the token’s life did.",
        tell: "Refreshes per session up by orders of magnitude on every build, 429 refresh_rate_limited before checkout, starting at the timing change.",
      },
    },
    lostCheckoutsPerPoint: 500,
  },
];

export const MOBILE_TIER4_INCIDENTS: readonly Scenario[] = ROWS.map(toScenario);
