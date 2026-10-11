import type { CommsMessage, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { findFlag, isFlagOn, type ClientDefect, type FeatureFlag } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const HOUR = 3600;
const MINUTE = 60;
const DAY = 24 * HOUR;

type Failure = {
  /** "server": checkout-api answers 500. "client": the checkout dies in the browser, before any request. */
  readonly where: "server" | "client";
  /** Share of web Pay taps on this path; every one of them fails while the path is live. */
  readonly share: number;
  readonly message: string;
};

/** The flag whose change caused the incident: flipping it back is the fix. */
type Culprit = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  readonly minutesAgo: number;
  readonly note: string;
  /** True when the incident began as the flag went on; false when someone turned it off. */
  readonly breaksWhenOn: boolean;
  readonly failure: Failure;
};

/** The flag everyone reaches for: flipping it opens a path that fails far more checkouts. */
type Trap = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  readonly daysAgo: number;
  readonly note: string;
  /** Where the flag stands at the page; the trap is flipping it. */
  readonly isOn: boolean;
  readonly failure: Failure;
};

/** The RUM breakdown that shows which path fails, and that the trap's path has served nobody lately. */
type PathView = {
  readonly name: string;
  readonly description: string;
  readonly heading: string;
  readonly healthyPath: string;
  readonly culpritPath: string;
  readonly trapPath: string;
  /** What the trap's FAILED cell says while nobody is on that path. */
  readonly trapIdle: string;
};

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly webVersion: string;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly culprit: Culprit;
  readonly trap: Trap;
  readonly view: PathView;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
};

function culpritDefect(culprit: Culprit): ClientDefect {
  return { trigger: { flag: culprit.key, failsWhenOn: culprit.breaksWhenOn }, failShare: culprit.failure.share, where: culprit.failure.where, message: culprit.failure.message };
}

function trapDefect(trap: Trap): ClientDefect {
  return { trigger: { flag: trap.key, failsWhenOn: !trap.isOn }, failShare: trap.failure.share, where: trap.failure.where, message: trap.failure.message };
}

function isFlagAt(state: ClusterState, key: string, on: boolean): boolean {
  const flag = state.commerce && findFlag(state.commerce, key);
  return !!flag && isFlagOn(flag) === on;
}

function pathView(row: Row): (state: ClusterState) => readonly string[] {
  const culprit = culpritDefect(row.culprit);
  const trap = trapDefect(row.trap);
  return (state) => {
    const { commerce } = state;
    if (!commerce) return ["rum: no web sessions in window"];
    const onTrap = trap.failShare * triggerShare(trap.trigger, commerce, state.t);
    const onCulprit = (1 - onTrap) * culprit.failShare * triggerShare(culprit.trigger, commerce, state.t);
    const healthy = 1 - onTrap - onCulprit;
    return [
      row.view.heading,
      ...table([
        ["PATH", "PAY TAPS", "FAILED"],
        [row.view.healthyPath, percent(healthy), healthy > 0 ? "0.0%" : "—"],
        [row.view.culpritPath, percent(onCulprit), onCulprit > 0 ? "100.0%" : "—"],
        [row.view.trapPath, percent(onTrap), onTrap > 0 ? "100.0%" : row.view.trapIdle],
      ]),
    ];
  };
}

function incident(row: Row): Scenario {
  const id = `fe-t3-${row.slug}`;
  const { culprit, trap } = row;
  const hasClientFailure = culprit.failure.where === "client" || trap.failure.where === "client";
  const flags: FeatureFlag[] = [
    {
      key: culprit.key,
      description: culprit.description,
      owner: culprit.owner,
      history: [{ at: -culprit.minutesAgo * MINUTE, by: culprit.by, from: !culprit.breaksWhenOn, to: culprit.breaksWhenOn, note: culprit.note }],
    },
    {
      key: trap.key,
      description: trap.description,
      owner: trap.owner,
      history: [{ at: -trap.daysAgo * DAY, by: trap.by, from: !trap.isOn, to: trap.isOn, note: trap.note }],
    },
    ...SHOP_FLAGS,
  ];
  return {
    id,
    tier: 3,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["frontend"],
    roleBriefings: { frontend: row.roleBriefing },
    suggestions: {
      frontend: ["rum errors", `rum ${row.view.name}`, "rum overview", "flags list", `flags get ${trap.key}`, `flags set ${trap.key} ${trap.isOn ? "off" : "on"}`],
    },
    evidence: [{ tool: "rum", name: row.view.name, description: row.view.description, run: pathView(row) }],
    opensAtSecondOfDay: row.opensAt[0] * HOUR + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
        revision: 6,
        commerce: checkoutCommerce({
          platforms: {
            web: { current: { version: row.webVersion, userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY, defects: [trapDefect(trap), culpritDefect(culprit)] } },
          },
          flags,
        }),
      }),
    isRootCauseFixed: (state) => isFlagAt(state, culprit.key, !culprit.breaksWhenOn) && isFlagAt(state, trap.key, trap.isOn),
    ...(hasClientFailure
      ? { alertMetric: { label: "checkout loss", rate: (state: ClusterState) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) } }
      : {}),
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [
      {
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
    solution: { frontend: row.solution },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "address-line-two",
    title: "The address form nobody fell back to",
    severity: "SEV2",
    opensAt: [11, 12],
    webVersion: "2026.10.10-2",
    briefing:
      "Since about 10:55, close to a third of web checkouts fail with “Something went wrong” after Pay. The apps are fine and checkout-api hasn’t deployed. The checkout runbook says address trouble on web means switching back to the old address form. Check what that form still talks to before you do.",
    roleBriefing: "You own checkout-web: flags and RUM. The address lookup changed this morning; the runbook has a switch back to the v1 address form.",
    culprit: {
      key: "checkout.address_lookup_v3",
      description: "Postcode-first address lookup that fills every address line",
      owner: "team-checkout-web",
      by: "tomas.lind",
      minutesAgo: 18,
      note: "address lookup v3 to 100% (FE-2402)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.3, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"shipping-rates: address_line_2 is 41 characters; carrier limit is 35"}' },
    },
    trap: {
      key: "checkout.address_form_v2",
      description: "Address form v2. Off sends every session back to the v1 address form",
      owner: "team-checkout-web",
      by: "priya.shah",
      daysAgo: 52,
      note: "v2 GA; v1 kept as the fallback (FE-1874)",
      isOn: true,
      failure: { where: "server", share: 1, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"orders: unknown field \\"zip\\" in shipping_address (removed in API v5; send postal_code)"}' },
    },
    view: {
      name: "address-paths",
      description: "Pay taps and failures by address entry path",
      heading: "Pay taps by address entry path · checkout-web · last 5 min",
      healthyPath: "form v2 · typed address",
      culpritPath: "form v2 · lookup v3 fill",
      trapPath: "form v1 · runbook fallback",
      trapIdle: "— (no sessions since 2026-08-19)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers in flats and business parks can’t pay. People with short street addresses seem fine." },
      { at: 50, from: "Priya Shah · Frontend lead", text: "The runbook says address problems on web mean checkout.address_form_v2 off. It’s the switch back to v1." },
      { at: 95, from: "Tomas Lind · Web engineer", text: "Lookup v3 went to 100% at 10:54. It fills building and flat names into line 2 now, which we thought was a win." },
      { at: 160, from: "Grace Oduya · Orders platform", text: "Reminder that orders API v5 dropped the old zip field in September. Anything still posting zip gets a 500." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "A third of web checkouts on a weekday morning. What’s the plan?" },
    ],
    hints: [
      "Not every address fails. Compare the ones that fail with the ones that pay.",
      "A fallback is only safe if it still speaks today’s API. Check when anyone last used it.",
      "Undo the smallest change that explains the error text.",
    ],
    solution: [
      { command: "rum errors", why: "shipping-rates rejects line 2 addresses longer than the carrier’s 35 characters." },
      { command: "rum address-paths", why: "Only lookup-filled addresses fail. The v1 fallback hasn’t served anyone since August." },
      { command: "flags history checkout.address_lookup_v3", why: "Lookup v3 went to 100% at 10:54, just before the 500s began." },
      { command: 'flags set checkout.address_lookup_v3 off --note "v3 fills line 2 past carrier limit"', why: "Tabs go back to lookup v2 within ~20 s; the v2 form keeps working." },
      { command: "rum address-paths", why: "The lookup v3 path empties out, and the 500s with it." },
    ],
    postmortem: {
      question: "Why would the runbook’s address switch have made this worse?",
      options: [
        "The v1 form posts a zip field the orders API no longer accepts",
        "Switching forms clears every saved address from customers’ accounts",
        "The v1 form only renders for logged-in customers and blocks guests at the address step",
        "Address flags take an hour to reach open tabs",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Address lookup v3, turned on at 10:54, filled building names into address line 2 past the carrier’s 35-character limit, and shipping-rates failed those checkouts.",
        why: "Turning checkout.address_lookup_v3 off fixed it. The runbook’s switch, checkout.address_form_v2, falls back to the v1 form, which still posts zip; orders API v5 removed that field in September. Nobody had used the fallback since August, so pulling it would have failed every web checkout.",
        tell: "RUM put every failure on the lookup-v3 path, and the v1 fallback had no sessions since 19 Aug.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "paylater-sync-scripts",
    title: "Pay-later messaging froze the page",
    severity: "SEV2",
    opensAt: [13, 40],
    webVersion: "2026.10.10-4",
    briefing:
      "Since about 13:20, a third of web customers tap Pay and nothing happens. checkout-api 5xx is flat; the drop shows as checkout loss. Growth turned on pay-later messaging after lunch. Someone suggests loading third-party scripts in order so they’re ready before use. Think about what that costs every page.",
    roleBriefing: "You own checkout-web: flags and RUM. Third-party scripts are deferred behind a flag; pay-later messaging is new today.",
    culprit: {
      key: "checkout.paylater_messaging",
      description: "“Pay in 3” installment messaging under the order total",
      owner: "team-growth-web",
      by: "kai.moreno",
      minutesAgo: 21,
      note: "pay-later messaging for all web (GRW-102)",
      breaksWhenOn: true,
      failure: { where: "client", share: 0.35, message: "Uncaught ReferenceError: PayLaterSDK is not defined" },
    },
    trap: {
      key: "web.defer_third_party_scripts",
      description: "Load third-party tags with defer, after the page is interactive",
      owner: "team-web-platform",
      by: "noor.aziz",
      daysAgo: 120,
      note: "INP fix: tags off the critical path (WEB-660)",
      isOn: true,
      failure: { where: "client", share: 0.7, message: "[rum] long task 11840 ms on main thread before first input; Pay button not interactive (render-blocking third-party scripts)" },
    },
    view: {
      name: "script-timing",
      description: "Pay taps by how third-party scripts loaded",
      heading: "Pay taps by third-party script loading · checkout-web · last 5 min",
      healthyPath: "deferred tags · no pay-later block",
      culpritPath: "deferred tags · pay-later block before SDK",
      trapPath: "render-blocking tags",
      trapIdle: "— (deferred since June)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 15% for 5m. checkout-api 5xx 0.1%. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers say the Pay button does nothing. No error, just nothing." },
      { at: 55, from: "Kai Moreno · Web engineer", text: "Pay-later messaging went live at 13:19. Its block calls the SDK as soon as the total renders." },
      { at: 90, from: "Lena Ortiz · Growth", text: "Can’t we just stop deferring third-party scripts so the SDK is there in time? That keeps the messaging up." },
      { at: 150, from: "Noor Aziz · Web platform", text: "We defer tags because loading them up front blocked the main thread for seconds on mid-range phones. That was the June INP incident." },
      { at: 240, from: "Sam Tan · Eng manager", text: "A third of web checkouts is real money. Where are we?" },
    ],
    hints: [
      "There’s no 5xx, so look at what the browser reports.",
      "A script that runs before its dependency arrives has two fixes, and one of them slows every page.",
      "Remove the new caller rather than change how everything loads.",
    ],
    solution: [
      { command: "rum errors", why: "The pay-later block calls PayLaterSDK before the deferred script has loaded, and the exception kills the Pay handler." },
      { command: "rum script-timing", why: "Every failure is a page with the pay-later block. Render-blocking tags haven’t served anyone since June." },
      { command: "flags history checkout.paylater_messaging", why: "Messaging went on at 13:19, when checkout loss began." },
      { command: 'flags set checkout.paylater_messaging off --note "calls PayLaterSDK before it loads"', why: "Tabs drop the block within ~20 s; scripts stay deferred." },
      { command: "rum script-timing", why: "The pay-later path empties and checkout loss drains." },
    ],
    postmortem: {
      question: "Why was loading third-party scripts up front the wrong fix?",
      options: [
        "It blocks the main thread for seconds, so Pay stops responding for most customers",
        "The pay-later provider bills per page view when its script loads synchronously",
        "Browsers refuse synchronous scripts from other domains on HTTPS pages",
        "It would have broken the Apple Pay button, which only loads when tags are deferred and the page has finished hydrating",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Pay-later messaging, on at 13:19, called PayLaterSDK before the deferred SDK script had loaded; the ReferenceError broke the Pay handler on those pages.",
        why: "Turning checkout.paylater_messaging off fixed it. Turning web.defer_third_party_scripts off would have put every tag back on the critical path, the same main-thread blocking that caused June’s INP incident, freezing Pay for most customers instead of a third.",
        tell: "RUM’s top error was a ReferenceError for PayLaterSDK, only on pages with the new block, starting at 13:19.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "currency-edge-cache",
    title: "Prices in two currencies",
    severity: "SEV2",
    opensAt: [8, 47],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 08:30, one web checkout in five fails with “Something went wrong” after Pay. Support thinks a stale cached page is showing the wrong prices and wants the edge HTML cache off. checkout-api hasn’t deployed. Find out what actually changed before you send every page to origin.",
    roleBriefing: "You own checkout-web: flags and RUM. Local-currency display shipped this morning; the edge HTML cache sits in front of every page.",
    culprit: {
      key: "checkout.multi_currency_display",
      description: "Show prices in the visitor’s local currency on the payment step",
      owner: "team-intl-web",
      by: "ines.duarte",
      minutesAgo: 16,
      note: "local currency display for EU visitors (INTL-48)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.2, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"pricing: display currency \\"EUR\\" does not match cart currency \\"GBP\\""}' },
    },
    trap: {
      key: "web.edge_html_cache",
      description: "Serve checkout page HTML from the edge cache for 60 s",
      owner: "team-web-platform",
      by: "noor.aziz",
      daysAgo: 210,
      note: "edge HTML cache; origin SSR sized for cache misses only (WEB-402)",
      isOn: true,
      failure: { where: "client", share: 0.55, message: "Failed to load resource: the server responded with a status of 504 ()" },
    },
    view: {
      name: "currency-paths",
      description: "Pay taps by currency shown and where the page came from",
      heading: "Pay taps by currency shown · checkout-web · last 5 min",
      healthyPath: "edge-cached page · GBP",
      culpritPath: "edge-cached page · local currency",
      trapPath: "origin-rendered page (cache off)",
      trapIdle: "— (cache on since March)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers in France and Spain see euro prices, then the order fails. UK customers are fine. Must be a stale cached page; can we turn off the edge cache?" },
      { at: 60, from: "Ines Duarte · Intl web", text: "Local-currency display went on at 08:31. It only changes what’s shown, not what we charge." },
      { at: 110, from: "Noor Aziz · Web platform", text: "Origin SSR for checkout is sized for cache misses. If every page view hits it, it falls over in about a minute." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Are we charging people the wrong amount? I need an answer." },
    ],
    hints: [
      "The failing customers have something in common. Find it in the error text.",
      "A cache serving stale pages would fail everyone the same way. These failures don’t.",
      "Turning off a cache moves load, it doesn’t remove it. Know where it goes first.",
    ],
    solution: [
      { command: "rum errors", why: "pricing rejects checkouts whose display currency doesn’t match the cart’s GBP currency." },
      { command: "rum currency-paths", why: "Only pages showing a local currency fail; the cached GBP pages pay fine." },
      { command: "flags history checkout.multi_currency_display", why: "Local-currency display went on at 08:31, just before the 500s." },
      { command: 'flags set checkout.multi_currency_display off --note "sends display currency, cart is GBP"', why: "Tabs go back to GBP prices within ~20 s; the cache keeps origin safe." },
      { command: "rum errors", why: "The pricing 500s fade out." },
    ],
    postmortem: {
      question: "What would turning off the edge HTML cache have done?",
      options: [
        "Fixed the currency mismatch by serving every customer a fresh page",
        "Sent every page view to an origin sized only for misses, timing out most checkouts",
        "Nothing, because the payment step is never served from the cache",
        "Logged every customer out, since sessions are stored in edge cookies that only the cache layer knows how to refresh",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Local-currency display, on at 08:31, sent the display currency with the order; pricing rejected any checkout where it wasn’t the cart’s GBP.",
        why: "Turning checkout.multi_currency_display off fixed it. The pages weren’t stale: the error came from what the new code sent. Turning web.edge_html_cache off would have sent every page view to origin SSR, which is sized only for cache misses, and checkout pages would have started timing out with 504s.",
        tell: "Every 500 named EUR against a GBP cart, and only pages with local-currency display failed.",
      },
    },
    lostCheckoutsPerPoint: 120,
  },
  {
    slug: "silent-refresh-reauth",
    title: "Sign in again, forever",
    severity: "SEV2",
    opensAt: [21, 5],
    webVersion: "2026.10.10-5",
    briefing:
      "Since about 20:40, a quarter of signed-in web customers get “Something went wrong” at Pay. The identity team suggests a flag that sends anyone with a checkout error back to sign in. Before you turn it on, find out why the sessions are failing and where that flag would send people.",
    roleBriefing: "You own checkout-web: flags and RUM. Silent token refresh shipped tonight; a dormant flag forces re-authentication on checkout errors.",
    culprit: {
      key: "auth.silent_token_refresh",
      description: "Refresh the session token in a background tab before it expires",
      owner: "team-identity-web",
      by: "hana.sato",
      minutesAgo: 24,
      note: "silent refresh to 100% (IDW-77)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.25, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"sessions: refresh token rt_6b0f… already rotated; reuse detected, session revoked"}' },
    },
    trap: {
      key: "auth.reauth_on_checkout_error",
      description: "Send customers to /login when checkout fails with a session error",
      owner: "team-identity-web",
      by: "hana.sato",
      daysAgo: 64,
      note: "built for SSO migration, never enabled (IDW-31)",
      isOn: false,
      failure: { where: "client", share: 0.8, message: "GET https://www.marlow.example/checkout net::ERR_TOO_MANY_REDIRECTS" },
    },
    view: {
      name: "session-paths",
      description: "Pay taps by how the session token was obtained",
      heading: "Pay taps by session token source · checkout-web · last 5 min",
      healthyPath: "token from sign-in, single tab",
      culpritPath: "silent refresh, several tabs",
      trapPath: "forced re-auth redirect",
      trapIdle: "— (flag never on in production)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Signed-in customers with the shop open in more than one tab can’t pay. Guests are fine." },
      { at: 60, from: "Hana Sato · Identity web", text: "Silent refresh went to 100% at 20:41. We could also turn on auth.reauth_on_checkout_error so people just sign in again?" },
      { at: 130, from: "Diego Alvarez · Identity platform", text: "Careful: /login bounces signed-in sessions straight back to where they came from. That flag was never finished." },
      { at: 240, from: "Sam Tan · Eng manager", text: "Evening peak is starting. Update please." },
    ],
    hints: [
      "Guests pay fine. What do the failing signed-in sessions have in common?",
      "The error describes a token being used twice.",
      "A redirect to sign in only helps if signing in doesn’t send you straight back.",
    ],
    solution: [
      { command: "rum errors", why: "sessions revoked tokens on refresh-token reuse: two tabs refreshed the same token." },
      { command: "rum session-paths", why: "Failures are all silent refreshes with several tabs open; the forced re-auth path has never run in production." },
      { command: "flags history auth.silent_token_refresh", why: "Silent refresh went to 100% at 20:41." },
      { command: 'flags set auth.silent_token_refresh off --note "multi-tab refresh trips reuse detection"', why: "Tabs stop refreshing in the background within ~20 s; tokens stay valid." },
      { command: "rum session-paths", why: "The silent-refresh path empties and the 500s stop." },
    ],
    postmortem: {
      question: "What would the forced re-authentication flag have done?",
      options: [
        "Logged everyone out once and fixed the tokens on their next sign-in",
        "Bounced customers between /checkout and /login until the browser gave up",
        "Asked every customer for a one-time code by SMS, which costs money per message and takes minutes to arrive",
        "Nothing, because the flag only applies to the mobile apps",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Silent token refresh, on at 20:41, let several open tabs refresh the same refresh token; the sessions service treated the second use as token theft and revoked the session.",
        why: "Turning auth.silent_token_refresh off fixed it. auth.reauth_on_checkout_error was never finished: /login redirects signed-in sessions back to /checkout, which redirects to /login again, so it would have turned a quarter of failures into a redirect loop for most customers.",
        tell: "Every 500 said refresh-token reuse was detected, only for sessions with several tabs, starting at 20:41.",
      },
    },
    lostCheckoutsPerPoint: 130,
  },
  {
    slug: "expiry-mask-validation",
    title: "Expiry dates in the wrong order",
    severity: "SEV2",
    opensAt: [15, 22],
    webVersion: "2026.10.10-3",
    briefing:
      "Since about 15:10, three web checkouts in ten fail with “Something went wrong”. A colleague wants to turn off client-side validation so the form stops getting in the way. checkout-api hasn’t deployed. Find what the failing requests carry first.",
    roleBriefing: "You own checkout-web: flags and RUM. The card expiry input changed this afternoon; client-side form validation sits behind a flag.",
    culprit: {
      key: "checkout.expiry_input_mask",
      description: "Auto-formatting MM / YY mask on the card expiry field",
      owner: "team-checkout-web",
      by: "lucas.meyer",
      minutesAgo: 13,
      note: "expiry mask to 100% (FE-2417)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.3, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments: exp_year 10 is in the past (exp_month 28)"}' },
    },
    trap: {
      key: "checkout.client_validation",
      description: "Validate required checkout fields in the browser before POST /checkout",
      owner: "team-checkout-web",
      by: "priya.shah",
      daysAgo: 300,
      note: "validation before submit (FE-1102)",
      isOn: true,
      failure: { where: "server", share: 0.6, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"orders: email \\"\\" is not a valid address"}' },
    },
    view: {
      name: "expiry-entry",
      description: "Pay taps by how the card expiry was entered",
      heading: "Pay taps by card expiry entry · checkout-web · last 5 min",
      healthyPath: "expiry autofilled by browser",
      culpritPath: "expiry typed through mask",
      trapPath: "unvalidated submit",
      trapIdle: "— (validation on since Dec 2025)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers typing their card by hand fail. Saved cards and browser autofill work." },
      { at: 55, from: "Lucas Meyer · Web engineer", text: "The expiry mask went to 100% at 15:09. It formats as you type." },
      { at: 85, from: "Owen Price · Web engineer", text: "Validation is fussy anyway. Turn off checkout.client_validation and let checkout-api decide?" },
      { at: 150, from: "Grace Oduya · Orders platform", text: "checkout-api assumes the browser already checked required fields. Empty ones 500, they don’t 400." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Is this the card form again? How long?" },
    ],
    hints: [
      "Typed cards fail and autofilled ones don’t. Look at what the typed ones send.",
      "The error has the month and the year the wrong way round.",
      "Removing a safety net catches more mistakes, not fewer.",
    ],
    solution: [
      { command: "rum errors", why: "payments sees exp_month 28 and exp_year 10: the mask swapped month and year." },
      { command: "rum expiry-entry", why: "Only expiries typed through the mask fail. Unvalidated submits have never reached checkout-api." },
      { command: "flags history checkout.expiry_input_mask", why: "The mask went to 100% at 15:09." },
      { command: 'flags set checkout.expiry_input_mask off --note "mask swaps month and year"', why: "Tabs go back to the plain expiry field within ~20 s." },
      { command: "rum expiry-entry", why: "The masked path empties and the payments 500s stop." },
    ],
    postmortem: {
      question: "Why would turning off client-side validation have made things worse?",
      options: [
        "checkout-api would reject every order for missing a CSRF token",
        "Validation also formats the expiry, so the swap would spread to autofilled cards on every browser and device type",
        "checkout-api relies on it, so incomplete forms would reach it and fail too",
        "Browsers would stop autofilling cards without validation attributes",
      ],
      answerIndex: 2,
      explanation: {
        cause: "The expiry mask, on at 15:09, sent the year as the month and the month as the year, and payments rejected the card as expired.",
        why: "Turning checkout.expiry_input_mask off fixed it. checkout-api trusts the browser to check required fields, so turning checkout.client_validation off would have let empty emails and addresses through to a 500 as well, on top of the swapped expiries.",
        tell: "Every 500 showed exp_month 28 and exp_year 10, only on typed expiries, from 15:09.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "prefetch-session-lock",
    title: "Two checkout sessions for one cart",
    severity: "SEV2",
    opensAt: [12, 3],
    webVersion: "2026.10.10-2",
    briefing:
      "Since about 11:45, one web checkout in five fails with a cart-lock error. The lock looks like the problem, and a teammate wants the single-session lock off. checkout-api hasn’t deployed. Find out who is opening the second session before you remove the lock.",
    roleBriefing: "You own checkout-web: flags and RUM. Payment-step prefetching shipped this morning; the cart lock is a flag.",
    culprit: {
      key: "checkout.prefetch_payment_step",
      description: "Prefetch the payment step when the cursor nears Continue",
      owner: "team-checkout-web",
      by: "mei.lin",
      minutesAgo: 19,
      note: "prefetch payment step, 100% (FE-2409)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.2, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"carts: cart ct_41a9 is locked by checkout session cs_8e02 (opened by prefetch)"}' },
    },
    trap: {
      key: "checkout.single_session_lock",
      description: "Allow one active checkout session per cart",
      owner: "team-checkout-web",
      by: "ravi.menon",
      daysAgo: 180,
      note: "stop double captures from two tabs (PAY-310)",
      isOn: true,
      failure: { where: "server", share: 0.7, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments: payment_intent pi_3Qz7 already captured by another checkout session"}' },
    },
    view: {
      name: "session-locks",
      description: "Pay taps by how many checkout sessions the cart had",
      heading: "Pay taps by checkout sessions per cart · checkout-web · last 5 min",
      healthyPath: "one session",
      culpritPath: "prefetch opened a second session",
      trapPath: "unlocked · sessions race",
      trapIdle: "— (lock on since April)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers see “your cart is being checked out elsewhere”. They only have one tab open." },
      { at: 60, from: "Owen Price · Web engineer", text: "The error is the session lock. Turn off checkout.single_session_lock and the problem goes away." },
      { at: 110, from: "Mei Lin · Web engineer", text: "Payment-step prefetch went live at 11:44. It warms the step when you hover Continue." },
      { at: 170, from: "Ravi Menon · Payments platform", text: "That lock exists because two sessions on one cart race to capture the same payment intent. It was double charges before April." },
      { at: 250, from: "Sam Tan · Eng manager", text: "Lunch peak. Where are we?" },
    ],
    hints: [
      "Customers with one tab shouldn’t have two checkout sessions. Find out what opens the second.",
      "A lock that fires is often doing its job. Ask who is on the other side of it.",
      "Stop the extra session rather than remove the guard.",
    ],
    solution: [
      { command: "rum errors", why: "The cart is locked by a checkout session the prefetch opened." },
      { command: "rum session-locks", why: "Every failure has a prefetch-opened second session; the unlocked path hasn’t run since April." },
      { command: "flags history checkout.prefetch_payment_step", why: "Prefetch went to 100% at 11:44." },
      { command: 'flags set checkout.prefetch_payment_step off --note "prefetch opens a second checkout session"', why: "Tabs stop prefetching within ~20 s; one session per cart again." },
      { command: "rum session-locks", why: "The second-session path empties and the lock errors stop." },
    ],
    postmortem: {
      question: "What would turning the cart lock off have done?",
      options: [
        "Let both sessions race to capture one payment, failing most checkouts",
        "Nothing, since the prefetch session never reaches the payment step at all",
        "Doubled every order’s shipping cost",
        "Cleared every customer’s cart, because carts are only persisted while a checkout session holds the lock",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Payment-step prefetch, on at 11:44, opened a checkout session while the customer hovered Continue; the real session then hit the cart lock.",
        why: "Turning checkout.prefetch_payment_step off fixed it. The lock was doing its job. Without checkout.single_session_lock, the prefetch session and the real one race to capture the same payment intent, the double-capture failure that the lock was built to stop.",
        tell: "Every lock error named a session opened by prefetch, on carts whose customers had one tab open.",
      },
    },
    lostCheckoutsPerPoint: 120,
  },
  {
    slug: "locale-legacy-routes",
    title: "Locale paths lost the cart",
    severity: "SEV2",
    opensAt: [7, 58],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 07:35, three web checkouts in ten fail with “Something went wrong”. Locale paths like /en-gb/checkout went live this morning, and someone suggests switching back to the legacy routes. Check what those routes still run before you do.",
    roleBriefing: "You own checkout-web: flags and RUM. Locale subpaths shipped at 07:36; a flag still serves the legacy unprefixed routes.",
    culprit: {
      key: "web.locale_subpaths",
      description: "Serve pages under /<locale>/ paths",
      owner: "team-intl-web",
      by: "ines.duarte",
      minutesAgo: 22,
      note: "locale subpaths for SEO (INTL-51)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.3, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"carts: no cart for session (cookie marlow_cart scoped to path /en-gb, request path /api/checkout)"}' },
    },
    trap: {
      key: "web.legacy_routes",
      description: "Serve the pre-2026 pages-router checkout at unprefixed paths",
      owner: "team-web-platform",
      by: "noor.aziz",
      daysAgo: 95,
      note: "app router GA; legacy routes kept dark (WEB-711)",
      isOn: false,
      failure: { where: "client", share: 0.9, message: "Uncaught (in promise) SyntaxError: Unexpected token 'N', \"Not Found\" is not valid JSON" },
    },
    view: {
      name: "route-paths",
      description: "Pay taps by route and router",
      heading: "Pay taps by checkout route · checkout-web · last 5 min",
      healthyPath: "/checkout · cookie from homepage",
      culpritPath: "/en-gb/checkout · cookie scoped to locale",
      trapPath: "legacy pages router",
      trapIdle: "— (dark since July)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers arriving from Google lose their cart at Pay. People who came in from the homepage are fine." },
      { at: 60, from: "Ines Duarte · Intl web", text: "Locale subpaths went on at 07:36. SEO wanted them before the autumn campaign." },
      { at: 95, from: "Owen Price · Web engineer", text: "Just turn on web.legacy_routes, those never had locales." },
      { at: 160, from: "Noor Aziz · Web platform", text: "The legacy pages router calls /api/v1/cart. We deleted that API with the app router migration." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Morning traffic is ramping. ETA?" },
    ],
    hints: [
      "Where customers entered the site matters here. Compare the paths.",
      "The error describes a cookie that the request didn’t carry.",
      "An old route is only a fallback if its APIs still exist.",
    ],
    solution: [
      { command: "rum errors", why: "The cart cookie is scoped to /en-gb, so POST /api/checkout arrives without it." },
      { command: "rum route-paths", why: "Only locale-path sessions fail. The legacy router has been dark since July." },
      { command: "flags history web.locale_subpaths", why: "Locale subpaths went on at 07:36." },
      { command: 'flags set web.locale_subpaths off --note "cart cookie scoped to locale path"', why: "Pages go back to unprefixed paths within ~20 s; cookies cover /api again." },
      { command: "rum route-paths", why: "The locale path empties and the cart errors stop." },
    ],
    postmortem: {
      question: "Why would the legacy routes have made this worse?",
      options: [
        "They don’t render prices for customers outside the UK, so most visitors would see a blank order total",
        "They call a cart API that was deleted, so checkout breaks for almost everyone",
        "They would have dropped every page from Google’s index",
        "They need a separate login, so every customer would be signed out",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Locale subpaths, on at 07:36, set the cart cookie with Path=/en-gb, so the browser didn’t send it on POST /api/checkout.",
        why: "Turning web.locale_subpaths off fixed it. web.legacy_routes serves the old pages-router checkout, which fetches /api/v1/cart, an API deleted in the app-router migration; its 404 page isn’t JSON, so checkout would break in the browser for nearly everyone.",
        tell: "Every 500 said the cart cookie was scoped to a locale path, only for sessions on /en-gb/ URLs.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "gift-note-bytes",
    title: "Emoji in the gift note",
    severity: "SEV3",
    opensAt: [16, 35],
    webVersion: "2026.10.10-3",
    briefing:
      "Since about 16:20, gift orders with a message fail with “Something went wrong” after Pay. Merchandising wants the gift options hidden until it’s sorted. checkout-api hasn’t deployed. Find what breaks first, then think about what hiding gift options leaves behind.",
    roleBriefing: "You own checkout-web: flags and RUM. The gift message box was upgraded this afternoon; the whole gift step sits behind another flag.",
    culprit: {
      key: "checkout.gift_message_rich",
      description: "Gift message box with emoji picker and 200-character counter",
      owner: "team-gifting-web",
      by: "zara.khan",
      minutesAgo: 17,
      note: "rich gift messages for autumn gifting (GIFT-22)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.15, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"gift-notes: message is 233 bytes; limit is 200 bytes (UTF-8)"}' },
    },
    trap: {
      key: "checkout.gift_options",
      description: "Show the gift step (wrap, message, recipient) at checkout",
      owner: "team-gifting-web",
      by: "zara.khan",
      daysAgo: 400,
      note: "gift step GA (GIFT-1)",
      isOn: true,
      failure: { where: "server", share: 0.45, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"orders: gift=true requires gift_recipient; none sent"}' },
    },
    view: {
      name: "gift-paths",
      description: "Pay taps by gift step outcome",
      heading: "Pay taps by gift step · checkout-web · last 5 min",
      healthyPath: "not a gift, or gift without emoji",
      culpritPath: "gift message with emoji",
      trapPath: "gift from cart, step hidden",
      trapIdle: "— (step shown since 2025)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Gift orders with a message fail. Same order without a message goes through." },
      { at: 60, from: "Rosa Blanco · Merchandising", text: "Can we just hide gift options for now? Turn off checkout.gift_options and people can still buy." },
      { at: 110, from: "Zara Khan · Gifting web", text: "The new message box went on at 16:18. The counter counts characters, emoji included." },
      { at: 170, from: "Grace Oduya · Orders platform", text: "Heads-up: the cart page’s “This is a gift” tick sets gift=true on the order. The recipient comes from the gift step." },
      { at: 260, from: "Sam Tan · Eng manager", text: "Gifting season starts next week. Let’s not lose these orders." },
    ],
    hints: [
      "Only gifts with a message fail. Read what checkout-api says about the message.",
      "Characters and bytes aren’t the same thing once a message has emoji.",
      "Before hiding a step, find out what else expects it to have run.",
    ],
    solution: [
      { command: "rum errors", why: "gift-notes rejects messages over 200 bytes; the new counter allows 200 characters, and emoji take four bytes each." },
      { command: "rum gift-paths", why: "Only messages with emoji fail. Gifts from the cart page have always gone through the gift step." },
      { command: "flags history checkout.gift_message_rich", why: "The rich message box went on at 16:18." },
      { command: 'flags set checkout.gift_message_rich off --note "counts characters, limit is bytes"', why: "Tabs go back to the plain message box within ~20 s." },
      { command: "rum errors", why: "The gift-notes 500s fade out." },
    ],
    postmortem: {
      question: "Why would hiding the gift step have failed more orders?",
      options: [
        "Gift wrap is paid for separately, so totals wouldn’t match",
        "The cart’s gift tick still sets gift=true, and without the step no recipient is sent",
        "Hiding the step resets every customer’s delivery address to their billing address",
        "Orders without a gift message are held for manual fraud review before the card is charged",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The rich gift message box, on at 16:18, counted characters against a 200-byte limit; messages with emoji went over and gift-notes failed the checkout.",
        why: "Turning checkout.gift_message_rich off fixed it. Turning checkout.gift_options off would hide the step that collects the recipient, while the cart page’s gift tick still sets gift=true, so every gift order would fail instead of just those with emoji.",
        tell: "Every 500 gave a byte count over 200 for a message the counter had allowed.",
      },
    },
    lostCheckoutsPerPoint: 100,
  },
  {
    slug: "consent-manager-v2",
    title: "Consent banner took Pay with it",
    severity: "SEV2",
    opensAt: [10, 2],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 09:45, a quarter of web customers can’t get past Pay, with no 5xx at all. A new consent manager went live this morning, and legal’s on-call suggests turning consent management off entirely while it’s fixed. Find what the new version breaks, and what the page does without any consent manager.",
    roleBriefing: "You own checkout-web: flags and RUM. Consent manager v2 shipped at 09:47; a master flag controls whether any consent manager loads.",
    culprit: {
      key: "web.consent_manager_v2",
      description: "Consent manager v2 with per-purpose toggles",
      owner: "team-privacy-web",
      by: "felix.braun",
      minutesAgo: 15,
      note: "CMP v2 for the new EU guidance (PRIV-40)",
      breaksWhenOn: true,
      failure: { where: "client", share: 0.25, message: "Uncaught TypeError: Cannot read properties of undefined (reading 'analytics')" },
    },
    trap: {
      key: "web.consent_manager",
      description: "Load a consent manager on every page",
      owner: "team-privacy-web",
      by: "felix.braun",
      daysAgo: 500,
      note: "CMP required for EU visitors (PRIV-1)",
      isOn: true,
      failure: { where: "client", share: 0.85, message: "[tags] consent state never resolved (no consent manager on page); payment SDK held, Pay disabled" },
    },
    view: {
      name: "consent-paths",
      description: "Pay taps by consent manager state",
      heading: "Pay taps by consent state · checkout-web · last 5 min",
      healthyPath: "v2 · consent given before checkout",
      culpritPath: "v2 · consent pending at Pay",
      trapPath: "no consent manager",
      trapIdle: "— (always loaded since 2025)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers who haven’t clicked the cookie banner can’t pay. Once they accept or reject, it works." },
      { at: 55, from: "Felix Braun · Privacy web", text: "CMP v2 went live at 09:47. The consent object shape changed slightly." },
      { at: 90, from: "Julia Novak · Legal on-call", text: "If it’s the consent manager, turn web.consent_manager off for an hour. We can live with that." },
      { at: 150, from: "Noor Aziz · Web platform", text: "Our tag loader waits for a consent signal before it releases the payment SDK. No consent manager means no signal, ever." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "No errors on the dashboard but sales are down. What’s going on?" },
    ],
    hints: [
      "No 5xx means the failure happens in the browser. Look at what it reports.",
      "Customers who already answered the banner pay fine. What’s different for the others?",
      "Before removing a component, find out what waits on it.",
    ],
    solution: [
      { command: "rum errors", why: "Checkout reads consent.purposes.analytics, which v2 leaves undefined until the customer answers." },
      { command: "rum consent-paths", why: "Only sessions with consent pending at Pay fail. The page has never run without a consent manager." },
      { command: "flags history web.consent_manager_v2", why: "CMP v2 went on at 09:47." },
      { command: 'flags set web.consent_manager_v2 off --note "pending consent leaves purposes undefined"', why: "Tabs go back to CMP v1 within ~20 s; it always sets a default state." },
      { command: "rum consent-paths", why: "The pending-consent failures drain." },
    ],
    postmortem: {
      question: "What would turning off the consent manager entirely have done?",
      options: [
        "Nothing for checkout, just a legal exposure",
        "Shown the old v1 banner to every visitor",
        "Held the payment SDK forever, so Pay never enabled for most customers",
        "Blocked every analytics tag, so the incident’s RUM data would vanish and the team would be blind",
      ],
      answerIndex: 2,
      explanation: {
        cause: "Consent manager v2, on at 09:47, left the consent purposes undefined until the customer answered the banner; checkout read purposes.analytics and threw.",
        why: "Turning web.consent_manager_v2 off fixed it. Turning web.consent_manager off would remove the only source of a consent signal, and the tag loader holds the payment SDK until one arrives, so Pay would never enable for most customers.",
        tell: "The TypeError only appeared for sessions that hadn’t answered the banner, from 09:47.",
      },
    },
    lostCheckoutsPerPoint: 130,
  },
  {
    slug: "stock-badge-reservation",
    title: "Live stock badges ate the reservations",
    severity: "SEV2",
    opensAt: [19, 30],
    webVersion: "2026.10.10-4",
    briefing:
      "Since about 19:20, three web checkouts in ten fail during the flash sale. checkout-api’s errors mention inventory rate limits, and the sale team wants to skip stock reservation tonight and accept some overselling. Find what’s using up inventory’s capacity first.",
    roleBriefing: "You own checkout-web: flags and RUM. Live stock badges went on for the sale; a dormant flag skips stock reservation at Pay.",
    culprit: {
      key: "pdp.live_stock_badges",
      description: "“Only 3 left” badges that poll inventory every 2 s",
      owner: "team-growth-web",
      by: "lena.ortiz",
      minutesAgo: 12,
      note: "live stock for the flash sale (GRW-119)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.3, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"inventory: 429 Too Many Requests reserving sku MW-2291 (client quota exhausted by stock-badge polling)"}' },
    },
    trap: {
      key: "checkout.skip_stock_reservation",
      description: "Place orders without reserving stock first",
      owner: "team-checkout-web",
      by: "ravi.menon",
      daysAgo: 70,
      note: "emergency lever, needs orders-api support (PAY-388)",
      isOn: false,
      failure: { where: "server", share: 0.9, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"orders: line li_77c2 has no stock reservation"}' },
    },
    view: {
      name: "reservation-paths",
      description: "Pay taps by stock reservation outcome",
      heading: "Pay taps by stock reservation · checkout-web · last 5 min",
      healthyPath: "reserved before Pay",
      culpritPath: "reservation rate-limited",
      trapPath: "reservation skipped",
      trapIdle: "— (lever never pulled)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 20, from: "Lena Ortiz · Growth", text: "Live stock badges went on at 19:18 for the sale. They look great." },
      { at: 50, from: "Tariq Hassan · Sales ops", text: "Inventory is the bottleneck. Turn on checkout.skip_stock_reservation and we’ll sort oversells tomorrow." },
      { at: 110, from: "Ana Petrov · Inventory", text: "Our quota for checkout-web is shared between reads and reservations. Something is reading a lot." },
      { at: 170, from: "Grace Oduya · Orders platform", text: "orders-api still requires a reservation id on every line. That skip lever was never finished on our side." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "This is the biggest sale of the month. Status?" },
    ],
    hints: [
      "The error names whose quota is used up. Find out what’s using it.",
      "Something new tonight talks to inventory far more often than checkout does.",
      "An emergency lever is only safe if the other side supports it.",
    ],
    solution: [
      { command: "rum errors", why: "inventory answers 429: checkout-web’s quota is exhausted by stock-badge polling." },
      { command: "rum reservation-paths", why: "Failures are rate-limited reservations. The skip lever has never been pulled." },
      { command: "flags history pdp.live_stock_badges", why: "Live badges went on at 19:18, just before the 429s." },
      { command: 'flags set pdp.live_stock_badges off --note "polling exhausts inventory quota"', why: "Tabs stop polling within ~20 s; reservations get the quota back." },
      { command: "rum reservation-paths", why: "Rate-limited reservations drain." },
    ],
    postmortem: {
      question: "What would skipping stock reservation have done?",
      options: [
        "Oversold a few items, but taken every order",
        "Failed nearly every order, since orders-api requires a reservation",
        "Doubled the load on inventory, because unreserved orders are re-checked line by line after payment",
        "Charged customers twice for each line",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Live stock badges, on at 19:18, polled inventory every 2 s from every product page and used up checkout-web’s inventory quota; reservations at Pay got 429s.",
        why: "Turning pdp.live_stock_badges off fixed it. checkout.skip_stock_reservation was never finished: orders-api still requires a reservation id on every line, so skipping reservation would have failed nearly every web order.",
        tell: "Every 500 was an inventory 429 blaming stock-badge polling, starting at 19:18.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "threeds-redirect-fallback",
    title: "The 3-D Secure frame that wouldn’t load",
    severity: "SEV2",
    opensAt: [14, 11],
    webVersion: "2026.10.10-3",
    briefing:
      "Since about 13:50, customers whose bank asks for 3-D Secure can’t finish paying on web: the challenge never appears. There’s a flag to use the full-page redirect instead of the popup. Find out why the popup fails, and where the redirect lands, before you switch.",
    roleBriefing: "You own checkout-web: flags and RUM. The 3-D Secure challenge modal changed at 13:51; a dormant flag swaps it for a full-page redirect.",
    culprit: {
      key: "checkout.threeds_modal_v2",
      description: "3-D Secure challenge in a redesigned modal",
      owner: "team-payments-web",
      by: "arjun.patel",
      minutesAgo: 20,
      note: "3DS modal v2 to 100% (PAYW-64)",
      breaksWhenOn: true,
      failure: {
        where: "client",
        share: 0.3,
        message:
          "Refused to frame 'https://acs.cardissuer.example/' because it violates the following Content Security Policy directive: \"frame-src 'self' https://vault.marlow.example\".",
      },
    },
    trap: {
      key: "checkout.threeds_redirect",
      description: "Full-page redirect for 3-D Secure, returning to /checkout/return",
      owner: "team-payments-web",
      by: "arjun.patel",
      daysAgo: 140,
      note: "redirect flow parked after app-router move (PAYW-40)",
      isOn: false,
      failure: { where: "client", share: 0.7, message: "Failed to load resource: the server responded with a status of 404 ()" },
    },
    view: {
      name: "threeds-paths",
      description: "Pay taps by 3-D Secure flow",
      heading: "Pay taps by 3-D Secure flow · checkout-web · last 5 min",
      healthyPath: "frictionless (no challenge)",
      culpritPath: "challenge in modal v2",
      trapPath: "redirect to /checkout/return",
      trapIdle: "— (parked since May)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 15% for 5m. checkout-api 5xx 0.2%. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers whose bank sends a code say the verification window is blank." },
      { at: 60, from: "Arjun Patel · Payments web", text: "Modal v2 went live at 13:51. If it’s the modal, turn on checkout.threeds_redirect and skip the popup." },
      { at: 120, from: "Noor Aziz · Web platform", text: "/checkout/return didn’t survive the app-router move in May. Also, with redirect on, every card gets a forced challenge." },
      { at: 240, from: "Sam Tan · Eng manager", text: "Card payments are most of our web revenue. Update?" },
    ],
    hints: [
      "There’s no 5xx. The browser refused something; read what.",
      "The new modal loads the bank’s page from a domain the page doesn’t allow.",
      "A fallback route has to exist before you send people to it.",
    ],
    solution: [
      { command: "rum errors", why: "The browser refused to frame the bank’s ACS page: modal v2 loads it directly, outside the vault frame the CSP allows." },
      { command: "rum threeds-paths", why: "Only challenges in modal v2 fail. The redirect flow has been parked since May." },
      { command: "flags history checkout.threeds_modal_v2", why: "Modal v2 went to 100% at 13:51." },
      { command: 'flags set checkout.threeds_modal_v2 off --note "frames ACS directly, blocked by CSP"', why: "Tabs go back to the v1 modal, which frames the ACS inside the vault iframe." },
      { command: "rum threeds-paths", why: "The modal v2 path empties and checkout loss drains." },
    ],
    postmortem: {
      question: "Why would the redirect flag have made this worse?",
      options: [
        "Banks refuse redirect-based challenges from merchants that also offer a popup flow",
        "It challenges every card, and its return page no longer exists",
        "Redirects lose the customer’s basket because the session cookie is marked SameSite=Strict",
        "It disables Apple Pay",
      ],
      answerIndex: 1,
      explanation: {
        cause: "3-D Secure modal v2, on at 13:51, framed the bank’s ACS page directly; the page’s CSP only allows frames from the vault, so the browser refused it.",
        why: "Turning checkout.threeds_modal_v2 off fixed it. checkout.threeds_redirect forces a challenge on every card and returns to /checkout/return, a route removed in May, so it would have stranded most card payments on a 404.",
        tell: "RUM’s top error was a CSP frame-src refusal for the issuer’s ACS domain, only on challenges in modal v2.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "loyalty-points-decimal",
    title: "Half a loyalty point",
    severity: "SEV3",
    opensAt: [17, 48],
    webVersion: "2026.10.10-4",
    briefing:
      "Since about 17:35, one web checkout in five fails when the customer redeems loyalty points. The loyalty team suggests switching off the whole loyalty module on checkout. checkout-api hasn’t deployed. Find what breaks, and what still expects the module to be there.",
    roleBriefing: "You own checkout-web: flags and RUM. Partial points redemption went live at 17:34; the loyalty module on checkout is its own flag.",
    culprit: {
      key: "checkout.loyalty_partial_redeem",
      description: "Slider to redeem any share of your points balance",
      owner: "team-loyalty-web",
      by: "chloe.martin",
      minutesAgo: 14,
      note: "partial redemption, 100% (LOY-58)",
      breaksWhenOn: true,
      failure: { where: "server", share: 0.2, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"loyalty: points_to_redeem 1250.5 is not an integer"}' },
    },
    trap: {
      key: "checkout.loyalty_module",
      description: "Show points balance and redemption on the payment step",
      owner: "team-loyalty-web",
      by: "chloe.martin",
      daysAgo: 260,
      note: "loyalty on checkout GA (LOY-12)",
      isOn: true,
      failure: { where: "client", share: 0.65, message: "Uncaught TypeError: Cannot read properties of undefined (reading 'balance')" },
    },
    view: {
      name: "loyalty-paths",
      description: "Pay taps by loyalty redemption",
      heading: "Pay taps by loyalty redemption · checkout-web · last 5 min",
      healthyPath: "no redemption, or whole points",
      culpritPath: "slider redemption",
      trapPath: "members, module off",
      trapIdle: "— (module on since January)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Members using the new points slider can’t pay. Paying without points works." },
      { at: 60, from: "Chloe Martin · Loyalty web", text: "We launched partial redemption at 17:34. Simplest is checkout.loyalty_module off until we patch." },
      { at: 130, from: "Lucas Meyer · Web engineer", text: "The order summary reads loyalty.balance for every signed-in member to show “points you’ll earn”. It assumes the module loaded." },
      { at: 240, from: "Sam Tan · Eng manager", text: "Members are our repeat buyers. How long?" },
    ],
    hints: [
      "Only customers redeeming points fail. Read what checkout-api says about the amount.",
      "Points are whole numbers; a slider over a balance isn’t always.",
      "Before removing a module, find who else reads from it.",
    ],
    solution: [
      { command: "rum errors", why: "loyalty rejects a fractional points_to_redeem: the slider sends 1250.5." },
      { command: "rum loyalty-paths", why: "Only slider redemptions fail. Checkout has never run for members without the module." },
      { command: "flags history checkout.loyalty_partial_redeem", why: "Partial redemption went on at 17:34." },
      { command: 'flags set checkout.loyalty_partial_redeem off --note "slider sends fractional points"', why: "Tabs go back to all-or-nothing redemption within ~20 s." },
      { command: "rum errors", why: "The loyalty 500s fade out." },
    ],
    postmortem: {
      question: "What would switching off the loyalty module have done?",
      options: [
        "Crashed the order summary for members, which still reads the module’s balance",
        "Wiped every member’s points balance",
        "Nothing, because members could still redeem their points from the account page and the cart page instead",
        "Charged members full price for items already discounted",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Partial redemption, on at 17:34, let the slider send a fractional points amount, and the loyalty service rejected it.",
        why: "Turning checkout.loyalty_partial_redeem off fixed it. The order summary reads loyalty.balance for every signed-in member, so turning checkout.loyalty_module off would have crashed checkout in the browser for most members, not only those redeeming points.",
        tell: "Every 500 showed a points_to_redeem with a .5 in it, only from the slider.",
      },
    },
    lostCheckoutsPerPoint: 120,
  },
  {
    slug: "tokenize-on-blur-off",
    title: "Card tokens that expired before Pay",
    severity: "SEV2",
    opensAt: [9, 33],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 09:25, three web checkouts in ten fail with “Something went wrong” after Pay. A performance change went out this morning. Someone suggests reloading the page automatically on payment errors so customers get a fresh token. Find what changed, and what a reload does to an open checkout.",
    roleBriefing: "You own checkout-web: flags and RUM. A flag that tokenized the card when the field lost focus was turned off at 09:10; a dormant flag reloads checkout on payment errors.",
    culprit: {
      key: "checkout.tokenize_on_blur",
      description: "Tokenize the card when the card field loses focus (fresh token at Pay)",
      owner: "team-checkout-web",
      by: "owen.price",
      minutesAgo: 23,
      note: "save a vault call per checkout; tokenize at page load instead (PERF-91)",
      breaksWhenOn: false,
      failure: { where: "server", share: 0.3, message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments-vault: token tok_5Wd2 expired (issued 16m ago, ttl 15m)"}' },
    },
    trap: {
      key: "checkout.reload_on_payment_error",
      description: "Reload the checkout page after a payment error",
      owner: "team-checkout-web",
      by: "priya.shah",
      daysAgo: 220,
      note: "experiment, never enabled (FE-1530)",
      isOn: false,
      failure: { where: "client", share: 0.5, message: "[checkout] cart missing after reload (sessionStorage 'marlow:checkout' empty); Pay disabled" },
    },
    view: {
      name: "token-age",
      description: "Pay taps by card token age at Pay",
      heading: "Pay taps by card token age at Pay · checkout-web · last 5 min",
      healthyPath: "token under 15 min",
      culpritPath: "token minted at load, over 15 min",
      trapPath: "reloaded after error",
      trapIdle: "— (flag never on in production)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout, web only. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers who took a while on the address step fail at Pay. Quick checkouts work." },
      { at: 60, from: "Owen Price · Web engineer", text: "I turned off checkout.tokenize_on_blur at 09:10 to save a vault call; we tokenize at page load now." },
      { at: 100, from: "Priya Shah · Frontend lead", text: "There’s checkout.reload_on_payment_error from an old experiment. A reload gets a new token, right?" },
      { at: 160, from: "Lucas Meyer · Web engineer", text: "The checkout state lives in sessionStorage keyed per page load. A reload starts a new key; the cart wouldn’t come back." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Morning revenue is down. What’s the plan?" },
    ],
    hints: [
      "Slow checkouts fail and quick ones don’t. Look for something with a time limit.",
      "Something that used to happen late in checkout now happens at the start.",
      "A reload is a fresh start in more ways than one.",
    ],
    solution: [
      { command: "rum errors", why: "payments-vault rejects tokens older than their 15-minute TTL." },
      { command: "rum token-age", why: "Only tokens minted at page load and older than 15 minutes fail. Reload-on-error has never run." },
      { command: "flags history checkout.tokenize_on_blur", why: "Tokenize-on-blur was turned off at 09:10, about 15 minutes before the 500s began." },
      { command: 'flags set checkout.tokenize_on_blur on --note "load-time tokens expire before Pay"', why: "Tabs mint the token when the card field loses focus again, minutes before Pay." },
      { command: "rum token-age", why: "The expired-token path empties and the 500s stop." },
    ],
    postmortem: {
      question: "Why would reloading on payment errors have made it worse?",
      options: [
        "Reloads would mint so many tokens that the vault would rate-limit everyone",
        "A reload loses the checkout state, so customers end up without a cart",
        "The reload would re-run the payment and charge the customer twice, since the failed attempt is still pending",
        "Browsers block automatic reloads on HTTPS pages",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Turning checkout.tokenize_on_blur off at 09:10 moved tokenization to page load; customers who took longer than 15 minutes arrived at Pay with an expired token.",
        why: "Turning it back on fixed it. checkout.reload_on_payment_error was an unfinished experiment: checkout state is keyed per page load in sessionStorage, so a reload would have left customers on a checkout with no cart, instead of one they could retry.",
        tell: "Every 500 was an expired token issued more than 15 minutes earlier, and the first ones came 15 minutes after the change.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "polyfills-legacy-bundle",
    title: "Older Safari can’t make an order id",
    severity: "SEV3",
    opensAt: [20, 14],
    webVersion: "2026.10.10-5",
    briefing:
      "Since about 19:50, customers on older Safari versions can’t pay on web: the button throws in the browser. A bundle-size change went out this evening. Someone suggests serving the legacy bundle to everyone to be safe. Find what changed, and check that the legacy bundle still loads.",
    roleBriefing: "You own checkout-web: flags and RUM. Polyfills for older browsers were switched off at 19:47; another flag decides whether browsers get the modern or legacy bundle.",
    culprit: {
      key: "web.legacy_polyfills",
      description: "Ship polyfills to browsers that fail the feature check",
      owner: "team-web-platform",
      by: "noor.aziz",
      minutesAgo: 27,
      note: "drop polyfills: -38 kB, analytics says <1% need them (WEB-802)",
      breaksWhenOn: false,
      failure: { where: "client", share: 0.18, message: "Uncaught TypeError: crypto.randomUUID is not a function" },
    },
    trap: {
      key: "web.modern_bundle",
      description: "Serve the ES2022 module bundle; off serves the legacy ES5 bundle to all",
      owner: "team-web-platform",
      by: "noor.aziz",
      daysAgo: 160,
      note: "module bundle GA; legacy build deprecated (WEB-690)",
      isOn: true,
      failure: { where: "client", share: 0.9, message: "Uncaught SyntaxError: Unexpected token 'export'" },
    },
    view: {
      name: "browser-paths",
      description: "Pay taps by browser support and bundle",
      heading: "Pay taps by browser and bundle · checkout-web · last 5 min",
      healthyPath: "modern bundle · current browsers",
      culpritPath: "modern bundle · Safari < 15.4, no polyfills",
      trapPath: "legacy bundle",
      trapIdle: "— (not served since April)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — web checkout loss > 5% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers on older iPads and Macs say Pay does nothing. Newer devices are fine." },
      { at: 60, from: "Noor Aziz · Web platform", text: "I turned off web.legacy_polyfills at 19:47; analytics said under 1% of sessions needed them." },
      { at: 100, from: "Owen Price · Web engineer", text: "Safest is web.modern_bundle off, so every browser gets the legacy bundle." },
      { at: 160, from: "Lucas Meyer · Web engineer", text: "The legacy build stopped being transpiled in April; it ships ES modules now. Nobody’s loaded it since." },
      { at: 240, from: "Sam Tan · Eng manager", text: "Older devices skew towards our older customers, who buy a lot. Update?" },
    ],
    hints: [
      "Only older devices fail. Read what their browsers report.",
      "Analytics undercounts the browsers it can’t run in.",
      "A fallback build nobody has loaded in months may not be a fallback any more.",
    ],
    solution: [
      { command: "rum errors", why: "Older Safari has no crypto.randomUUID; the polyfill that provided it is gone." },
      { command: "rum browser-paths", why: "Only older Safari on the modern bundle fails. The legacy bundle hasn’t been served since April." },
      { command: "flags history web.legacy_polyfills", why: "Polyfills were turned off at 19:47, minutes before the failures." },
      { command: 'flags set web.legacy_polyfills on --note "older Safari needs crypto.randomUUID"', why: "Browsers that fail the feature check get polyfills again within ~20 s." },
      { command: "rum browser-paths", why: "The older-Safari failures drain." },
    ],
    postmortem: {
      question: "Why would serving the legacy bundle to everyone have backfired?",
      options: [
        "It still ships ES modules as a classic script, so it fails to parse in every browser",
        "It’s three times the size, so slow connections would time out",
        "The legacy bundle predates Apple Pay, so express checkout would disappear for every Safari customer",
        "It sends analytics to a retired endpoint",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Turning web.legacy_polyfills off at 19:47 removed crypto.randomUUID for Safari before 15.4, and checkout uses it to make the order’s idempotency key.",
        why: "Turning it back on fixed it. web.modern_bundle off would serve the legacy build, which stopped being transpiled in April and now ships export statements as a classic script; it throws a SyntaxError in every browser, so checkout would break for nearly everyone.",
        tell: "The TypeError named crypto.randomUUID and came only from Safari versions before 15.4, starting at 19:47.",
      },
    },
    lostCheckoutsPerPoint: 110,
  },
];

export const FRONTEND_TIER3_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
