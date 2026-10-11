import type { Role } from "../../domain/incident.ts";
import type { CommsMessage, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { triggerShare } from "../sim/clients.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { findFlag, findPlatform, isFlagOn, type DefectTrigger, type FeatureFlag } from "../sim/commerce.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const MINUTE = 60;
const ROLE: Role = "frontend";

/** A flag flipped shortly before the page; `to` is where it stands now. */
type FlagFlip = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  readonly minutesAgo: number;
  readonly to: boolean;
  readonly note: string;
};

/** One slice of web Pay taps in the incident's RUM breakdown; failing slices together are the defect's reach. */
type Bucket = { readonly label: string; readonly share: number; readonly isFailing?: true };

/**
 * A tier-2 frontend incident: several flags changed this hour, one of them (the culprit) breaks a
 * slice of web checkouts, and a RUM breakdown plus the error text single it out.
 */
type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly briefing: string;
  readonly roleBriefing: string;
  /** `to` is the state that breaks checkout; the fix flips it back. */
  readonly culprit: FlagFlip;
  readonly decoys: readonly FlagFlip[];
  /** "server": checkout-api answers 500. "client": checkout dies in the browser, so the pager watches checkout loss. */
  readonly where: "server" | "client";
  readonly message: string;
  readonly view: { readonly name: string; readonly description: string; readonly dimension: string; readonly buckets: readonly Bucket[] };
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function asFlag(flip: FlagFlip): FeatureFlag {
  return {
    key: flip.key,
    description: flip.description,
    owner: flip.owner,
    history: [{ at: -flip.minutesAgo * MINUTE, by: flip.by, from: !flip.to, to: flip.to, note: flip.note }],
  };
}

function failShare(row: Row): number {
  return row.view.buckets.reduce((sum, bucket) => sum + (bucket.isFailing ? bucket.share : 0), 0);
}

function pageText(row: Row): string {
  return row.where === "server"
    ? `${row.severity} triggered — checkout-api 5xx > 2% on POST /checkout for 5m. Assigned to frontend on-call.`
    : `${row.severity} triggered — checkout loss > 5% for 3m; checkout-api 5xx 0.0%. Assigned to frontend on-call.`;
}

function incident(row: Row): Scenario {
  const id = `fe-t2-${row.slug}`;
  const trigger: DefectTrigger = { flag: row.culprit.key, failsWhenOn: row.culprit.to };
  const share = failShare(row);
  const firstDecoy = row.decoys[0];
  const breakdown = (state: Parameters<Scenario["isRootCauseFixed"]>[0]): readonly string[] => {
    const commerce = state.commerce;
    if (!commerce) return [];
    const firing = triggerShare(trigger, commerce, state.t);
    const webTaps = commerce.pulse.organicCheckoutsPerSecond * (findPlatform(commerce, "web")?.customerShare ?? 0) * WINDOW_SECONDS;
    const rows = row.view.buckets.map((bucket) => {
      const failed = bucket.isFailing ? firing : 0;
      const taps = webTaps * bucket.share;
      return [bucket.label, percent(bucket.share, 0), count(taps), percent(failed), count(taps * (1 - failed))];
    });
    return [`checkout-web · ${row.view.description} · last 5 min`, ...table([[row.view.dimension, "SESSIONS", "PAY TAPS", "FAILED", "ORDERS OK"], ...rows])];
  };
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
      [ROLE]: ["rum overview", "rum errors", `rum ${row.view.name}`, "flags list", `flags history ${firstDecoy.key}`, `flags set ${firstDecoy.key} ${firstDecoy.to ? "off" : "on"}`],
    },
    evidence: [{ tool: "rum", name: row.view.name, description: row.view.description, run: breakdown }],
    opensAtSecondOfDay: row.opensAt[0] * 3600 + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
        revision: 6,
        commerce: checkoutCommerce({
          platforms: {
            web: {
              current: {
                version: "2026.10.10-1",
                userAgent: WEB_USER_AGENT,
                timeoutMs: 8000,
                retry: NO_RETRY,
                defects: [{ trigger, failShare: share, where: row.where, message: row.message }],
              },
            },
          },
          flags: [asFlag(row.culprit), ...row.decoys.map(asFlag), ...SHOP_FLAGS],
        }),
      }),
    isRootCauseFixed: (state) => {
      const flag = state.commerce && findFlag(state.commerce, row.culprit.key);
      return !!flag && isFlagOn(flag) !== row.culprit.to;
    },
    ...(row.where === "client"
      ? { alertMetric: { label: "checkout loss", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) } }
      : {}),
    // The fix lands ~45 s in and takes ~20 s to reach every tab: roughly 3,400 × reach checkouts lost, about a dozen points.
    lostCheckoutsPerPoint: Math.max(50, Math.round(share * 300)),
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
    comms: [{ at: 0, from: "PagerDuty", text: pageText(row) }, ...row.comms],
    hints: row.hints,
    solution: { [ROLE]: row.solution },
    postmortem: row.postmortem,
  };
}

const ROWS: readonly Row[] = [
  {
    slug: "named-day-delivery",
    title: "Named-day delivery won’t pay",
    severity: "SEV2",
    opensAt: [11, 26],
    briefing:
      "Since just after 11:00, almost half of web checkouts fail with “Something went wrong” at Pay. The apps are fine, the gateway is green and checkout-api hasn’t deployed today. Three flags changed on checkout-web this hour.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Nothing was deployed, but flags were flipped. Find which change broke checkout before you touch anything.",
    culprit: {
      key: "checkout.delivery_date_picker",
      description: "Let customers choose a named delivery day on the shipping step",
      owner: "team-checkout-web",
      by: "kofi.mensah",
      minutesAgo: 23,
      to: true,
      note: "named-day delivery, 100% (FE-2344)",
    },
    decoys: [
      { key: "cart.recently_viewed", description: "Recently viewed products strip in the cart", owner: "team-growth", by: "lena.ortiz", minutesAgo: 8, to: true, note: "recently viewed strip (GRW-412)" },
      { key: "checkout.order_notes", description: "Free-text order notes box on the review step", owner: "team-checkout-web", by: "hana.sato", minutesAgo: 52, to: true, note: "order notes GA (FE-2329)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"fulfilment-slots: delivery_date \\"2026-10-14T22:00:00.000Z\\" is not a calendar date (want YYYY-MM-DD)"}',
    view: {
      name: "delivery-choice",
      description: "Pay taps by delivery choice",
      dimension: "DELIVERY",
      buckets: [
        { label: "Standard (no date)", share: 0.55 },
        { label: "Named day", share: 0.45, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Since just after 11:00, web customers get “Something went wrong” at Pay. Not all of them, and app customers are fine." },
      { at: 50, from: "Lena Ortiz · Growth", text: "The recently viewed strip went into the cart at 11:18. Want me to pull it?" },
      { at: 95, from: "Hana Sato · Web engineer", text: "Order notes have been on since 10:34 and the note goes straight into checkout-api. Could a long note break it?" },
      { at: 150, from: "Kofi Mensah · Web engineer", text: "Named-day delivery went to everyone at 11:03. It worked in staging, but staging runs on UTC." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "A quarter of all checkouts failing since 11:00. Where are we?" },
    ],
    hints: [
      "Some web customers pay fine. Split the failures by what they chose on the way to Pay.",
      "Three changes went out this hour; only one went live when the errors began.",
      "The error says what shape a value should have. Ask what fills that value in.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api answers 500 because delivery_date arrives as a full timestamp instead of a calendar date." },
      { command: "rum delivery-choice", why: "Every failure picked a named day; standard delivery is clean." },
      { command: "flags history checkout.delivery_date_picker", why: "Named-day delivery went to 100% at 11:03, when the errors began." },
      { command: 'flags set checkout.delivery_date_picker off --note "named-day dates 500 at fulfilment-slots"', why: "Customers get standard delivery; open tabs pick it up within ~20 s." },
      { command: "rum delivery-choice", why: "Named-day sessions stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "What broke web checkout late this morning?",
      options: [
        "A long order note overflowed a column in checkout-api",
        "The named-day picker sent a timestamp where a date belonged",
        "The recently viewed strip slowed the cart until requests failed",
        "The gateway rejected orders scheduled more than a week out",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Named-day delivery, on for everyone at 11:03, sent the chosen day as a UTC timestamp.",
        why: "fulfilment-slots wants a plain YYYY-MM-DD date. The picker sent the chosen day as a full ISO timestamp, so checkout-api failed the slot lookup and answered 500. Customers on standard delivery never sent a date, which is why only part of web checkout failed. Order notes and the recently viewed strip don’t touch delivery.",
        tell: "RUM put every failure on named-day sessions, and the 500s quoted a timestamp in delivery_date from 11:03, when the picker went to 100%.",
      },
    },
  },
  {
    slug: "promo-code-autoformat",
    title: "Sale codes stopped working",
    severity: "SEV2",
    opensAt: [16, 12],
    briefing:
      "It’s the Autumn Sale. Since about 15:55, web customers who type a promo code get “Something went wrong” at Pay; everyone else checks out. checkout-api and the promotions service haven’t deployed. Several flags changed on checkout-web this afternoon.",
    roleBriefing: "You own checkout-web: flags and RUM. The sale banner, the cart and the promo field all changed today. Work out which change breaks code orders before you switch anything off.",
    culprit: {
      key: "checkout.promo_autoformat",
      description: "Format promo codes in blocks of four as the customer types",
      owner: "team-checkout-web",
      by: "ines.duarte",
      minutesAgo: 18,
      to: true,
      note: "format promo codes as you type (FE-2350)",
    },
    decoys: [
      { key: "cart.free_shipping_bar", description: "Progress bar towards free shipping in the cart", owner: "team-growth", by: "omar.haddad", minutesAgo: 31, to: true, note: "free-shipping progress bar (GRW-420)" },
      { key: "checkout.promo_hint_text", description: "“Have a code?” hint under the order total", owner: "team-checkout-web", by: "ines.duarte", minutesAgo: 26, to: true, note: "promo hint text (FE-2349)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"promotions: code \\"AUTU MN20\\" contains whitespace; codes match [A-Z0-9-]+"}',
    view: {
      name: "promo-entry",
      description: "Pay taps by how a promo code got into the order",
      dimension: "PROMO CODE",
      buckets: [
        { label: "No code", share: 0.62 },
        { label: "Typed into the field", share: 0.22, isFailing: true },
        { label: "Applied from banner link", share: 0.16 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Web customers using the Autumn Sale code get “Something went wrong” at Pay. People without a code are fine." },
      { at: 60, from: "Omar Haddad · Growth", text: "The free-shipping bar went live at 15:41. It reads the cart total; could it be fighting the discount?" },
      { at: 110, from: "Lena Ortiz · Growth", text: "The sale banner went live at 16:05. Clicking it applies the code for you. Should I pull the banner?" },
      { at: 170, from: "Ines Duarte · Web engineer", text: "I shipped two promo-field tweaks this afternoon: the hint text at 15:46, and formatting codes as people type at 15:54." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Sale day, and the sale codes don’t work. What’s the ETA?" },
    ],
    hints: [
      "Not every discounted order fails. Compare how the code got into the order.",
      "Two changes touch the promo field. Only one changes what the customer’s code looks like.",
      "Read the code exactly as checkout-api received it.",
    ],
    solution: [
      { command: "rum errors", why: "checkout-api answers 500 because the code arrives as “AUTU MN20”, with a space in it." },
      { command: "rum promo-entry", why: "Only typed codes fail; codes applied from the banner link skip the field and go through." },
      { command: "flags history checkout.promo_autoformat", why: "Formatting went live at 15:54, just before the first failures." },
      { command: 'flags set checkout.promo_autoformat off --note "formatted codes 500 at promotions"', why: "The field sends codes as typed; open tabs pick it up within ~20 s." },
      { command: "rum promo-entry", why: "Typed codes stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did promo-code checkouts fail on web?",
      options: [
        "The sale banner applied a code that had already expired",
        "Formatting codes as typed put a space promotions rejects",
        "The free-shipping bar double-counted the discount on the cart",
        "The promo hint text pushed the Pay button off small screens",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Promo autoformat, on at 15:54, split typed codes into blocks with a space between them.",
        why: "Promotions only accepts codes made of letters, digits and dashes. Formatting turned AUTUMN20 into “AUTU MN20”, and checkout-api’s promotion lookup threw, answering 500. Codes applied by the banner link never pass through the field, so they kept working, which clears the banner. The hint text changes nothing that is sent.",
        tell: "RUM showed failures only on typed codes, and the 500s quoted the code with a space in it.",
      },
    },
  },
  {
    slug: "guest-session-samesite",
    title: "Guests can’t check out",
    severity: "SEV2",
    opensAt: [9, 48],
    briefing:
      "Since about 09:20, guest checkouts on web fail with “Something went wrong” at Pay. Customers who are signed in check out fine, and the apps are untouched. Nothing has deployed today, but identity and checkout-web both flipped flags this morning.",
    roleBriefing: "You own checkout-web: flags and RUM. Account and guest-form flags changed this morning. Find which one strands guest checkouts before you touch anything.",
    culprit: {
      key: "auth.sid_samesite_strict",
      description: "Set SameSite=Strict on the __Host-marlow_sid session cookie",
      owner: "team-identity",
      by: "raj.patel",
      minutesAgo: 27,
      to: true,
      note: "SameSite=Strict on the session cookie (SEC-188)",
    },
    decoys: [
      { key: "checkout.guest_newsletter_optin", description: "Newsletter opt-in checkbox on the guest details form", owner: "team-checkout-web", by: "hana.sato", minutesAgo: 14, to: true, note: "guest newsletter opt-in (FE-2356)" },
      { key: "account.social_login", description: "Sign in with Google or Apple on web", owner: "team-identity", by: "mei.lin", minutesAgo: 40, to: true, note: "social login on web (ID-77)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"carts: guest cart gc_7d21 is not owned by the requesting session"}',
    view: {
      name: "checkout-type",
      description: "Pay taps by customer type",
      dimension: "CUSTOMER",
      buckets: [
        { label: "Signed in", share: 0.58 },
        { label: "Guest", share: 0.42, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Guests can’t pay on web: “Something went wrong”. Customers who sign in first get through." },
      { at: 55, from: "Hana Sato · Web engineer", text: "I put a newsletter opt-in on the guest form at 09:34. It’s just a checkbox, but it’s on exactly that form." },
      { at: 100, from: "Mei Lin · Identity", text: "Social login went live at 09:08. Guests now see the Google and Apple buttons; could that be mixing up sessions?" },
      { at: 160, from: "Raj Patel · Identity", text: "Security asked for SameSite=Strict on the session cookie. I flipped it at 09:21 behind a flag; it should be invisible to customers." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Every guest on web is failing. Where are we?" },
    ],
    hints: [
      "Some customers are fine. Find what the failing ones are missing.",
      "Three changes touch accounts or the guest form; only one changed what the browser sends with each request.",
      "A cart that isn’t owned by the session means checkout-api didn’t recognise who was asking.",
    ],
    solution: [
      { command: "rum errors", why: "The 500s say the guest cart isn’t owned by the session: the session cookie checkout-api expected never came with it." },
      { command: "rum checkout-type", why: "Every failure is a guest; signed-in customers check out fine." },
      { command: "flags history auth.sid_samesite_strict", why: "SameSite=Strict went live at 09:21. Strict cookies aren’t sent when a guest arrives from an ad or an email link." },
      { command: 'flags set auth.sid_samesite_strict off --note "Strict sid orphans guest carts"', why: "Guests keep their session again; open tabs pick it up within ~20 s." },
      { command: "rum checkout-type", why: "Guest checkouts recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did guest checkouts fail on web?",
      options: [
        "The newsletter checkbox sent a field checkout-api didn’t expect",
        "Strict session cookies were not sent when guests arrived",
        "Social login buttons signed guests into empty accounts at Pay",
        "Guest carts expired early under the morning traffic peak",
      ],
      answerIndex: 1,
      explanation: {
        cause: "SameSite=Strict on the session cookie, on at 09:21, split guests from their carts.",
        why: "Browsers don’t send a Strict cookie on the first request from another site, so guests arriving from ads and emails got a fresh session that didn’t own their cart. checkout-api couldn’t match the cart and answered 500. Signed-in customers are recognised by their account, so they got through. The checkbox and social login don’t touch it.",
        tell: "RUM put every failure on guests, and the 500s said the cart wasn’t owned by the session, from 09:21 when the cookie flag flipped.",
      },
    },
  },
  {
    slug: "card-form-locale-chunk",
    title: "The card form spins in Europe",
    severity: "SEV2",
    opensAt: [14, 5],
    briefing:
      "Since about 13:45, customers in Germany, France and Spain see the card form spin forever on web. checkout-api reports nothing wrong; it just isn’t getting their orders. The CDN and checkout-web both changed flags this afternoon.",
    roleBriefing: "You own checkout-web: flags and RUM. The CDN team, the cart and the card form all flipped flags in the last hour. Find the one that stops European customers before you roll anything back.",
    culprit: {
      key: "checkout.localized_card_form",
      description: "Show the card form in the shopper's language, loading strings on demand",
      owner: "team-checkout-web",
      by: "sofia.lindqvist",
      minutesAgo: 22,
      to: true,
      note: "localized card form, 100% (FE-2361)",
    },
    decoys: [
      { key: "web.cdn_brotli", description: "Serve JS and CSS with Brotli compression from the CDN", owner: "team-web-platform", by: "arjun.nair", minutesAgo: 35, to: true, note: "Brotli for static assets (WEB-512)" },
      { key: "checkout.price_per_unit", description: "Unit price under each cart line", owner: "team-checkout-web", by: "tom.adeyemi", minutesAgo: 9, to: true, note: "unit prices in the cart (FE-2363)" },
    ],
    where: "client",
    message: "Uncaught (in promise) ChunkLoadError: Loading chunk 812 failed. (missing: https://static.marlow.example/assets/812.4f1c2a.js)",
    view: {
      name: "locale",
      description: "Pay taps by browser language",
      dimension: "LANGUAGE",
      buckets: [
        { label: "en-US", share: 0.52 },
        { label: "en-GB", share: 0.23 },
        { label: "de-DE", share: 0.1, isFailing: true },
        { label: "fr-FR", share: 0.08, isFailing: true },
        { label: "es-ES", share: 0.07, isFailing: true },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers in Germany, France and Spain say the card form just spins on the website. UK and US customers are fine." },
      { at: 60, from: "Arjun Nair · Web platform", text: "We switched the CDN to Brotli at 13:30. If a browser choked on it, scripts would fail to load. I can roll it back." },
      { at: 120, from: "Sofia Lindqvist · Web engineer", text: "The localized card form went to everyone at 13:43. It loads each language’s strings when the form opens." },
      { at: 180, from: "Sam Tan · Eng manager", text: "checkout-api is clean: no 500s. It simply isn’t getting orders from part of Europe." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "We’ve lost most of continental Europe for twenty minutes. ETA?" },
    ],
    hints: [
      "checkout-api sees nothing wrong. Look at what the browser itself reports.",
      "Only some languages fail. A compression problem wouldn’t care which language a customer reads.",
      "A file the page asks for isn’t there. Ask what started asking for it.",
    ],
    solution: [
      { command: "rum errors", why: "Browsers report a chunk that fails to load, so the card form never renders." },
      { command: "rum locale", why: "Only German, French and Spanish sessions fail; English is clean, so it isn’t the CDN." },
      { command: "flags history checkout.localized_card_form", why: "The localized card form went live at 13:43; it loads a language chunk the build never uploaded." },
      { command: 'flags set checkout.localized_card_form off --note "missing locale chunk blocks the card form"', why: "Everyone gets the English card form; open tabs pick it up within ~20 s." },
      { command: "rum locale", why: "European sessions stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why couldn’t some European customers pay on web?",
      options: [
        "Brotli-compressed scripts failed to decode in older browsers",
        "The card form fetched a language file the build lacked",
        "The unit price line broke the cart layout on small screens",
        "The payment gateway blocked cards issued in the eurozone",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The localized card form, on at 13:43, imported language chunks that were never deployed.",
        why: "With the flag on, the card form loads its strings for the shopper’s language. The German, French and Spanish chunks were missing from the build, so the import failed and the form spun forever. English needs no extra chunk, which clears Brotli: a compression fault would hit every language alike.",
        tell: "RUM’s top error was a ChunkLoadError, and only de, fr and es sessions failed, from 13:43 when the flag went to 100%.",
      },
    },
  },
  {
    slug: "csp-enforced-fingerprint",
    title: "Pay stays grey for cards",
    severity: "SEV1",
    opensAt: [10, 40],
    briefing:
      "Since about 10:25, card customers on web say the Pay button never turns on. Apple Pay, Google Pay and PayPal work. checkout-api shows no errors. Security, growth and checkout-web all changed flags this morning.",
    roleBriefing:
      "You own checkout-web: flags and RUM. checkout-web sets its Content Security Policy from a flag, alongside the consent banner and the card form flags. Find which change keeps Pay disabled before you touch anything.",
    culprit: {
      key: "web.csp_enforce",
      description: "Enforce the Content Security Policy instead of report-only",
      owner: "team-web-platform",
      by: "nadia.karim",
      minutesAgo: 16,
      to: true,
      note: "CSP report-only → enforced (SEC-201)",
    },
    decoys: [
      { key: "growth.consent_banner_v3", description: "New cookie consent banner; third-party tags wait for consent", owner: "team-growth", by: "omar.haddad", minutesAgo: 29, to: true, note: "consent banner v3 (GRW-431)" },
      { key: "checkout.saved_cards_carousel", description: "Show saved cards as a carousel above the card form", owner: "team-checkout-web", by: "priya.shah", minutesAgo: 7, to: true, note: "saved cards carousel (FE-2366)" },
    ],
    where: "client",
    message:
      "Refused to load the script 'https://cdn.sentinelrisk.example/fp/v3.js' because it violates the following Content Security Policy directive: \"script-src 'self' https://static.marlow.example\". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback.",
    view: {
      name: "payment-method",
      description: "Pay taps by payment method",
      dimension: "METHOD",
      buckets: [
        { label: "Card", share: 0.55, isFailing: true },
        { label: "Apple Pay / Google Pay", share: 0.3 },
        { label: "PayPal", share: 0.15 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Card customers on web say the Pay button stays grey. Apple Pay works." },
      { at: 60, from: "Omar Haddad · Growth", text: "The new consent banner went live at 10:11. It holds third-party scripts until people accept. That has to be it?" },
      { at: 110, from: "Priya Shah · Web engineer", text: "The saved cards carousel went on at 10:33. It only shows to signed-in customers with saved cards." },
      { at: 170, from: "Nadia Karim · Web platform", text: "We moved the CSP from report-only to enforced at 10:24 after a week of clean reports. Clean on the main site, anyway." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "A quarter of all checkouts on the floor. What are we doing?" },
    ],
    hints: [
      "Some payment methods work. Find what the failing one needs that the others don’t.",
      "The browser says exactly what it refused, and why.",
      "A consent banner waits for a click; a policy refuses without asking.",
    ],
    solution: [
      { command: "rum errors", why: "The browser refuses the fraud fingerprint script under the CSP; card payments wait for it, so Pay never enables." },
      { command: "rum payment-method", why: "Only card payments fail; wallets and PayPal don’t load that script." },
      { command: "flags history web.csp_enforce", why: "The CSP went from report-only to enforced at 10:24, and the fingerprint host isn’t in script-src." },
      { command: 'flags set web.csp_enforce off --note "enforced CSP blocks the fraud fingerprint script"', why: "Back to report-only; open tabs pick it up within ~20 s." },
      { command: "rum payment-method", why: "Card payments recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did card payments stop on web?",
      options: [
        "The consent banner held the card form’s scripts until accepted",
        "Enforced CSP refused the fraud script card payments wait for",
        "The saved cards carousel hid the Pay button for new cards",
        "The fraud vendor’s script host went down this morning",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Enforcing the CSP at 10:24 blocked the fraud fingerprint script card payments wait for.",
        why: "Report-only mode had flagged the fingerprint host for a week without blocking it, and nobody allowed it. Once enforced, the browser refused the script, and the card form keeps Pay disabled until it has a fingerprint. Wallets and PayPal don’t use it, so they kept working. The consent banner waits for a click; it never refuses a script.",
        tell: "RUM’s top error was the browser’s CSP refusal naming the fingerprint script, and only card payments failed, from 10:24.",
      },
    },
  },
  {
    slug: "cart-snapshot-quota",
    title: "Big baskets can’t check out",
    severity: "SEV2",
    opensAt: [20, 15],
    briefing:
      "Since about 19:40, web customers with big baskets can’t get to payment; small orders go through. checkout-api 5xx is flat and the apps are fine. Growth and checkout-web both changed cart flags this evening.",
    roleBriefing: "You own checkout-web: flags and RUM. Three cart changes went out this evening. Find the one that stops big baskets before you switch anything off.",
    culprit: {
      key: "cart.offline_snapshot",
      description: "Keep a full cart snapshot in localStorage so checkout survives a dropped connection",
      owner: "team-checkout-web",
      by: "leo.fischer",
      minutesAgo: 34,
      to: true,
      note: "offline cart snapshot (FE-2370)",
    },
    decoys: [
      { key: "cart.bundle_suggestions", description: "“Complete the look” bundles in the cart", owner: "team-growth", by: "omar.haddad", minutesAgo: 12, to: true, note: "cart bundles (GRW-438)" },
      { key: "checkout.order_summary_collapsible", description: "Collapsible order summary on checkout", owner: "team-checkout-web", by: "hana.sato", minutesAgo: 48, to: true, note: "collapsible summary (FE-2368)" },
    ],
    where: "client",
    message: "Uncaught DOMException: Failed to execute 'setItem' on 'Storage': Setting the value of 'marlow:cart-snapshot' exceeded the quota.",
    view: {
      name: "cart-size",
      description: "Pay taps by items in the cart",
      dimension: "CART SIZE",
      buckets: [
        { label: "1–2 items", share: 0.55 },
        { label: "3–5 items", share: 0.25 },
        { label: "6+ items", share: 0.2, isFailing: true },
      ],
    },
    comms: [
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers with big baskets can’t get to payment on web. Small orders go through." },
      { at: 70, from: "Omar Haddad · Growth", text: "Bundles went into the cart at 20:03. More items per cart means bigger carts, right? Should I pull it?" },
      { at: 130, from: "Leo Fischer · Web engineer", text: "Offline cart snapshots went live at 19:41. They keep product data in localStorage so checkout survives a dropped connection." },
      { at: 190, from: "Sam Tan · Eng manager", text: "checkout-api 5xx is flat. Whatever stops them happens in the browser." },
      { at: 260, from: "Elena Ruiz · VP Engineering", text: "Our biggest orders are the ones failing. Where are we?" },
    ],
    hints: [
      "Small baskets go through. Find where a big basket hits a limit.",
      "Bundles make baskets bigger, but big baskets checked out fine yesterday.",
      "The browser names the storage key it couldn’t write.",
    ],
    solution: [
      { command: "rum errors", why: "Browsers throw a quota error writing the cart snapshot to localStorage, before checkout starts." },
      { command: "rum cart-size", why: "Only carts with six or more items fail; their snapshot outgrows the browser’s storage quota." },
      { command: "flags history cart.offline_snapshot", why: "Snapshots went live at 19:41, when the big-basket complaints began." },
      { command: 'flags set cart.offline_snapshot off --note "cart snapshot exceeds localStorage quota"', why: "Checkout stops writing the snapshot; open tabs pick it up within ~20 s." },
      { command: "rum cart-size", why: "Big baskets stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why couldn’t big baskets check out on web tonight?",
      options: [
        "Bundle suggestions added items checkout-api refused to price",
        "The cart snapshot overflowed the browser’s storage quota",
        "The collapsible summary hid the Pay button on long carts",
        "checkout-api capped orders at five line items",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The offline cart snapshot, on at 19:41, outgrew localStorage on carts of six-plus items.",
        why: "The snapshot stores product data, images included, for every line. Past about six items it exceeds the browser’s storage quota, setItem throws, and checkout never starts. Small carts fit. Bundles came later and only add items; big baskets checked out fine before the snapshot existed.",
        tell: "RUM’s top error was the browser’s quota error naming marlow:cart-snapshot, and only carts of six or more items failed.",
      },
    },
  },
  {
    slug: "vat-field-cleanup",
    title: "Business orders fail after a cleanup",
    severity: "SEV2",
    opensAt: [15, 30],
    briefing:
      "Since about 15:10, business customers on web get “Something went wrong” at Pay. Personal accounts and the apps are fine. Nobody has deployed; an engineer cleaned up old flags this afternoon and identity shipped a new address book.",
    roleBriefing: "You own checkout-web: flags and RUM. Flags were switched off as well as on today. Find which change broke business checkouts before you change anything.",
    culprit: {
      key: "checkout.business_vat_field",
      description: "VAT number field on the billing step for business accounts",
      owner: "team-checkout-web",
      by: "dmitri.volkov",
      minutesAgo: 19,
      to: false,
      note: "flag cleanup: VAT field long since GA (FE-2374)",
    },
    decoys: [
      { key: "checkout.legacy_paypal_button", description: "Old PayPal button under the card form", owner: "team-checkout-web", by: "dmitri.volkov", minutesAgo: 20, to: false, note: "flag cleanup: old PayPal button (FE-2374)" },
      { key: "account.address_book_v2", description: "Address book v2 on account and checkout pages", owner: "team-identity", by: "mei.lin", minutesAgo: 42, to: true, note: "address book v2 (ID-81)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"invoicing: business account acct_b2b_4471 requires vat_id; none sent"}',
    view: {
      name: "account-type",
      description: "Pay taps by account type",
      dimension: "ACCOUNT",
      buckets: [
        { label: "Personal", share: 0.82 },
        { label: "Business", share: 0.18, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Business customers on web get “Something went wrong” at Pay. Our biggest wholesale buyer is on the phone." },
      { at: 60, from: "Dmitri Volkov · Web engineer", text: "I switched off two old flags at 15:10 so we can delete their code. Both features have been on for months." },
      { at: 110, from: "Mei Lin · Identity", text: "Address book v2 went live at 14:48. Business accounts have far more saved addresses; maybe that’s it?" },
      { at: 170, from: "Sam Tan · Eng manager", text: "Backend says every checkout-api 500 this hour is a business account." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Wholesale is a third of revenue. Where are we?" },
    ],
    hints: [
      "Only one kind of customer fails. What do they send that the others don’t?",
      "A cleanup can remove more than dead code. Check what each switched-off flag actually showed.",
      "The error names a field the form no longer sends.",
    ],
    solution: [
      { command: "rum errors", why: "The 500s say a business account sent no vat_id." },
      { command: "rum account-type", why: "Only business accounts fail; personal checkouts are clean." },
      { command: "flags history checkout.business_vat_field", why: "Switched off at 15:11 in a cleanup, and the VAT field vanished from the form with it." },
      { command: 'flags set checkout.business_vat_field on --note "business checkouts need vat_id"', why: "The VAT field comes back; open tabs pick it up within ~20 s." },
      { command: "rum account-type", why: "Business checkouts recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "What broke business checkouts on web?",
      options: [
        "Removing the old PayPal button broke the payment step",
        "Turning off the VAT flag dropped a field invoicing needs",
        "Address book v2 sent business addresses in a different format",
        "Invoicing ran out of numbers for this month’s invoices",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A flag cleanup at 15:11 switched off the VAT field, which business checkouts still need.",
        why: "Switching a long-GA flag off doesn’t delete dead code; it brings back the path without the feature. With the VAT field gone, business accounts sent no vat_id, invoicing refused and checkout-api answered 500. Personal accounts never send one. The old PayPal button really was unused, and the address book doesn’t touch VAT.",
        tell: "RUM put every failure on business accounts, and the 500s named a missing vat_id from 15:11, when the cleanup switched the field off.",
      },
    },
  },
  {
    slug: "browser-totals-float",
    title: "Sale items won’t check out",
    severity: "SEV2",
    opensAt: [12, 50],
    briefing:
      "Since about 12:25, web customers buying discounted items get “Something went wrong” at Pay; full-price orders work. checkout-api hasn’t deployed. Growth turned on the sale this lunchtime and checkout-web changed flags too.",
    roleBriefing: "You own checkout-web: flags and RUM. Sale badges, the sale banner, a shipping upsell and a checkout change all went out this hour. Find the one that fails sale orders before you pull anything.",
    culprit: {
      key: "checkout.client_totals",
      description: "Compute order totals in the browser instead of fetching a quote",
      owner: "team-checkout-web",
      by: "yuki.tanaka",
      minutesAgo: 25,
      to: true,
      note: "browser-side totals, skip the quote round trip (FE-2378)",
    },
    decoys: [
      { key: "pdp.price_badges", description: "“-20%” badges on product cards", owner: "team-growth", by: "omar.haddad", minutesAgo: 40, to: true, note: "sale badges (GRW-440)" },
      { key: "checkout.shipping_upsell", description: "Express shipping upsell on the delivery step", owner: "team-checkout-web", by: "kofi.mensah", minutesAgo: 13, to: true, note: "express upsell (FE-2380)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"pricing: total_cents 4318.999999999999 is not an integer"}',
    view: {
      name: "discount",
      description: "Pay taps by discount on the order",
      dimension: "DISCOUNT",
      buckets: [
        { label: "Full price", share: 0.65 },
        { label: "% off sale items", share: 0.35, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Web customers buying sale items get “Something went wrong”. Full-price orders work." },
      { at: 60, from: "Omar Haddad · Growth", text: "Sale badges went on at 12:10 and the banner a few minutes ago. Could sale traffic be overloading something?" },
      { at: 110, from: "Kofi Mensah · Web engineer", text: "The shipping upsell went live at 12:37. It changes the total when people pick express." },
      { at: 170, from: "Yuki Tanaka · Web engineer", text: "We moved total calculation into the browser at 12:25 to save a round trip. Tests passed on whole-dollar prices." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "The sale is live and sale items don’t sell. ETA?" },
    ],
    hints: [
      "Full-price orders go through. Look at the arithmetic on the rest.",
      "Badges and banners change what customers see, not what the order says.",
      "Read the total exactly as checkout-api received it.",
    ],
    solution: [
      { command: "rum errors", why: "The 500s show total_cents arriving as 4318.999999999999, not a whole number of cents." },
      { command: "rum discount", why: "Only carts with percentage discounts fail; full-price totals come out whole." },
      { command: "flags history checkout.client_totals", why: "Browser-side totals went live at 12:25, when sale orders started failing." },
      { command: 'flags set checkout.client_totals off --note "float totals 500 at pricing"', why: "Totals come from checkout-api’s quote again; open tabs pick it up within ~20 s." },
      { command: "rum discount", why: "Sale orders stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "What failed sale checkouts on web?",
      options: [
        "Sale traffic overloaded checkout-api’s pricing service",
        "Totals added up in the browser came out in fractional cents",
        "The express shipping upsell charged shipping twice on sale items",
        "Sale badges showed a discount checkout-api never applied",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Browser-side totals, on at 12:25, computed discounted prices in floating point.",
        why: "Taking 20% off a price in JavaScript numbers leaves totals like 4318.999999999999 cents. checkout-api’s pricing wants whole cents and threw, answering 500. Full-price carts add up exactly, so they passed. Badges and the banner only change what customers see, and the upsell adds a whole-cent fee.",
        tell: "RUM put every failure on discounted carts, and the 500s quoted a fractional total_cents from 12:25.",
      },
    },
  },
  {
    slug: "api-edge-cors",
    title: "Pay does nothing for some",
    severity: "SEV2",
    opensAt: [8, 35],
    briefing:
      "Since about 08:15, roughly two in five web customers press Pay and nothing happens: no error page, and refreshing doesn’t help. checkout-api isn’t seeing their requests at all. Web platform and checkout-web both changed flags this morning.",
    roleBriefing: "You own checkout-web: flags and RUM. Three flags that touch the checkout page changed this morning. Find which one loses the Pay requests before you touch anything.",
    culprit: {
      key: "checkout.api_edge_host",
      description: "Send POST /checkout through api-edge.marlow.example (40% of sessions)",
      owner: "team-web-platform",
      by: "arjun.nair",
      minutesAgo: 21,
      to: true,
      note: "api-edge for checkout, 40% bucket (WEB-520)",
    },
    decoys: [
      { key: "web.early_hints", description: "103 Early Hints for checkout assets", owner: "team-web-platform", by: "nadia.karim", minutesAgo: 33, to: true, note: "Early Hints on checkout (WEB-518)" },
      { key: "checkout.address_validation_v2", description: "Inline address validation as the customer types", owner: "team-checkout-web", by: "hana.sato", minutesAgo: 10, to: true, note: "address validation v2 (FE-2384)" },
    ],
    where: "client",
    message:
      "Access to fetch at 'https://api-edge.marlow.example/checkout' from origin 'https://www.marlow.example' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    view: {
      name: "api-host",
      description: "Pay taps by API host",
      dimension: "API HOST",
      buckets: [
        { label: "api.marlow.example", share: 0.6 },
        { label: "api-edge.marlow.example", share: 0.4, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Some web customers press Pay and nothing happens at all. No error. Refreshing doesn’t help them." },
      { at: 60, from: "Hana Sato · Web engineer", text: "Address validation v2 went live at 08:25; it calls a new endpoint as you type. Could it be eating the session?" },
      { at: 120, from: "Nadia Karim · Web platform", text: "103 Early Hints for checkout went on at 08:02. Preloading shouldn’t break anything, but it’s new." },
      { at: 180, from: "Arjun Nair · Web platform", text: "We started sending 40% of checkout POSTs through the new api-edge host at 08:14. Backend says nothing from it is arriving." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "A fifth of all checkouts silently failing. Where are we?" },
    ],
    hints: [
      "checkout-api sees nothing wrong because the requests never arrive. Ask what the browser stopped.",
      "About two in five sessions fail, and refreshing doesn’t move them. Something buckets sessions.",
      "Read the origin and the host in the browser’s message.",
    ],
    solution: [
      { command: "rum errors", why: "The browser blocks POST /checkout to api-edge at the CORS preflight: it sends no Access-Control-Allow-Origin." },
      { command: "rum api-host", why: "Every failure goes to api-edge; api.marlow.example is clean." },
      { command: "flags history checkout.api_edge_host", why: "The edge host went to a 40% bucket at 08:14, when the silent failures began." },
      { command: 'flags set checkout.api_edge_host off --note "api-edge preflight lacks CORS headers"', why: "Every session posts to api.marlow.example again; open tabs pick it up within ~20 s." },
      { command: "rum api-host", why: "The api-edge sessions drain away as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did two in five web checkouts never reach checkout-api?",
      options: [
        "Early Hints preloaded a stale copy of the checkout script",
        "The new API host didn’t answer the CORS preflight for www",
        "Address validation v2 signed customers out mid-checkout on web",
        "The payment gateway dropped requests from the new edge network",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Routing 40% of checkout POSTs to api-edge at 08:14 hit a host with no CORS setup for www.",
        why: "A cross-origin POST with a JSON body needs a preflight, and api-edge answered it without Access-Control-Allow-Origin. The browser blocked the request before it left, so checkout-api never saw it and the page showed nothing. Sessions are bucketed by the flag, which is why refreshing didn’t help and the share held at two in five.",
        tell: "RUM’s top error was the browser’s CORS block naming api-edge, and every failing session posted to that host.",
      },
    },
  },
  {
    slug: "safari-bot-challenge",
    title: "Safari can’t pay",
    severity: "SEV2",
    opensAt: [19, 5],
    briefing:
      "Since about 18:40, iPhone and Mac customers on the website say Pay spins, then greys out. Chrome, Firefox and the apps are fine, and checkout-api sees no errors. Trust & safety, web platform and checkout-web all changed flags this evening.",
    roleBriefing: "You own checkout-web: flags and RUM. Three flags around the Pay button changed this evening, one of them aimed at Safari. Find which one stops Safari before you touch anything.",
    culprit: {
      key: "checkout.bot_challenge_v2",
      description: "Invisible bot challenge (third-party iframe) before Pay enables",
      owner: "team-trust",
      by: "felix.owusu",
      minutesAgo: 26,
      to: true,
      note: "bot challenge v2 on Pay (TRS-97)",
    },
    decoys: [
      { key: "web.webp_images", description: "Serve WebP product images to Safari 16+", owner: "team-web-platform", by: "arjun.nair", minutesAgo: 15, to: true, note: "WebP for Safari (WEB-524)" },
      { key: "checkout.trust_badges", description: "Security badges beside the Pay button", owner: "team-checkout-web", by: "priya.shah", minutesAgo: 44, to: true, note: "trust badges (FE-2388)" },
    ],
    where: "client",
    message: "[checkout] bot-challenge: no token after 10000 ms (iframe storage access denied); Pay disabled",
    view: {
      name: "browser",
      description: "Pay taps by browser",
      dimension: "BROWSER",
      buckets: [
        { label: "Chrome", share: 0.55 },
        { label: "Safari", share: 0.3, isFailing: true },
        { label: "Firefox", share: 0.08 },
        { label: "Edge", share: 0.07 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "iPhone and Mac customers on the website say Pay just spins, then greys out. Android and Windows are fine." },
      { at: 60, from: "Arjun Nair · Web platform", text: "We started serving WebP to Safari at 18:50. If images broke the page for Safari, that’d fit." },
      { at: 120, from: "Priya Shah · Web engineer", text: "Trust badges beside Pay went live at 18:21. They’re just images." },
      { at: 180, from: "Felix Owusu · Trust & safety", text: "We turned on the new invisible bot challenge at 18:39. It’s a third-party widget in an iframe; we tested it in Chrome." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Every Safari customer, for half an hour. ETA?" },
    ],
    hints: [
      "Only one browser family fails. What does it refuse that others allow?",
      "Images can look broken without stopping a button.",
      "The failing step names what it waited for, and for how long.",
    ],
    solution: [
      { command: "rum errors", why: "The bot challenge never issues a token because its iframe can’t use storage, so Pay stays disabled." },
      { command: "rum browser", why: "Only Safari fails; Safari blocks storage in third-party iframes by default." },
      { command: "flags history checkout.bot_challenge_v2", why: "Challenge v2 went on at 18:39, minutes before the complaints." },
      { command: 'flags set checkout.bot_challenge_v2 off --note "challenge iframe gets no token in Safari"', why: "Pay no longer waits for the challenge; open tabs pick it up within ~20 s." },
      { command: "rum browser", why: "Safari sessions recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why couldn’t Safari customers pay on web?",
      options: [
        "WebP images failed to decode and stalled the checkout page",
        "Safari blocked the bot challenge iframe from issuing a token",
        "Trust badges covered the Pay button in Safari’s narrow layout",
        "Apple Pay took over the Pay button for every Safari session",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Bot challenge v2, on at 18:39, runs in a third-party iframe Safari won’t give storage.",
        why: "The challenge needs storage inside its iframe to issue a token, and Safari blocks third-party iframe storage by default. No token came, so the page kept Pay disabled. Chrome allows it, which is why testing there passed. WebP images and badges can look wrong, but neither gates the button.",
        tell: "RUM’s top error was the challenge timing out without a token, and only Safari failed, from 18:39.",
      },
    },
  },
  {
    slug: "split-tender-rounding",
    title: "Gift card orders fail",
    severity: "SEV3",
    opensAt: [17, 20],
    briefing:
      "Since about 16:55, web customers who pay partly with a gift card get “Something went wrong” at Pay. Card-only orders are fine, as are the apps. Loyalty and checkout-web both changed flags this afternoon.",
    roleBriefing: "You own checkout-web: flags and RUM. A gift card feature and two cart changes went out this afternoon. Find which one breaks gift card orders before you switch anything off.",
    culprit: {
      key: "checkout.split_tender",
      description: "Pay with a gift card plus a card; the browser splits the amount",
      owner: "team-checkout-web",
      by: "yuki.tanaka",
      minutesAgo: 28,
      to: true,
      note: "split tender: gift card + card (FE-2391)",
    },
    decoys: [
      { key: "giftcards.balance_checker", description: "Gift card balance checker in the footer", owner: "team-loyalty", by: "ana.costa", minutesAgo: 11, to: true, note: "balance checker (LOY-58)" },
      { key: "cart.saved_for_later", description: "Save for later in the cart", owner: "team-checkout-web", by: "leo.fischer", minutesAgo: 37, to: true, note: "save for later (FE-2389)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments: tenders sum to 5839 but order total is 5840"}',
    view: {
      name: "tender",
      description: "Pay taps by how the order is paid",
      dimension: "TENDER",
      buckets: [
        { label: "Card only", share: 0.8 },
        { label: "Wallet", share: 0.08 },
        { label: "Gift card + card", share: 0.12, isFailing: true },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers paying partly with a gift card get “Something went wrong” on web. Card-only orders are fine." },
      { at: 60, from: "Ana Costa · Loyalty", text: "The balance checker went live at 17:09. People check a card, then pay with it. Could checking lock the card?" },
      { at: 110, from: "Leo Fischer · Web engineer", text: "Save for later went out at 16:43. Cart only; it shouldn’t reach payment." },
      { at: 170, from: "Yuki Tanaka · Web engineer", text: "Split payments went out at 16:52. The browser works out how much goes on each tender." },
      { at: 240, from: "Sam Tan · Eng manager", text: "It’s a small share, but every gift card holder is hitting it. Where are we?" },
    ],
    hints: [
      "Only orders paid more than one way fail. Look at how the amount is divided.",
      "Checking a balance reads a gift card; it doesn’t change what the order sends.",
      "Add up what checkout-api was asked to charge.",
    ],
    solution: [
      { command: "rum errors", why: "The 500s say the tenders add up to a cent less than the order total." },
      { command: "rum tender", why: "Only gift card + card orders fail." },
      { command: "flags history checkout.split_tender", why: "Split payments went live at 16:52, just before the failures." },
      { command: 'flags set checkout.split_tender off --note "split tenders off by a cent"', why: "Gift cards go back to covering whole orders only; open tabs pick it up within ~20 s." },
      { command: "rum tender", why: "Gift card orders stop failing as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did gift card orders fail on web?",
      options: [
        "The balance checker locked gift cards customers had just checked",
        "Split payments rounded each share and lost a cent",
        "Saved-for-later items stayed in the order at zero price",
        "The gift card provider rejected cards with low balances",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Split tender, on at 16:52, rounded each share down and lost a cent.",
        why: "The browser divides the total across the gift card and the card and rounds each part down to whole cents, so the parts can fall a cent short. checkout-api checks the tenders against the order total and answered 500 when they didn’t match. Single-tender orders never split. The balance checker only reads cards.",
        tell: "RUM put every failure on gift card + card orders, and the 500s showed tenders one cent below the total, from 16:52.",
      },
    },
  },
  {
    slug: "streamed-ssr-hydration",
    title: "Pay ignores taps on phones",
    severity: "SEV2",
    opensAt: [13, 15],
    briefing:
      "Since about 12:55, phone customers on the website tap Pay and nothing happens. Desktop, tablets and the apps are fine, and checkout-api sees no errors. Web platform and checkout-web changed flags around lunchtime.",
    roleBriefing: "You own checkout-web: flags and RUM. Three flags touching the checkout page changed in the last half hour, one aimed squarely at phones. Find the one that drops Pay taps before you switch anything off.",
    culprit: {
      key: "web.streaming_ssr_checkout",
      description: "Stream the checkout page from the server and hydrate as it arrives",
      owner: "team-web-platform",
      by: "sven.holm",
      minutesAgo: 20,
      to: true,
      note: "streaming SSR for checkout (WEB-530)",
    },
    decoys: [
      { key: "checkout.sticky_pay_mobile", description: "Sticky Pay bar at the bottom of the screen on phones", owner: "team-checkout-web", by: "hana.sato", minutesAgo: 31, to: true, note: "sticky Pay bar on phones (FE-2394)" },
      { key: "web.native_lazy_images", description: "Native lazy-loading for product images", owner: "team-web-platform", by: "tom.adeyemi", minutesAgo: 8, to: true, note: "native lazy images (FE-2396)" },
    ],
    where: "client",
    message: "Uncaught Error: Hydration failed because the initial UI does not match what was rendered on the server.",
    view: {
      name: "device",
      description: "Pay taps by device type",
      dimension: "DEVICE",
      buckets: [
        { label: "Desktop", share: 0.55 },
        { label: "Phone", share: 0.3, isFailing: true },
        { label: "Tablet", share: 0.15 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Phone customers on the website tap Pay and nothing happens. Desktop is fine." },
      { at: 60, from: "Hana Sato · Web engineer", text: "The sticky Pay bar went to phones at 12:44. If the tap target is off, that’d do it. I can switch it off." },
      { at: 120, from: "Tom Adeyemi · Web engineer", text: "Lazy images went on at 13:07. Nothing near the Pay button." },
      { at: 180, from: "Sven Holm · Web platform", text: "We started streaming the checkout page from the server at 12:55. Phones hydrate a lot slower than desktops." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Mobile web is a third of our web traffic. Where are we?" },
    ],
    hints: [
      "Only phones fail. Ask what phones do more slowly.",
      "A button that ignores taps may be one the page threw away and redrew.",
      "The browser’s error says the page didn’t match what it expected.",
    ],
    solution: [
      { command: "rum errors", why: "React reports a hydration mismatch: the page is redrawn on the client, and taps on the first Pay button go nowhere." },
      { command: "rum device", why: "Only phones fail; they hydrate slowly enough for customers to tap before the redraw." },
      { command: "flags history web.streaming_ssr_checkout", why: "Streaming went live at 12:55, when phone taps started vanishing; the sticky bar had been fine for ten minutes before." },
      { command: 'flags set web.streaming_ssr_checkout off --note "hydration mismatch drops Pay taps on phones"', why: "Checkout renders the old way; open tabs pick it up within ~20 s." },
      { command: "rum device", why: "Phone sessions recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did Pay stop working on phones?",
      options: [
        "The sticky Pay bar sat over the real button and swallowed taps",
        "Streamed pages failed to hydrate and lost the Pay taps",
        "Lazy images shifted the layout so taps missed the button",
        "checkout-api rejected requests carrying a phone user agent",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Streaming SSR, on at 12:55, sent markup that didn’t match the client’s first render.",
        why: "React threw away the server HTML and redrew the page. On a desktop that happens before anyone can tap; on a slow phone customers tapped the server-rendered Pay button, which had no handler and was then replaced. The sticky bar went live at 12:44 and phones paid fine until 12:55.",
        tell: "RUM’s top error was React’s hydration failure, and only phones failed, starting at 12:55 rather than 12:44.",
      },
    },
  },
  {
    slug: "postcode-normalizer-off",
    title: "UK and Canada can’t pay",
    severity: "SEV2",
    opensAt: [7, 55],
    briefing:
      "Since about 07:40, UK and Canadian customers on web get “Something went wrong” at Pay. US orders are fine, and so, oddly, are Australia and Germany. Nothing deployed overnight; international and checkout-web changed flags this morning.",
    roleBriefing: "You own checkout-web: flags and RUM. One flag was switched off this morning and two were switched on. Find which change broke UK and Canadian orders before you touch anything.",
    culprit: {
      key: "checkout.postcode_normalizer",
      description: "Uppercase and space postcodes before checkout",
      owner: "team-checkout-web",
      by: "carla.mendes",
      minutesAgo: 17,
      to: false,
      note: "off: suspected of mangling US ZIP+4 (FE-2399)",
    },
    decoys: [
      { key: "shipping.intl_duties_banner", description: "Duties & taxes banner on non-US orders", owner: "team-international", by: "lucia.romero", minutesAgo: 29, to: true, note: "duties banner (INT-33)" },
      { key: "checkout.country_flag_icons", description: "Flag icons in the country picker", owner: "team-checkout-web", by: "tom.adeyemi", minutesAgo: 6, to: true, note: "country flags (FE-2400)" },
    ],
    where: "server",
    message: '[checkout] POST /checkout 500 {"error":"internal","trace":"tax-quote: postcode \\"sw1a1aa\\" not found for country GB"}',
    view: {
      name: "ship-country",
      description: "Pay taps by shipping country",
      dimension: "COUNTRY",
      buckets: [
        { label: "US", share: 0.72 },
        { label: "GB", share: 0.12, isFailing: true },
        { label: "CA", share: 0.08, isFailing: true },
        { label: "Other", share: 0.08 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "UK and Canadian customers on web get “Something went wrong” at Pay. Australia and Germany are fine, oddly." },
      { at: 60, from: "Lucia Romero · International", text: "The duties banner went live at 07:26 on every non-US order. Could it be adding a fee checkout-api can’t price?" },
      { at: 110, from: "Tom Adeyemi · Web engineer", text: "Country flags went in at 07:49. Purely cosmetic." },
      { at: 170, from: "Carla Mendes · Web engineer", text: "I switched off the postcode normalizer at 07:38; a support ticket said it mangled ZIP+4 codes." },
      { at: 240, from: "Elena Ruiz · VP Engineering", text: "Two whole countries can’t buy. Where are we?" },
    ],
    hints: [
      "Not every international order fails. What do the failing countries’ postcodes have that plain numbers don’t?",
      "A banner shown on every non-US order can’t explain why only some of them fail.",
      "Read the postcode exactly as checkout-api received it.",
    ],
    solution: [
      { command: "rum errors", why: "The 500s show tax-quote failing on postcodes like “sw1a1aa”: lowercase, no space." },
      { command: "rum ship-country", why: "Only UK and Canadian orders fail: the countries with letters in their postcodes." },
      { command: "flags history checkout.postcode_normalizer", why: "Switched off at 07:38; it used to uppercase and space postcodes before checkout." },
      { command: 'flags set checkout.postcode_normalizer on --note "raw GB/CA postcodes 500 at tax-quote"', why: "Postcodes are normalized again; open tabs pick it up within ~20 s." },
      { command: "rum ship-country", why: "UK and Canadian orders recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "What broke UK and Canadian checkouts on web?",
      options: [
        "The duties banner added a fee tax-quote couldn’t price",
        "Postcodes reached tax-quote without being normalized",
        "Flag icons sent the country’s name instead of its code",
        "tax-quote lost its UK and Canada rate tables overnight",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Turning off the postcode normalizer at 07:38 sent raw UK and CA postcodes to tax-quote.",
        why: "tax-quote looks postcodes up in their canonical form, like “SW1A 1AA”. Without the normalizer, typed codes arrived lowercase and unspaced, the lookup failed and checkout-api answered 500. Numeric postcodes in the US, Australia and Germany need no normalizing, which also clears the duties banner shown on every non-US order.",
        tell: "RUM put every failure on GB and CA, and the 500s quoted a lowercase unspaced postcode, from 07:38 when the flag went off.",
      },
    },
  },
  {
    slug: "one-tap-pay-null-form",
    title: "Saved cards stopped paying",
    severity: "SEV2",
    opensAt: [21, 10],
    briefing:
      "Since about 20:45, web customers paying with a saved card tap Pay and nothing happens. New cards and wallets work, and checkout-api sees no errors. Identity and checkout-web changed flags this evening, two of them about saved cards.",
    roleBriefing: "You own checkout-web: flags and RUM. Two saved-card changes and a sign-in change went out this evening. Find the one that breaks saved-card Pay before you switch anything off.",
    culprit: {
      key: "checkout.one_tap_pay",
      description: "One-tap Pay button for saved cards",
      owner: "team-checkout-web",
      by: "noah.kim",
      minutesAgo: 24,
      to: true,
      note: "one-tap Pay for saved cards (FE-2403)",
    },
    decoys: [
      { key: "checkout.saved_card_cvc_skip", description: "Skip CVC re-entry for trusted saved cards", owner: "team-checkout-web", by: "ana.costa", minutesAgo: 38, to: true, note: "CVC skip for saved cards (FE-2401)" },
      { key: "account.passkeys", description: "Passkey sign-in on web", owner: "team-identity", by: "mei.lin", minutesAgo: 12, to: true, note: "passkeys on web (ID-90)" },
    ],
    where: "client",
    message: "Uncaught TypeError: Cannot read properties of null (reading 'requestSubmit')",
    view: {
      name: "card-source",
      description: "Pay taps by card source",
      dimension: "CARD",
      buckets: [
        { label: "New card", share: 0.5 },
        { label: "Saved card", share: 0.35, isFailing: true },
        { label: "Wallet", share: 0.15 },
      ],
    },
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Since about 20:45, customers paying with a saved card on web tap Pay and nothing happens." },
      { at: 60, from: "Ana Costa · Web engineer", text: "CVC skip for saved cards went live at 20:32. It changes the saved-card form, so it’s my first guess. Want it off?" },
      { at: 120, from: "Mei Lin · Identity", text: "Passkeys went on at 20:58. Sign-in only." },
      { at: 180, from: "Noah Kim · Web engineer", text: "One-tap Pay went out at 20:46: the saved-card Pay button submits the payment form directly." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Our most loyal customers can’t pay. ETA?" },
    ],
    hints: [
      "Only one way of paying fails. Find when it began, to the minute.",
      "Two changes touch saved cards. The browser’s error names the call that broke.",
      "The button reaches for a form that isn’t on the page.",
    ],
    solution: [
      { command: "rum errors", why: "Pay throws a TypeError: it calls requestSubmit on a form that is null." },
      { command: "rum card-source", why: "Only saved cards fail; new cards and wallets go through the regular form." },
      { command: "flags history checkout.one_tap_pay", why: "One-tap Pay went live at 20:46, the minute complaints began; CVC skip had been on for a quarter of an hour without trouble." },
      { command: 'flags set checkout.one_tap_pay off --note "one-tap button submits a missing form"', why: "Saved cards use the regular Pay button; open tabs pick it up within ~20 s." },
      { command: "rum card-source", why: "Saved-card sessions recover as tabs pick up the flag." },
    ],
    postmortem: {
      question: "Why did saved-card payments stop on web?",
      options: [
        "Skipping the CVC made the gateway decline saved cards",
        "One-tap Pay submitted a form that wasn’t on the page",
        "Passkey sign-in logged customers out right before payment",
        "Saved card tokens expired when the vault rotated its keys",
      ],
      answerIndex: 1,
      explanation: {
        cause: "One-tap Pay, on at 20:46, called requestSubmit on a payment form saved cards don’t render.",
        why: "Saved cards skip the full card form, so the form one-tap Pay tried to submit wasn’t there. The click threw a TypeError and nothing was sent. New cards and wallets use the regular button. CVC skip had been live since 20:32 with saved cards paying fine, and passkeys only change sign-in.",
        tell: "RUM’s top error was a TypeError reading requestSubmit of null, and only saved cards failed, from 20:46 rather than 20:32.",
      },
    },
  },
];

export const FRONTEND_TIER2_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
