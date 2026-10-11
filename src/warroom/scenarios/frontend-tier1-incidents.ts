import type { CommsMessage, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { clientDefects } from "../sim/client-defects.ts";
import { clientSegments, unsafeRetryShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { findFlag, isFlagOn, type ClientBuild } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const HOUR = 3600;
const MINUTE = 60;
/** A storm opens three minutes after its surge, once it has taken hold, as in web-auto-retry-storm. */
const STORM_WARM_UP_SECONDS = 180;
const ORGANIC_RPS = 300;

/** The flag whose change caused the incident: flipping it back is the fix. */
type CulpritFlag = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  readonly minutesAgo: number;
  readonly note: string;
  /** True when the incident began as the flag went on; false when someone turned it off. */
  readonly breaksWhenOn: boolean;
};

/** The flag a teammate blames: it changed recently too, and flipping it changes nothing. */
type DecoyFlag = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  readonly minutesAgo: number;
  readonly note: string;
  readonly isOn: boolean;
};

type Mechanic =
  /** A web build bug that fires while the culprit flag is in its breaking state. */
  | { readonly kind: "defect"; readonly where: "server" | "client"; readonly failShare: number; readonly message: string }
  /** The culprit flag puts the Pay button on instant retries while the gateway is degraded and a surge has passed. */
  | { readonly kind: "retry-storm"; readonly chargesPerSecond: number; readonly surgeRps: number; readonly surgeSeconds: number; readonly gatewayStatus: string };

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly webVersion: string;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly culprit: CulpritFlag;
  readonly decoy: DecoyFlag;
  readonly mechanic: Mechanic;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
};

const FUNNEL_VIEW = "funnel";

function isCulpritFixed(state: ClusterState, culprit: CulpritFlag): boolean {
  const flag = state.commerce && findFlag(state.commerce, culprit.key);
  return !!flag && isFlagOn(flag) !== culprit.breaksWhenOn;
}

/** Pay taps per web release, and how many died in the browser before any request went out. */
function funnel(state: ClusterState): readonly string[] {
  const commerce = state.commerce;
  if (!commerce) return ["rum: no web sessions in window"];
  const rows = clientSegments(commerce, state.t)
    .filter((segment) => segment.platform === "web")
    .map((segment) => {
      const taps = commerce.pulse.organicCheckoutsPerSecond * segment.share * WINDOW_SECONDS;
      const died = clientDefects(commerce, segment, state.t).clientFailureShare;
      return [segment.version, count(taps), count(taps * died), percent(died), count(taps * (1 - died))];
    });
  return [
    "checkout-web · Pay tap → POST /checkout · last 5 min",
    ...table([["RELEASE", "PAY TAPS", "DIED IN BROWSER", "SHARE", "POST /checkout SENT"], ...rows]),
    "Same hour last week: 0.2% of Pay taps never sent a request.",
  ];
}

function webBuild(row: Row): ClientBuild {
  const { mechanic, culprit } = row;
  if (mechanic.kind === "retry-storm") {
    const retry = culprit.breaksWhenOn
      ? ({ kind: "flag", key: culprit.key, whenOn: "immediate", whenOff: "none" } as const)
      : ({ kind: "flag", key: culprit.key, whenOn: "none", whenOff: "immediate" } as const);
    return { version: row.webVersion, userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry };
  }
  return {
    version: row.webVersion,
    userAgent: WEB_USER_AGENT,
    timeoutMs: 8000,
    retry: NO_RETRY,
    defects: [{ trigger: { flag: culprit.key, failsWhenOn: culprit.breaksWhenOn }, failShare: mechanic.failShare, where: mechanic.where, message: mechanic.message }],
  };
}

function incident(row: Row): Scenario {
  const id = `fe-t1-${row.slug}`;
  const { culprit, decoy, mechanic } = row;
  const isStorm = mechanic.kind === "retry-storm";
  const isClientSide = mechanic.kind === "defect" && mechanic.where === "client";
  const warmUpSeconds = isStorm ? STORM_WARM_UP_SECONDS : 30;
  const flags = [
    {
      key: culprit.key,
      description: culprit.description,
      owner: culprit.owner,
      history: [{ at: -culprit.minutesAgo * MINUTE, by: culprit.by, from: !culprit.breaksWhenOn, to: culprit.breaksWhenOn, note: culprit.note }] as const,
    },
    {
      key: decoy.key,
      description: decoy.description,
      owner: decoy.owner,
      history: [{ at: -decoy.minutesAgo * MINUTE, by: decoy.by, from: !decoy.isOn, to: decoy.isOn, note: decoy.note }] as const,
    },
    ...SHOP_FLAGS,
  ];
  return {
    id,
    tier: 1,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["frontend"],
    roleBriefings: { frontend: row.roleBriefing },
    suggestions: {
      frontend: [
        "rum overview",
        "rum errors",
        ...(isClientSide ? [`rum ${FUNNEL_VIEW}`] : ["rum session"]),
        "flags list",
        `flags history ${decoy.key}`,
        `flags set ${decoy.key} ${decoy.isOn ? "off" : "on"}`,
      ],
    },
    opensAtSecondOfDay: row.opensAt[0] * HOUR + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
        revision: 6,
        commerce: checkoutCommerce({
          platforms: { web: { current: webBuild(row) } },
          flags,
          ...(mechanic.kind === "retry-storm" ? { gateway: { chargesPerSecond: mechanic.chargesPerSecond } } : {}),
        }),
        ...(mechanic.kind === "retry-storm"
          ? { warmUp: { seconds: warmUpSeconds, requestsPerSecond: (second: number) => (second < mechanic.surgeSeconds ? mechanic.surgeRps : ORGANIC_RPS) } }
          : {}),
      }),
    isRootCauseFixed: isStorm ? (state) => !!state.commerce && unsafeRetryShare(state.commerce, state.t) < 0.001 : (state) => isCulpritFixed(state, culprit),
    ...(isClientSide
      ? {
          alertMetric: { label: "checkout loss", rate: (state: ClusterState) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
          evidence: [{ tool: "rum" as const, name: FUNNEL_VIEW, description: "Pay taps that never sent POST /checkout, by web release", run: funnel }],
        }
      : {}),
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [
      mechanic.kind === "retry-storm"
        ? {
            id: "payment-gateway",
            status: "degraded",
            facts: [
              { key: "Status page", value: mechanic.gatewayStatus },
              { key: "Throughput for us", value: `≈${mechanic.chargesPerSecond} charges/s while degraded; excess queues FIFO` },
              { key: "checkout-api timeout", value: "3000 ms per call" },
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
    solution: { frontend: row.solution },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "saved-card-fingerprint",
    title: "Saved cards stopped paying",
    severity: "SEV2",
    opensAt: [9, 24],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 09:10, web customers paying with a card they saved before get “Something went wrong” at Pay. New cards go through, the apps are fine and checkout-api hasn’t deployed this week. You’re the frontend on-call; Priya, the frontend lead, is on the call.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM for the checkout page. The saved-cards team turned something on this morning.",
    culprit: {
      key: "checkout.saved_cards_v2",
      description: "Redesigned saved-card picker on the payment step",
      owner: "team-wallet-web",
      by: "omar.haddad",
      minutesAgo: 14,
      note: "saved-card picker v2 to 100% (WAL-118)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.trust_badges",
      description: "Security badges beside the Pay button",
      owner: "team-growth",
      by: "lena.ortiz",
      minutesAgo: 22,
      note: "A/B winner, ship to all",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "server",
      failShare: 0.55,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments-vault: \\"fp_9c1e07a2\\" is not a vault token (expected tok_…)"}',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "RUM errors first. A 500 from checkout-api usually says what it didn’t like about the request." },
      { at: 45, from: "Maya Okonkwo · Support", text: "Customers paying with a saved Visa or Mastercard get “Something went wrong”. Typing the card in fresh works." },
      { at: 80, from: "Lena Ortiz · Growth", text: "My trust badges went live just before nine. They sit right next to Pay; should I pull them?" },
      { at: 120, from: "Priya Shah · Frontend lead (your mentor)", text: "Whatever sends the card to checkout-api changed. Look at what changed on the payment step this morning, and when." },
      { at: 200, from: "Sam Tan · Eng manager", text: "Returning customers are our best customers. How close are we?" },
    ],
    hints: [
      "Only some checkouts fail. Find what the failing ones send that the others don’t.",
      "The error names what checkout-api received in place of a card token.",
      "Only one change this morning touches how a saved card is picked.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api answers 500: payments-vault got a card fingerprint (fp_) where it expects a vault token (tok_)." },
      { command: "flags history checkout.saved_cards_v2", why: "The new saved-card picker went to 100% at 09:10, when the 500s began." },
      { command: 'flags set checkout.saved_cards_v2 off --note "v2 picker sends fingerprints, not tokens"', why: "Tabs fall back to the old picker within ~20 s; it sends the vault token." },
      { command: "rum overview", why: "HTTP 500 drains to zero as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did saved cards fail at checkout this morning?",
      options: [
        "The trust badges beside Pay intercepted the click on some browsers",
        "The payment gateway stopped accepting cards saved before this month",
        "The new picker sent a card fingerprint instead of the vault token",
        "checkout-api expired every saved card token during an overnight job",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout.saved_cards_v2, turned on for everyone at 09:10, sent the saved card’s fingerprint where checkout-api expects the payments-vault token.",
        why: "payments-vault charges by token. The v2 picker read the wrong field off the saved card, so every checkout with a saved card reached checkout-api carrying fp_… and failed with a 500. New cards are tokenized on the spot, so they still worked, as did the apps, which never had the v2 picker.",
        tell: "RUM’s top error was a 500 naming an fp_ value where a tok_ token belonged, starting the minute the picker flag went to 100%.",
      },
    },
    lostCheckoutsPerPoint: 150,
  },
  {
    slug: "promo-code-array",
    title: "Promo codes break the order",
    severity: "SEV2",
    opensAt: [18, 7],
    webVersion: "2026.10.10-3",
    briefing:
      "The evening newsletter promised 15% off with code FALL15. Since about 17:55, web checkouts that carry a promo code fail with “Something went wrong”. Checkouts without a code go through and the apps look healthy. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. Growth changed how promo codes are entered this evening.",
    culprit: {
      key: "checkout.promo_code_inline",
      description: "Promo code field inline in the order summary, with stacking",
      owner: "team-growth-web",
      by: "kai.moreno",
      minutesAgo: 12,
      note: "inline promo field + stacking for the newsletter (GRW-77)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "home.newsletter_popup",
      description: "Newsletter sign-up modal on first visit",
      owner: "team-growth",
      by: "lena.ortiz",
      minutesAgo: 30,
      note: "evening campaign",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "server",
      failShare: 0.4,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"promotions: expected string at $.promo_code, got array"}',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Everyone writing in used FALL15. Without the code, checkout works." },
      { at: 50, from: "Priya Shah · Frontend lead (your mentor)", text: "Read what checkout-api says in its 500s. If it names a field, find what changed about that field." },
      { at: 85, from: "Lena Ortiz · Growth", text: "The newsletter popup is new tonight and it’s everywhere. Kill it?" },
      { at: 140, from: "Kai Moreno · Web engineer", text: "I put the promo field inline in the summary at 17:55 so codes can stack. It worked on staging." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "The newsletter went to 2 million people and the code doesn’t work. ETA?" },
    ],
    hints: [
      "Checkouts without a discount go through. Look at what the discounted ones send.",
      "checkout-api’s error describes the shape of one field, not its value.",
      "A change that lets customers stack codes changes what that field holds.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api answers 500: promotions expected a string promo_code and got an array." },
      { command: "flags list", why: "checkout.promo_code_inline went on at 17:55, minutes before the errors; the popup is unrelated to checkout." },
      { command: 'flags set checkout.promo_code_inline off --note "stacked codes arrive as an array"', why: "Tabs go back to the single-code field within ~20 s; checkout-api accepts it." },
      { command: "rum errors", why: "The promotions 500s fade out as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did checkouts with FALL15 fail?",
      options: [
        "The inline field sent promo_code as a list, and checkout-api expected text",
        "The newsletter popup covered the Pay button for customers arriving from email",
        "FALL15 was never created in the promotions service before the email went out",
        "The payment gateway declined discounted orders as possible card testing",
      ],
      answerIndex: 0,
      explanation: {
        cause: "checkout.promo_code_inline, turned on at 17:55 so codes could stack, sent promo_code as an array; checkout-api’s promotions step only accepts a string.",
        why: "Stacking meant the field could hold several codes, so the new component always sent a list. checkout-api failed on the type and answered 500, but only for checkouts carrying a code, which is why tonight’s newsletter readers were hit and everyone else was not.",
        tell: "RUM’s top error was a 500 saying promotions expected a string at $.promo_code and got an array, starting at 17:55.",
      },
    },
    lostCheckoutsPerPoint: 120,
  },
  {
    slug: "strict-csp-vault-frame",
    title: "The card form went blank",
    severity: "SEV1",
    opensAt: [10, 52],
    webVersion: "2026.10.10-2",
    briefing:
      "Since about 10:40, the card form on web checkout is an empty box. checkout-api is quiet, with almost no 5xx, but web orders have collapsed. The apps are fine. You’re the frontend on-call; Priya is on the call.",
    roleBriefing: "You own checkout-web: flags and RUM. Web platform has been tightening the site’s Content-Security-Policy this week.",
    culprit: {
      key: "web.strict_csp",
      description: "Serve the strict Content-Security-Policy header on every page",
      owner: "team-web-platform",
      by: "ines.kowal",
      minutesAgo: 12,
      note: "enforce strict CSP after report-only week (SEC-402)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.address_map_preview",
      description: "Map thumbnail of the shipping address",
      owner: "team-checkout-web",
      by: "tom.adeyemi",
      minutesAgo: 25,
      note: "map preview GA",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "client",
      failShare: 0.9,
      message:
        "Refused to frame 'https://vault.marlow.example/' because it violates the following Content Security Policy directive: \"frame-src 'self'\".",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — web checkout loss > 40% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "No 5xx means the request never leaves the browser. Check the console errors in RUM, then the funnel." },
      { at: 40, from: "Maya Okonkwo · Support", text: "Screenshots show the card box empty. No spinner, no error, just white." },
      { at: 75, from: "Tom Adeyemi · Web engineer", text: "The map preview went out this morning and loads a third-party script. Want me to turn it off?" },
      { at: 120, from: "Priya Shah · Frontend lead (your mentor)", text: "The card form lives in an iframe from the vault. Anything that changes what the page may embed would blank it." },
      { at: 210, from: "Elena Ruiz · VP Engineering", text: "Half our revenue is web and it’s near zero. What’s the plan?" },
    ],
    hints: [
      "checkout-api sees nothing wrong. The checkout dies before any request goes out.",
      "The card form is embedded from another origin. Look for the browser refusing to load it.",
      "The policy the browser quotes is served by the site, and someone changed it this morning.",
    ],
    solution: [
      { command: "rum funnel", why: "Nine in ten Pay taps never send POST /checkout: the card form has nothing in it to submit." },
      { command: "rum errors", why: "Chrome refuses to frame vault.marlow.example: the page’s CSP now allows frames only from 'self'." },
      { command: 'flags set web.strict_csp off --note "frame-src blocks the payments-vault iframe"', why: "Pages go back to the report-only policy within ~20 s, and the vault iframe loads again." },
      { command: "rum funnel", why: "DIED IN BROWSER falls toward zero as tabs reload the policy." },
    ],
    postmortem: {
      question: "Why was the card form blank on web?",
      options: [
        "The map preview’s third-party script crashed the page before the form rendered",
        "The strict CSP allowed frames only from 'self', blocking the vault iframe",
        "payments-vault was down, so its iframe returned an empty page to every browser",
        "checkout-api rejected web requests that carried the new security headers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "web.strict_csp, enforced at 10:40, served frame-src 'self', and the card form is an iframe from vault.marlow.example.",
        why: "The strict policy had run in report-only mode for a week, where violations are only logged. Once enforced, Chrome refused to frame the vault, so customers saw an empty card box and could not submit. No request reached checkout-api, which is why 5xx stayed flat while orders collapsed.",
        tell: "RUM’s console showed Chrome refusing to frame vault.marlow.example under frame-src 'self', and the funnel showed taps dying in the browser from 10:40.",
      },
    },
    lostCheckoutsPerPoint: 300,
  },
  {
    slug: "order-summary-line-items",
    title: "Pay crashes the page",
    severity: "SEV2",
    opensAt: [14, 16],
    webVersion: "2026.10.10-4",
    briefing:
      "Since just after 14:00, tapping Pay on web freezes the checkout for many customers: the button greys out and nothing happens. checkout-api 5xx is flat. The apps are fine. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The order summary was redesigned and rolled out today.",
    culprit: {
      key: "checkout.order_summary_v3",
      description: "Redesigned order summary with per-item delivery dates",
      owner: "team-checkout-web",
      by: "nina.berg",
      minutesAgo: 13,
      note: "order summary v3 to 100% (FE-2331)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "search.typo_tolerance_v2",
      description: "Second pass of fuzzy product search",
      owner: "team-search",
      by: "dev.raman",
      minutesAgo: 20,
      note: "retry after SRCH-311 fix",
      isOn: true,
    },
    mechanic: { kind: "defect", where: "client", failShare: 0.5, message: "Uncaught TypeError: Cannot read properties of undefined (reading 'lineItems')" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 20% for 5m. checkout-api 5xx 0.1%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "A frozen button with no 5xx is usually a JavaScript exception. RUM errors will have it." },
      { at: 45, from: "Maya Okonkwo · Support", text: "It seems to hit customers with items from more than one warehouse. Single-item carts are fine." },
      { at: 80, from: "Dev Raman · Search", text: "Search typo tolerance went back on at 13:56. It’s not on the checkout page, but say the word and I’ll turn it off." },
      { at: 130, from: "Priya Shah · Frontend lead (your mentor)", text: "The exception names the property it tried to read. Which component reads line items, and what changed about it today?" },
      { at: 210, from: "Sam Tan · Eng manager", text: "Half of web checkouts are stuck. How long?" },
    ],
    hints: [
      "Nothing reaches checkout-api from the failing taps. The browser is where it breaks.",
      "The exception says which property it tried to read, and on what kind of value.",
      "Only one change today touches the part of the page that lists what’s in the cart.",
    ],
    solution: [
      { command: "rum errors", why: "Half of Pay taps throw TypeError reading 'lineItems' of undefined." },
      { command: "flags history checkout.order_summary_v3", why: "Order summary v3 went to 100% at 14:03; it reads line items per shipment, and split shipments have none at the top." },
      { command: 'flags set checkout.order_summary_v3 off --note "split-shipment carts throw on Pay"', why: "Tabs return to the v2 summary within ~20 s." },
      { command: "rum funnel", why: "Taps that died in the browser drop toward zero." },
    ],
    postmortem: {
      question: "Why did Pay freeze for half of web customers?",
      options: [
        "Search typo tolerance loaded on the checkout page and blocked the main thread",
        "checkout-api timed out on carts with items from more than one warehouse",
        "The browser ran out of memory rendering delivery dates for large carts",
        "The v3 order summary read line items that split-shipment carts don’t have",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout.order_summary_v3, rolled out at 14:03, read cart.shipment.lineItems, which is undefined when a cart ships from more than one warehouse.",
        why: "The new summary assumed one shipment per cart. Split-shipment carts carry a list of shipments instead, so the Pay handler threw a TypeError before building the request. The button greyed out and nothing reached checkout-api, which is why 5xx stayed flat.",
        tell: "RUM showed TypeError: Cannot read properties of undefined (reading 'lineItems') on half of Pay taps from 14:03, and the funnel showed them dying in the browser.",
      },
    },
    lostCheckoutsPerPoint: 200,
  },
  {
    slug: "cart-snapshot-quota",
    title: "Big carts can’t check out",
    severity: "SEV2",
    opensAt: [20, 38],
    webVersion: "2026.10.10-5",
    briefing:
      "Since about 20:25, web customers with big carts say Pay does nothing. Small carts work. checkout-api is healthy and the apps are fine. You’re the frontend on-call; Priya is on the call.",
    roleBriefing: "You own checkout-web: flags and RUM. The cart team shipped offline cart recovery behind a flag this evening.",
    culprit: {
      key: "checkout.persist_cart_snapshot",
      description: "Save a full cart snapshot to localStorage before submitting",
      owner: "team-cart-web",
      by: "ravi.menon",
      minutesAgo: 13,
      note: "offline cart recovery, 100% (CRT-54)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.express_pay_paypal",
      description: "PayPal button beside Apple Pay / Google Pay",
      owner: "team-checkout-web",
      by: "priya.shah",
      minutesAgo: 40,
      note: "PayPal express GA",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "client",
      failShare: 0.3,
      message: "Uncaught DOMException: Failed to execute 'setItem' on 'Storage': Setting the value of 'marlow:cart-snapshot' exceeded the quota.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 20, from: "Priya Shah · Frontend lead (your mentor)", text: "If the request never leaves, the console knows why. Start with RUM errors." },
      { at: 55, from: "Maya Okonkwo · Support", text: "A customer with 40 items says Pay does nothing. She removed half and it worked." },
      { at: 90, from: "Priya Shah · Frontend lead (your mentor)", text: "PayPal express went GA tonight too. Don’t flip anything until you know which one the error points at." },
      { at: 140, from: "Ravi Menon · Web engineer", text: "Cart recovery writes the whole cart, images and all, to localStorage before Pay. I only tested it on short carts." },
      { at: 220, from: "Sam Tan · Eng manager", text: "Big carts are our biggest orders. Where are we?" },
    ],
    hints: [
      "Small carts work. Something about a big cart breaks before the request goes out.",
      "Browsers give each site a few megabytes of local storage, and the error says what tried to write there.",
      "One change this evening writes the cart somewhere before Pay sends it.",
    ],
    solution: [
      { command: "rum errors", why: "Pay throws a quota DOMException writing marlow:cart-snapshot to localStorage." },
      { command: "rum funnel", why: "About three in ten Pay taps die in the browser: the big carts." },
      { command: 'flags set checkout.persist_cart_snapshot off --note "snapshot exceeds localStorage quota on big carts"', why: "Tabs stop writing the snapshot within ~20 s, and Pay goes straight to POST /checkout." },
      { command: "rum funnel", why: "DIED IN BROWSER falls toward zero." },
    ],
    postmortem: {
      question: "Why couldn’t customers with big carts check out?",
      options: [
        "The PayPal button replaced the card form for carts above a certain total",
        "checkout-api rejected request bodies over its size limit for large carts",
        "The cart snapshot overflowed localStorage, and the throw stopped Pay",
        "Product images in big carts loaded so slowly that the Pay button stayed disabled",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout.persist_cart_snapshot, on since 20:25, wrote the full cart to localStorage before submitting, and big carts went over the browser’s quota.",
        why: "localStorage gives each origin a few megabytes. The snapshot included every item’s image URLs and variants, so large carts overflowed it, setItem threw, and nothing caught it: the Pay handler stopped before sending the request. Small carts fit, and checkout-api never saw the failures.",
        tell: "RUM’s console showed setItem exceeding the quota on 'marlow:cart-snapshot', and only Pay taps from big carts died in the browser.",
      },
    },
    lostCheckoutsPerPoint: 110,
  },
  {
    slug: "tax-preview-cors",
    title: "Checkout waits on tax forever",
    severity: "SEV2",
    opensAt: [12, 31],
    webVersion: "2026.10.10-2",
    briefing:
      "Since about 12:20, many web customers see “Calculating tax…” under the total and the Pay button never enables. checkout-api 5xx is flat and the apps are fine. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The tax team moved their live preview to a new host this week.",
    culprit: {
      key: "checkout.live_tax_preview",
      description: "Fetch a live tax estimate from tax.marlow.example as the address changes",
      owner: "team-tax",
      by: "grace.liu",
      minutesAgo: 11,
      note: "live tax preview from the new tax host (TAX-210)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "home.recently_viewed",
      description: "Recently viewed products strip on the home page",
      owner: "team-discovery",
      by: "ari.cohen",
      minutesAgo: 18,
      note: "ramp to 100%",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "client",
      failShare: 0.65,
      message:
        "Access to fetch at 'https://tax.marlow.example/v2/preview' from origin 'https://www.marlow.example' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. If an opaque response serves your needs, set the request's mode to 'no-cors' to fetch the resource with CORS disabled.",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 20% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "Pay never enabling means something it waits for never arrives. Check the console for a request the browser blocked." },
      { at: 50, from: "Maya Okonkwo · Support", text: "“Calculating tax…” spins forever. One customer waited ten minutes." },
      { at: 85, from: "Ari Cohen · Discovery", text: "Recently viewed went to 100% at 12:13. It only lives on the home page, but I can switch it off." },
      { at: 130, from: "Grace Liu · Tax", text: "We cut the preview over to tax.marlow.example at 12:20. The service is up; I can curl it fine." },
      { at: 210, from: "Elena Ruiz · VP Engineering", text: "Lunch peak and web can’t pay. ETA?" },
    ],
    hints: [
      "The Pay button waits for one value before it enables. Find out why it never arrives.",
      "A request from the page to a different host needs that host’s permission, and the browser says when it’s missing.",
      "The service answering a command-line request doesn’t mean a browser is allowed to read it.",
    ],
    solution: [
      { command: "rum errors", why: "Chrome blocks the fetch to tax.marlow.example: the new host sends no Access-Control-Allow-Origin header." },
      { command: "flags history checkout.live_tax_preview", why: "The live preview switched to the new host at 12:20, when the spinners began." },
      { command: 'flags set checkout.live_tax_preview off --note "tax host missing CORS headers"', why: "Tabs fall back to the tax quote checkout-api returns, within ~20 s; Pay enables again." },
      { command: "rum funnel", why: "Pay taps that never sent a request fall toward zero." },
    ],
    postmortem: {
      question: "Why did “Calculating tax…” never finish on web?",
      options: [
        "The tax host sent no CORS header, so the browser blocked the preview",
        "The recently viewed strip used up the browser’s connection limit to the API",
        "The tax service was down, so every preview request timed out on its side",
        "checkout-api refused to quote tax for addresses entered by autocomplete",
      ],
      answerIndex: 0,
      explanation: {
        cause: "checkout.live_tax_preview pointed the page at tax.marlow.example at 12:20, and that host sends no Access-Control-Allow-Origin header for www.marlow.example.",
        why: "A cross-origin fetch only succeeds if the other host allows the page’s origin. The tax service answered every request, which is why curl worked, but Chrome refused to hand the response to the page. The preview never resolved, so Pay never enabled and no checkout was sent.",
        tell: "RUM’s console showed the CORS block on tax.marlow.example/v2/preview from 12:20, and the funnel showed taps that never sent POST /checkout.",
      },
    },
    lostCheckoutsPerPoint: 240,
  },
  {
    slug: "gateway-error-retries",
    title: "Midnight drop, nothing ships",
    severity: "SEV1",
    opensAt: [0, 3],
    webVersion: "2026.10.09-4",
    briefing:
      "The limited sneaker drop opened at midnight. Three minutes later most checkouts fail, though the rush has already passed and the payment gateway is only slow. You’re the frontend on-call; Priya is on the call.",
    roleBriefing: "You own checkout-web: flags and RUM. Last night’s release added a flag that changes what Pay does when checkout-api returns an error.",
    culprit: {
      key: "checkout.retry_gateway_errors",
      description: "Resubmit POST /checkout automatically on 502/503/504 or timeout",
      owner: "team-checkout-web",
      by: "web-release-bot",
      minutesAgo: 6 * 60,
      note: "web 2026.10.09-4 (FE-2350): resubmit on gateway errors",
      breaksWhenOn: true,
    },
    decoy: {
      key: "drops.queue_page",
      description: "Virtual waiting room before limited drops",
      owner: "team-drops",
      by: "jules.ward",
      minutesAgo: 5,
      note: "queue page off after the opening rush",
      isOn: false,
    },
    mechanic: {
      kind: "retry-storm",
      chargesPerSecond: 150,
      surgeRps: 500,
      surgeSeconds: 40,
      gatewayStatus: "Elevated latency in us-east — retry with exponential backoff (since 23:48)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx > 50% since the drop opened. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "Look at REQ/TAP in RUM. If each Pay tap turns into several requests, the browser is the load." },
      { at: 45, from: "Jules Ward · Drops", text: "I took the waiting room down at 23:58 once the rush passed. Should I put it back?" },
      { at: 90, from: "Maya Okonkwo · Support", text: "People say Pay spins, fails, and spins again on its own. A few are scared they’ve been charged twice." },
      { at: 140, from: "Priya Shah · Frontend lead (your mentor)", text: "The release last night added resubmits on gateway errors. flags history will show it." },
      { at: 220, from: "Priya Shah · Frontend lead (your mentor)", text: "Once the resubmits stop, the gateway queue has to drain. Give it a couple of minutes." },
    ],
    hints: [
      "The rush is over, yet checkout keeps failing. Count how many requests each Pay tap sends.",
      "Something in last night’s release decides what the browser does when checkout-api returns an error.",
      "Holding new shoppers back won’t help: the extra load comes from shoppers already at Pay.",
    ],
    solution: [
      { command: "rum overview", why: "Each Pay tap sends about four POST /checkout requests." },
      { command: "rum session", why: "Retries fire 2 ms after each timeout with the same body and no Idempotency-Key." },
      { command: "flags history checkout.retry_gateway_errors", why: "Resubmits shipped on with last night’s release." },
      { command: 'flags set checkout.retry_gateway_errors off --note "resubmits keep the gateway queue full"', why: "Tabs stop resubmitting within ~20 s; the queue can drain." },
      { command: "rum overview", why: "REQ/TAP falls back to 1.00, and orders return once the queue drains." },
    ],
    postmortem: {
      question: "Why did checkout stay down after the drop’s opening rush?",
      options: [
        "Taking the waiting room down let too many shoppers reach checkout at once",
        "The payment gateway stopped processing charges for every merchant at midnight",
        "Every failed Pay was resubmitted at once, so the gateway queue never drained",
        "checkout-api pods ran out of database connections when the drop opened",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout.retry_gateway_errors, shipped on in web 2026.10.09-4, resubmitted every failed checkout immediately while the gateway was slow.",
        why: "The opening rush outran the degraded gateway, so its queue grew and calls timed out. Each timeout made the browser resubmit at once, so the gateway saw about four times the real demand and never caught up after the rush passed. Turning resubmits off let the queue drain.",
        tell: "RUM showed about four POST /checkout per Pay tap, 2 ms apart, on 2026.10.09-4, against 1.00 on normal nights.",
      },
    },
    lostCheckoutsPerPoint: 1200,
  },
  {
    slug: "fetch-client-cleanup",
    title: "A flag cleanup broke Pay",
    severity: "SEV1",
    opensAt: [16, 3],
    webVersion: "2026.10.08-1",
    briefing:
      "The flash sale started at 16:00. Three minutes later most checkouts are failing, though traffic is back to normal and the payment gateway is only degraded. Nothing was deployed today. You’re the frontend on-call; Priya is on the call.",
    roleBriefing: "You own checkout-web: flags and RUM. Web platform has been deleting old flags this week to pay down tech debt.",
    culprit: {
      key: "web.fetch_client_v2",
      description: "Use the v2 fetch client (backoff, retry budget, Idempotency-Key) for API calls",
      owner: "team-web-platform",
      by: "flag-janitor",
      minutesAgo: 50,
      note: "stale flag: 100% for 180 days, turning off before removal (PLAT-990)",
      breaksWhenOn: false,
    },
    decoy: {
      key: "home.flash_sale_countdown",
      description: "Countdown timer on the home page hero",
      owner: "team-growth",
      by: "lena.ortiz",
      minutesAgo: 4,
      note: "flash sale go-live",
      isOn: true,
    },
    mechanic: {
      kind: "retry-storm",
      chargesPerSecond: 155,
      surgeRps: 520,
      surgeSeconds: 40,
      gatewayStatus: "Partial outage in us-east — merchants should back off and retry (since 15:52)",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx > 50% since the flash sale. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "Check REQ/TAP in RUM before anything else. One tap should be one request." },
      { at: 45, from: "Lena Ortiz · Growth", text: "My countdown banner went live at 15:59. Want it gone?" },
      { at: 90, from: "Priya Shah · Frontend lead (your mentor)", text: "We have a fetch client that backs off and sends Idempotency-Keys. If Pay retries instantly without a key, ask why it isn’t using it." },
      { at: 140, from: "Sam Tan · Eng manager", text: "Platform says their flag janitor turned some ‘stale’ flags off this afternoon. Could one of them matter?" },
      { at: 220, from: "Priya Shah · Frontend lead (your mentor)", text: "Once the retries stop, the gateway queue still has to drain. Give it a couple of minutes." },
    ],
    hints: [
      "Nothing shipped today, but the browser now behaves differently when a payment is slow. Count requests per tap.",
      "A setting that sat unchanged for months can still be load-bearing. Look for one that changed this afternoon.",
      "Here the fix means turning something back on, not off.",
    ],
    solution: [
      { command: "rum overview", why: "About four POST /checkout per Pay tap, and almost no orders." },
      { command: "rum session", why: "Retries fire 2 ms after each timeout with no Idempotency-Key: the legacy fetch wrapper, not the v2 client." },
      { command: "flags list", why: "web.fetch_client_v2 was turned off at 15:13 by the flag janitor." },
      { command: 'flags set web.fetch_client_v2 on --note "legacy fetch wrapper retries instantly; v2 is load-bearing"', why: "Tabs switch back to the v2 client within ~20 s: backoff, a retry budget and an Idempotency-Key." },
      { command: "rum overview", why: "REQ/TAP falls back toward 1.00 and orders return as the gateway queue drains." },
    ],
    postmortem: {
      question: "Why did checkout fail during the flash sale when nothing had been deployed?",
      options: [
        "The countdown banner sent far more shoppers to checkout than it could serve",
        "Turning the ‘stale’ v2 fetch flag off put Pay back on instant retries",
        "The payment gateway went fully down for every merchant at the sale’s start",
        "checkout-api’s database ran out of connections under flash-sale load",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The flag janitor turned web.fetch_client_v2 off at 15:13, and the legacy fetch wrapper it had replaced retries POST /checkout instantly with no Idempotency-Key.",
        why: "The flag had sat at 100% for six months, so it looked stale, but switching it off brought back the old client. When the sale outran the degraded gateway, every timeout became three more checkouts, and the queue never drained after traffic settled. Turning the flag back on restored backoff and a retry budget.",
        tell: "RUM showed four requests per Pay tap with no Idempotency-Key, and the flag list showed web.fetch_client_v2 turned off by the janitor that afternoon.",
      },
    },
    lostCheckoutsPerPoint: 1200,
  },
  {
    slug: "phone-e164-off",
    title: "Shipping labels reject phones",
    severity: "SEV2",
    opensAt: [11, 47],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 11:35, a big share of web checkouts fail with “Something went wrong” at Pay. The apps are fine, the gateway is green and checkout-api hasn’t deployed. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. A teammate tidied up checkout flags this morning.",
    culprit: {
      key: "checkout.phone_e164",
      description: "Normalise the shipping phone number to E.164 before submit",
      owner: "team-checkout-web",
      by: "tom.adeyemi",
      minutesAgo: 12,
      note: "cleanup: looks unused, off before deleting",
      breaksWhenOn: false,
    },
    decoy: {
      key: "checkout.delivery_instructions",
      description: "Free-text delivery instructions under the address",
      owner: "team-checkout-web",
      by: "nina.berg",
      minutesAgo: 16,
      note: "delivery notes GA (FE-2340)",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "server",
      failShare: 0.7,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"shipping-label: phone \\"(415) 555-0134\\" is not E.164"}',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout. Assigned to frontend on-call." },
      { at: 20, from: "Priya Shah · Frontend lead (your mentor)", text: "Start with RUM errors and read the trace in the 500s." },
      { at: 55, from: "Nina Berg · Web engineer", text: "Delivery instructions went GA at 11:31. It’s a new field on the address step, so maybe?" },
      { at: 100, from: "Tom Adeyemi · Web engineer", text: "I switched off a few flags that looked dead this morning. checkout.phone_e164 was one of them." },
      { at: 150, from: "Priya Shah · Frontend lead (your mentor)", text: "A flag that formats a field can look unused right up until it’s gone. Check when it changed against when the errors started." },
      { at: 220, from: "Sam Tan · Eng manager", text: "Most web orders are failing. Where are we?" },
    ],
    hints: [
      "The 500s name one field on the address step and what format it should be in.",
      "Two changes touched the address step this morning. Only one of them changes how that field is sent.",
      "Here the fix means turning something back on, not off.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api answers 500: the shipping-label step rejects phones that aren’t E.164." },
      { command: "flags history checkout.phone_e164", why: "Phone normalisation was turned off at 11:35 as a cleanup, when the errors began." },
      { command: 'flags set checkout.phone_e164 on --note "shipping-label needs E.164 phones"', why: "Tabs format the phone as +14155550134 again within ~20 s." },
      { command: "rum errors", why: "The shipping-label 500s fade out." },
    ],
    postmortem: {
      question: "Why did most web checkouts fail late this morning?",
      options: [
        "The delivery instructions field sent characters the shipping label couldn’t print",
        "The gateway began declining cards whose billing phone didn’t match the bank’s",
        "checkout-api’s shipping-label vendor went down for every merchant this morning",
        "Phone normalisation was switched off, so phones arrived in local format",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout.phone_e164 was turned off at 11:35 as ‘unused’, so the browser sent shipping phones as typed, and checkout-api’s shipping-label step requires E.164.",
        why: "The flag had been on for so long that nobody remembered it did anything. With it off, numbers like (415) 555-0134 reached checkout-api unformatted, the shipping-label call threw, and checkout-api answered 500. Customers who happened to type +1… still got through, which is why not every checkout failed.",
        tell: "RUM’s 500s said the phone was not E.164, starting the minute checkout.phone_e164 went off.",
      },
    },
    lostCheckoutsPerPoint: 180,
  },
  {
    slug: "card-brand-recursion",
    title: "Amex cards freeze checkout",
    severity: "SEV2",
    opensAt: [15, 22],
    webVersion: "2026.10.10-3",
    briefing:
      "Since about 15:10, some web customers say the page locks up as soon as they finish typing their card number. checkout-api is healthy and the apps are fine. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The card form got new brand detection this afternoon.",
    culprit: {
      key: "checkout.card_brand_detect_v2",
      description: "Detect card brand from the first digits and show its logo",
      owner: "team-checkout-web",
      by: "lucia.ferraro",
      minutesAgo: 12,
      note: "brand detection v2 with co-badged cards (FE-2355)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.card_scan_camera",
      description: "Scan a card with the device camera instead of typing it",
      owner: "team-checkout-web",
      by: "lucia.ferraro",
      minutesAgo: 19 * 60,
      note: "card scanning GA (FE-2244)",
      isOn: true,
    },
    mechanic: { kind: "defect", where: "client", failShare: 0.35, message: "Uncaught RangeError: Maximum call stack size exceeded" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "A page locking up is a JavaScript problem. See what RUM’s console has." },
      { at: 50, from: "Maya Okonkwo · Support", text: "Every complaint is an American Express card. Visa customers are fine." },
      { at: 90, from: "Tom Adeyemi · Web engineer", text: "Card scanning is the other new thing on the card form. Should we turn it off?" },
      { at: 130, from: "Priya Shah · Frontend lead (your mentor)", text: "Scanning has been live since yesterday. Find the one change this afternoon that looks at the card number’s first digits." },
      { at: 210, from: "Sam Tan · Eng manager", text: "A third of web card payments are stuck. How long?" },
    ],
    hints: [
      "Only cards from one network fail, and they fail before anything is sent.",
      "The error is the browser giving up on a function that never stops calling itself.",
      "The newest change on the card form is the one that reads the first digits.",
    ],
    solution: [
      { command: "rum errors", why: "A third of Pay taps throw RangeError: Maximum call stack size exceeded." },
      { command: "flags list", why: "card_brand_detect_v2 went on at 15:10; card scanning has been on since yesterday." },
      { command: 'flags set checkout.card_brand_detect_v2 off --note "15-digit Amex numbers recurse forever"', why: "Tabs fall back to the old brand detection within ~20 s." },
      { command: "rum funnel", why: "Taps dying in the browser fall toward zero." },
    ],
    postmortem: {
      question: "Why did American Express customers freeze at the card form?",
      options: [
        "Card scanning misread Amex numbers and locked the field it filled in",
        "The new brand detection recursed forever on 15-digit Amex numbers",
        "The payment gateway stopped accepting Amex for merchants in our region",
        "checkout-api rejected four-digit security codes as invalid input",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout.card_brand_detect_v2, on since 15:10, called itself again on every 15-digit number while looking for a co-badged match, and never hit its base case.",
        why: "Amex numbers are 15 digits; the new detection expected 16 before stopping. The recursion ran until Chrome threw a RangeError, which froze the form before Pay could build the request. The card form itself had been fine since yesterday.",
        tell: "RUM showed RangeError: Maximum call stack size exceeded on a third of Pay taps from 15:10, and support saw only Amex cards fail.",
      },
    },
    lostCheckoutsPerPoint: 130,
  },
  {
    slug: "shipping-estimate-html",
    title: "Shipping estimate shows a crash",
    severity: "SEV2",
    opensAt: [8, 46],
    webVersion: "2026.10.10-1",
    briefing:
      "Since about 08:35, most web customers can’t get past the delivery step: the shipping estimate never appears and Pay stays disabled. checkout-api 5xx is flat and the apps are fine. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The delivery team turned on a new shipping estimate endpoint this morning.",
    culprit: {
      key: "checkout.shipping_estimate_v2",
      description: "Fetch delivery estimates from /api/shipping/v2/estimate",
      owner: "team-delivery-web",
      by: "hana.sato",
      minutesAgo: 11,
      note: "estimate v2 to 100% (DLV-63)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.eco_delivery_option",
      description: "Carbon-neutral delivery choice on the delivery step",
      owner: "team-delivery-web",
      by: "hana.sato",
      minutesAgo: 26,
      note: "eco delivery GA",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "client",
      failShare: 0.8,
      message: "Uncaught (in promise) SyntaxError: Unexpected token '<', \"<!doctype \"... is not valid JSON",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — web checkout loss > 40% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "If Pay stays disabled, something it waits for fails in the browser. RUM errors." },
      { at: 50, from: "Hana Sato · Delivery", text: "Eco delivery went GA at 08:20 and estimate v2 at 08:35. Both are mine. Which do you want off?" },
      { at: 100, from: "Priya Shah · Frontend lead (your mentor)", text: "A JSON parse error on '<' means the page got HTML back, not JSON. Which call is new and might not exist in prod yet?" },
      { at: 160, from: "Maya Okonkwo · Support", text: "Customers stuck on “Estimating delivery…” on web. The app is fine." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "Most of web can’t check out. ETA?" },
    ],
    hints: [
      "Pay waits for the delivery estimate. Find out what comes back when the page asks for it.",
      "A parser choking on '<' is reading a web page, not data.",
      "An address the server doesn’t know often falls through to the site’s own index page.",
    ],
    solution: [
      { command: "rum errors", why: "The estimate call returns HTML (<!doctype …) and JSON.parse throws: /api/shipping/v2/estimate isn’t routed in prod and falls through to the SPA." },
      { command: "flags history checkout.shipping_estimate_v2", why: "Estimate v2 went to 100% at 08:35, when the errors began; eco delivery went on 15 minutes earlier without trouble." },
      { command: 'flags set checkout.shipping_estimate_v2 off --note "v2 endpoint not routed in prod, returns index.html"', why: "Tabs go back to the v1 estimate within ~20 s." },
      { command: "rum funnel", why: "Taps that never sent a request fall toward zero." },
    ],
    postmortem: {
      question: "Why did most web customers get stuck at the delivery step?",
      options: [
        "The eco delivery option sent an unknown carrier code to the estimate service",
        "The carrier’s rate API went down and every estimate failed on its side",
        "checkout-api rejected checkouts without a delivery estimate attached to them",
        "The v2 estimate URL wasn’t routed in prod, so it returned HTML, not JSON",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout.shipping_estimate_v2 pointed the page at /api/shipping/v2/estimate at 08:35, a route prod didn’t have yet, so the CDN served the single-page app’s index.html.",
        why: "Unknown paths fall through to index.html so client-side routing works. The estimate code parsed that HTML as JSON, threw on the first '<', and never set a delivery option, so Pay never enabled. No checkout reached checkout-api, which is why 5xx stayed flat.",
        tell: "RUM showed SyntaxError: Unexpected token '<', \"<!doctype \"... is not valid JSON from 08:35, the minute estimate v2 went to 100%.",
      },
    },
    lostCheckoutsPerPoint: 280,
  },
  {
    slug: "gift-card-split-tender",
    title: "Gift card orders won’t add up",
    severity: "SEV3",
    opensAt: [19, 14],
    webVersion: "2026.10.10-4",
    briefing:
      "Since about 19:00, web customers who pay partly with a gift card get “Something went wrong” at Pay. Card-only orders work and the apps are fine. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The payments team turned on split payments between gift cards and cards today.",
    culprit: {
      key: "checkout.gift_card_split",
      description: "Pay part with a gift card and the rest by card",
      owner: "team-payments-web",
      by: "felix.braun",
      minutesAgo: 14,
      note: "split tender GA for the gift card promo (PAY-412)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.gift_wrap",
      description: "Gift wrap option per item",
      owner: "team-checkout-web",
      by: "tom.adeyemi",
      minutesAgo: 35,
      note: "gift wrap for the holiday preview",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "server",
      failShare: 0.2,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"ledger: tender total 6340 != order total 5840 (cents)"}',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx > 3% on POST /checkout. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Gift card customers can’t finish. They all bought the $5 gift card bonus promo." },
      { at: 60, from: "Tom Adeyemi · Web engineer", text: "Gift wrap is new today and adds to the total. Could that throw the numbers off?" },
      { at: 100, from: "Priya Shah · Frontend lead (your mentor)", text: "Read the ledger’s complaint in the 500. It tells you the two numbers that don’t match; work out which side added the extra." },
      { at: 160, from: "Felix Braun · Payments web", text: "Split tender sends the gift card amount and the card amount. I apply the bonus on the client so the customer sees it." },
      { at: 240, from: "Sam Tan · Eng manager", text: "The promo ends tonight. How long?" },
    ],
    hints: [
      "Only orders with two ways of paying fail. Compare the two totals in the error.",
      "The difference between the totals is the size of a promotion running tonight.",
      "One change today decides how an order is split between two payments.",
    ],
    solution: [
      { command: "rum errors", why: "The ledger rejects tenders that add up to $5.00 more than the order: the bonus is counted twice." },
      { command: "flags list", why: "checkout.gift_card_split went on at 19:00, when the errors began; gift wrap has been on since 18:39." },
      { command: 'flags set checkout.gift_card_split off --note "tenders double-count the $5 bonus"', why: "Tabs go back to gift card or card, not both, within ~20 s." },
      { command: "rum errors", why: "The ledger 500s fade out." },
    ],
    postmortem: {
      question: "Why did orders paid partly by gift card fail?",
      options: [
        "Gift wrap added a charge to the order after the total had already been sent",
        "The gift card service froze cards bought with tonight’s bonus promotion",
        "Split tender counted the $5 bonus twice, so tenders exceeded the total",
        "The payment gateway refused card charges smaller than a set minimum amount",
      ],
      answerIndex: 2,
      explanation: {
        cause: "checkout.gift_card_split, turned on at 19:00, added the $5 promo bonus to the gift card tender on the client while checkout-api had already applied it to the order.",
        why: "checkout-api’s ledger requires tenders to add up to the order total exactly. The bonus showed up on both sides, so every split payment came in $5.00 over and the ledger threw a 500. Card-only and gift-card-only orders never split, so they kept working.",
        tell: "RUM’s 500s showed tender totals exactly 500 cents over the order total, only on split payments, from 19:00.",
      },
    },
    lostCheckoutsPerPoint: 70,
  },
  {
    slug: "locale-price-comma",
    title: "European orders fail at Pay",
    severity: "SEV2",
    opensAt: [7, 18],
    webVersion: "2026.10.10-1",
    briefing:
      "European morning traffic is up, and since about 07:05 a share of web checkouts fail with “Something went wrong”. US customers are fine, the apps are fine, and checkout-api hasn’t deployed. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. Localisation shipped a change to how prices are shown this morning.",
    culprit: {
      key: "checkout.localized_prices",
      description: "Format prices in the shopper’s locale throughout checkout",
      owner: "team-i18n-web",
      by: "marta.nowak",
      minutesAgo: 13,
      note: "locale price formatting to 100% (I18N-88)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.vat_breakdown",
      description: "Show VAT as its own line in the order summary",
      owner: "team-i18n-web",
      by: "marta.nowak",
      minutesAgo: 70,
      note: "VAT line for EU stores",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "server",
      failShare: 0.3,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"pricing: cannot parse expected_total \\"58,40\\""}',
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout. Assigned to frontend on-call." },
      { at: 20, from: "Maya Okonkwo · Support", text: "Complaints from Germany, France and Spain. Not a single US one." },
      { at: 55, from: "Priya Shah · Frontend lead (your mentor)", text: "Start with RUM errors and look at the value checkout-api couldn’t parse." },
      { at: 95, from: "Marta Nowak · i18n", text: "The VAT line went live at 06:08 and price formatting at 07:05. VAT is the bigger change, honestly." },
      { at: 150, from: "Priya Shah · Frontend lead (your mentor)", text: "What a customer sees can be localised; what we send the API can’t. Which change could reach the request?" },
      { at: 220, from: "Sam Tan · Eng manager", text: "Europe is a third of web this hour. Where are we?" },
    ],
    hints: [
      "Only some countries fail. Look at what their failing requests carry.",
      "The value checkout-api couldn’t read is a price written the way half of Europe writes it.",
      "A display change that leaks into the request body would only hurt those locales.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api can’t parse expected_total \"58,40\": a decimal comma." },
      { command: "flags history checkout.localized_prices", why: "Locale formatting went to 100% at 07:05, when the errors began; the VAT line has been on for an hour." },
      { command: 'flags set checkout.localized_prices off --note "expected_total sent with a decimal comma"', why: "Tabs go back to plain prices within ~20 s." },
      { command: "rum overview", why: "HTTP 500 drains to zero." },
    ],
    postmortem: {
      question: "Why did European web checkouts fail this morning?",
      options: [
        "The VAT line changed the order total after checkout-api had quoted it",
        "Locale formatting sent the total with a decimal comma checkout-api can’t read",
        "The gateway declined European cards because of a new strong-authentication rule",
        "checkout-api couldn’t convert euros because the exchange-rate feed was stale",
      ],
      answerIndex: 1,
      explanation: {
        cause: "checkout.localized_prices, at 100% from 07:05, formatted expected_total in the shopper’s locale, and checkout-api’s pricing step only parses a decimal point.",
        why: "The change was meant for display, but the same formatted string was put in the request body. German, French and Spanish locales write 58,40, which checkout-api failed to parse, so it answered 500. English locales write 58.40, so US customers were never affected.",
        tell: "RUM’s 500s quoted expected_total \"58,40\", only from comma-decimal locales, starting at 07:05.",
      },
    },
    lostCheckoutsPerPoint: 100,
  },
  {
    slug: "bot-challenge-blocked",
    title: "Ad blockers can’t pay",
    severity: "SEV2",
    opensAt: [13, 28],
    webVersion: "2026.10.10-2",
    briefing:
      "Since about 13:15, a chunk of web customers say Pay just spins and nothing happens. checkout-api 5xx is flat and the apps are fine. Security asked for a bot challenge on checkout after last week’s card testing. You’re the frontend on-call.",
    roleBriefing: "You own checkout-web: flags and RUM. The bot challenge went live on the Pay step today, behind a flag.",
    culprit: {
      key: "checkout.bot_challenge",
      description: "Require an EdgeGuard challenge token on POST /checkout",
      owner: "team-checkout-web",
      by: "zoe.lambert",
      minutesAgo: 13,
      note: "EdgeGuard challenge on Pay, 100% (SEC-415)",
      breaksWhenOn: true,
    },
    decoy: {
      key: "checkout.save_card_default",
      description: "Tick “save this card” by default",
      owner: "team-wallet-web",
      by: "omar.haddad",
      minutesAgo: 9,
      note: "default on for returning customers",
      isOn: true,
    },
    mechanic: {
      kind: "defect",
      where: "client",
      failShare: 0.3,
      message: "GET https://challenge.edgeguard.example/v1/api.js net::ERR_BLOCKED_BY_CLIENT",
    },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — web checkout loss > 10% for 5m. checkout-api 5xx 0.0%. Assigned to frontend on-call." },
      { at: 15, from: "Priya Shah · Frontend lead (your mentor)", text: "Look at RUM errors. A spinner with no request usually means the page is waiting on something that never loaded." },
      { at: 50, from: "Maya Okonkwo · Support", text: "One customer says it works if she turns her ad blocker off." },
      { at: 85, from: "Omar Haddad · Wallet", text: "I made “save this card” default at 13:19. It’s right above Pay, could that be it?" },
      { at: 130, from: "Zoe Lambert · Web engineer", text: "The bot challenge loads EdgeGuard’s script, then Pay waits for a token. There’s no fallback if the script never arrives." },
      { at: 210, from: "Sam Tan · Eng manager", text: "Security wants the challenge to stay, but not at the cost of a third of web. Your call." },
    ],
    hints: [
      "Only some browsers fail, and support has a clue about which.",
      "The browser itself refused to load a script the Pay step needs.",
      "A third-party script that extensions block can’t sit in front of Pay without a fallback.",
    ],
    solution: [
      { command: "rum errors", why: "Chrome blocks EdgeGuard’s api.js with ERR_BLOCKED_BY_CLIENT: an extension, not the network." },
      { command: "rum funnel", why: "About three in ten Pay taps die in the browser, waiting for a challenge token that never comes." },
      { command: 'flags set checkout.bot_challenge off --note "challenge script blocked by ad blockers, no fallback"', why: "Tabs stop waiting for the token within ~20 s; Pay sends POST /checkout again." },
      { command: "rum funnel", why: "DIED IN BROWSER falls toward zero." },
    ],
    postmortem: {
      question: "Why did Pay spin forever for some web customers?",
      options: [
        "Ticking “save this card” by default made Pay wait for a vault confirmation",
        "EdgeGuard’s challenge service went down, so every token request timed out",
        "checkout-api rejected checkouts whose challenge token had already been used",
        "Ad blockers blocked the challenge script, so Pay waited for a token",
      ],
      answerIndex: 3,
      explanation: {
        cause: "checkout.bot_challenge, on since 13:15, made Pay wait for a token from EdgeGuard’s script, and content blockers refuse to load that script.",
        why: "ERR_BLOCKED_BY_CLIENT is Chrome reporting that an extension cancelled the request. About three in ten customers run one that lists challenge.edgeguard.example, so the script never ran, no token arrived, and Pay waited forever without sending anything. Everyone else got a token and paid.",
        tell: "RUM showed api.js failing with net::ERR_BLOCKED_BY_CLIENT from 13:15, and the funnel showed those taps dying in the browser.",
      },
    },
    lostCheckoutsPerPoint: 110,
  },
];

export const FRONTEND_TIER1_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
