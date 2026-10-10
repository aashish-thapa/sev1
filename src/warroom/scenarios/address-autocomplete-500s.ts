import type { Scenario } from "../scenario.ts";
import { findFlag, isFlagOn } from "../sim/commerce.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const MINUTE = 60;
const AUTOCOMPLETE_FLAG = "checkout.address_autocomplete";
const GIFT_FLAG = "checkout.gift_message";

export const addressAutocomplete500s: Scenario = {
  id: "address-autocomplete-500s",
  tier: 2,
  title: "Checkout broke after lunch",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Since a little after 13:00, about a third of all checkouts fail with “Something went wrong” at the Pay button, every one of them on web. The apps are fine, the payment gateway is green, and checkout-api hasn’t deployed since yesterday. Several flags changed on checkout-web this hour.",
  roles: ["frontend"],
  roleBriefings: {
    frontend: "You own checkout-web: the flags CLI and RUM. Nothing was deployed, but flags were flipped. Work out which change broke checkout before you touch anything.",
  },
  suggestions: {
    frontend: ["rum overview", "rum errors", "rum session", "flags list", `flags history ${GIFT_FLAG}`, `flags set ${GIFT_FLAG} off`],
  },
  opensAtSecondOfDay: 13 * 3600 + 42 * MINUTE,
  seed: "address-autocomplete-500s",
  initialState: () =>
    checkoutCluster({
      seed: "address-autocomplete-500s",
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
              defects: [
                {
                  trigger: { flag: AUTOCOMPLETE_FLAG, failsWhenOn: true },
                  failShare: 0.6,
                  where: "server",
                  message: '[checkout] POST /checkout 500 {"error":"internal","trace":"tax-quote: unknown region \\"California\\" for country US"}',
                },
              ],
            },
          },
        },
        flags: [
          {
            key: AUTOCOMPLETE_FLAG,
            description: "Suggest full addresses as the customer types in the shipping form",
            owner: "team-checkout-web",
            history: [{ at: -33 * MINUTE, by: "nina.berg", from: false, to: true, note: "Places autocomplete on the shipping form, 100% (FE-2318)" }],
          },
          {
            key: GIFT_FLAG,
            description: "Optional gift message box under the cart summary",
            owner: "team-checkout-web",
            history: [{ at: -44 * MINUTE, by: "tom.adeyemi", from: false, to: true, note: "gift messages GA (FE-2302)" }],
          },
          ...SHOP_FLAGS,
        ],
      }),
    }),
  isRootCauseFixed: (state) => {
    const flag = state.commerce && findFlag(state.commerce, AUTOCOMPLETE_FLAG);
    return !!flag && !isFlagOn(flag);
  },
  // Most web checkouts (a third of all) fail until the flag reaches every tab: a quick fix still loses ~2,000.
  lostCheckoutsPerPoint: 200,
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
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 10% on POST /checkout. Assigned to frontend on-call." },
    { at: 20, from: "Maya Okonkwo · Support", text: "Since about 13:10, web customers get “Something went wrong” when they press Pay. Nobody on the apps has complained." },
    { at: 55, from: "Tom Adeyemi · Web engineer", text: `I turned on ${GIFT_FLAG} at 12:58. Could that be it? Happy to switch it off.` },
    { at: 100, from: "Sam Tan · Eng manager", text: "Backend confirms checkout-api hasn’t deployed since yesterday, and its 500s are all on web. Whatever changed, changed in the browser." },
    { at: 160, from: "Nina Berg · Web engineer", text: "Address autocomplete went to 100% after lunch. QA tested it on UK addresses; it looked fine." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "A third of checkouts failing for half an hour, all on web. Where are we?" },
  ],
  hints: [
    "Not every checkout fails. Find out what the failing ones have in common.",
    "Three changes went out this hour. Only one went live when the complaints started, and only one touches the part of the form that fails.",
    "An error that names a field points at whatever fills that field in.",
  ],
  solution: {
    frontend: [
      { command: "rum errors", why: "checkout-api answers 500 when the shipping region arrives as “California” instead of a two-letter code." },
      { command: "flags list", why: "Three flags changed this hour. Only address autocomplete fills in the address, and it flipped at 13:09, when the errors began." },
      { command: `flags history ${AUTOCOMPLETE_FLAG}`, why: "It went to 100% after lunch; nothing else changed on the shipping form." },
      { command: `flags set ${AUTOCOMPLETE_FLAG} off --note "autocompleted regions 500 at checkout-api"`, why: "Customers type their address again; open tabs pick it up within ~20 s." },
      { command: "rum errors", why: "The 500s fade out as tabs pick up the flag." },
    ],
  },
  postmortem: {
    question: "What broke web checkout after lunch?",
    options: [
      "The gift message box sent a field checkout-api couldn’t parse",
      "Autocompleted addresses carried a region checkout-api failed on",
      "The sale banner sent more traffic than checkout-api could serve",
      "The payment gateway began declining cards issued abroad",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Address autocomplete, turned on for everyone at 13:09, filled the shipping region with a full state name that checkout-api’s tax quote couldn’t handle.",
      why: "checkout-api expects a two-letter region code. Autocompleted US addresses sent names like “California”, and the tax quote threw, so checkout-api answered 500. Typed addresses still worked, which is why only part of web checkout failed and the apps were untouched. The gift message and the sale banner changed this hour too, but neither touches the address.",
      tell: "RUM’s top errors were 500s naming the shipping region, and they began at 13:09, the minute the autocomplete flag went to 100%.",
    },
  },
};
