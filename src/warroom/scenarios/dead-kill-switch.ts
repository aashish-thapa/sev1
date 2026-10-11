import type { Scenario } from "../scenario.ts";
import { percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { triggerShare } from "../sim/clients.ts";
import { findFlag, isFlagOn, type ClientDefect } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const MINUTE = 60;
const DAY = 24 * 3600;
const WALLET_FLAG = "checkout.v2_wallet_autofill";
const PAYMENT_ELEMENT_FLAG = "checkout.payment_element_v2";
/** Share of web Pay taps that use a wallet-autofilled card. */
const WALLET_SHARE = 0.25;

const WALLET_DEFECT: ClientDefect = {
  trigger: { flag: WALLET_FLAG, failsWhenOn: true },
  failShare: WALLET_SHARE,
  where: "server",
  message: '[checkout] POST /checkout 500 {"error":"internal","trace":"wallet card has no billing_address.postal_code"}',
};

/** The kill switch's fallback: the v1 card form tokenizes through an API payments-vault has shut down. */
const V1_FALLBACK_DEFECT: ClientDefect = {
  trigger: { flag: PAYMENT_ELEMENT_FLAG, failsWhenOn: false },
  failShare: 1,
  where: "server",
  message: '[checkout] POST /checkout 500 {"error":"internal","trace":"payments-vault POST /v1/tokens: 410 Gone"}',
};

function paymentPaths(state: ClusterState): readonly string[] {
  const { commerce } = state;
  if (!commerce) return [];
  const v1 = triggerShare(V1_FALLBACK_DEFECT.trigger, commerce, state.t);
  const wallet = WALLET_SHARE * triggerShare(WALLET_DEFECT.trigger, commerce, state.t);
  return [
    "Pay taps by payment path · checkout-web · last 5 min",
    ...table([
      ["PATH", "PAY TAPS", "HTTP 500"],
      ["card form v2 · typed card", percent((1 - v1) * (1 - wallet)), v1 < 1 ? "0.0%" : "—"],
      ["card form v2 · wallet autofill", percent((1 - v1) * wallet), (1 - v1) * wallet > 0 ? "100.0%" : "—"],
      ["card form v1 · kill-switch fallback", percent(v1), v1 > 0 ? "100.0%" : "— (no sessions since 2026-09-02)"],
    ]),
  ];
}

export const deadKillSwitch: Scenario = {
  id: "dead-kill-switch",
  tier: 3,
  title: "The kill switch nobody tested",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Since mid-morning, about one web checkout in four fails with “Something went wrong” after Pay. The apps are fine and checkout-api hasn’t deployed. The checkout runbook has a kill switch for card-form trouble. Find the cause before you reach for it.",
  roles: ["frontend"],
  roleBriefings: {
    frontend: "You own checkout-web: the flags CLI and RUM. The card form changed this morning; the runbook has a kill switch for it.",
  },
  suggestions: {
    frontend: ["rum errors", "rum payment-paths", "rum overview", "flags list", `flags get ${PAYMENT_ELEMENT_FLAG}`, `flags set ${PAYMENT_ELEMENT_FLAG} off`],
  },
  evidence: [{ tool: "rum", name: "payment-paths", description: "Pay taps and 500s by card-form path", run: paymentPaths }],
  opensAtSecondOfDay: 10 * 3600 + 31 * MINUTE,
  seed: "dead-kill-switch",
  initialState: () =>
    checkoutCluster({
      seed: "dead-kill-switch",
      revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
      revision: 6,
      commerce: checkoutCommerce({
        platforms: {
          web: { current: { version: "2026.10.10-1", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY, defects: [V1_FALLBACK_DEFECT, WALLET_DEFECT] } },
        },
        flags: [
          {
            key: WALLET_FLAG,
            description: "Fill saved wallet cards into the v2 card form",
            owner: "team-checkout-web",
            history: [{ at: -26 * MINUTE, by: "ana.costa", from: false, to: true, note: "wallet autofill, 100% (FE-2331)" }],
          },
          {
            key: PAYMENT_ELEMENT_FLAG,
            description: "Card form v2. Kill switch: off sends every session back to the v1 card form",
            owner: "team-checkout-web",
            history: [{ at: -38 * DAY, by: "priya.shah", from: false, to: true, note: "v2 GA; v1 kept as the fallback (FE-1980)" }],
          },
          ...SHOP_FLAGS.filter((flag) => flag.key !== PAYMENT_ELEMENT_FLAG),
        ],
      }),
    }),
  isRootCauseFixed: (state) => {
    const wallet = state.commerce && findFlag(state.commerce, WALLET_FLAG);
    const paymentElement = state.commerce && findFlag(state.commerce, PAYMENT_ELEMENT_FLAG);
    return !!wallet && !isFlagOn(wallet) && !!paymentElement && isFlagOn(paymentElement);
  },
  lostCheckoutsPerPoint: 150,
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
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout, web only. Assigned to frontend on-call." },
    { at: 20, from: "Maya Okonkwo · Support", text: "Some web customers get “Something went wrong” after Pay, and it fails again when they retry. Others pay fine." },
    { at: 45, from: "Priya Shah · Frontend lead", text: `The checkout runbook says card-form trouble on web means ${PAYMENT_ELEMENT_FLAG} off: it’s the kill switch back to the old form. Your call.` },
    { at: 90, from: "Ana Costa · Web engineer", text: `I turned on ${WALLET_FLAG} at 10:05 (FE-2331). It only changes how saved cards get filled in.` },
    { at: 150, from: "Ravi Menon · Payments platform", text: "FYI payments-vault shut down the v1 tokens API on 30 Sep. Anything still on the v1 card form can’t get a card token." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "A quarter of web checkouts is a lot of money. What’s the plan?" },
  ],
  hints: [
    "Not every payment fails. Find which way of paying the failing ones have in common.",
    "A kill switch is only as good as what it falls back to. Check that the fallback still works before you pull it.",
    "Turn off the smallest thing that explains the errors.",
  ],
  solution: {
    frontend: [
      { command: "rum errors", why: "Every 500 is a wallet-autofilled card arriving without a billing postal code." },
      { command: "rum payment-paths", why: "Only the wallet autofill path fails. The v1 fallback hasn’t served anyone since September, so nobody knows it still works." },
      { command: `flags history ${WALLET_FLAG}`, why: "Wallet autofill went to 100% at 10:05, just before the errors began." },
      { command: `flags set ${WALLET_FLAG} off --note "wallet-filled cards 500 at checkout-api"`, why: "Customers type their card again. The rest of the v2 form keeps working." },
      { command: "rum payment-paths", why: "The wallet path disappears, and with it the 500s." },
    ],
  },
  postmortem: {
    question: "Why would the runbook’s kill switch have made this outage worse?",
    options: [
      "Flipping it logs every customer out of checkout-web at once",
      "Its v1 card form gets tokens from an API that was shut down",
      "Flags take an hour to reach open tabs, so it would act too late",
      "It also hides Apple Pay and Google Pay from the checkout page",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Wallet autofill, turned on at 10:05, sent saved cards without a billing postal code, and checkout-api failed those checkouts with 500.",
      why: `Turning ${WALLET_FLAG} off fixed it. The runbook's kill switch, ${PAYMENT_ELEMENT_FLAG}, falls back to the v1 card form, whose tokens API payments-vault shut down on 30 Sep. Nobody had sent traffic through the fallback for weeks, so pulling it would have failed every web checkout instead of a quarter of them.`,
      tell: "RUM put every 500 on the wallet autofill path, and the v1 fallback path had served no sessions since 2 Sep.",
    },
  },
};
