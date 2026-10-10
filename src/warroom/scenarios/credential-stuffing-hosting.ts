import type { Scenario } from "../scenario.ts";
import { percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, SiemAlert } from "../sim/commerce.ts";
import { blockedAttackShare } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackedCluster, isAttackStopped, noCustomersBlocked, signInSummary } from "./edge-attack.ts";

const SEED = "credential-stuffing-hosting";
export const SIGN_IN_ALERT = "SEC-5120";

const RANGES = [
  { cidr: "159.89.128.0/20", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 72 },
  { cidr: "51.75.0.0/16", asn: 16276, network: "OVH", ips: 48 },
] as const;

/** A combo list replayed against sign-in from 120 rented servers in two hosting networks. */
const STUFFING: Attack = {
  label: "credential stuffing",
  path: "/session",
  requestsPerSecond: 200,
  growthPerSecond: 0.15,
  sources: { kind: "ranges", ranges: RANGES },
  // FoxIO ja4plus-mapping.csv: Python.
  ja4: "t13d4312h1_c7886603b240_b26ce05bbdd6",
  userAgent: "python-requests/2.32.3",
};

const ALERT: SiemAlert = {
  id: SIGN_IN_ALERT,
  title: "Credential stuffing: failed sign-ins on POST /session",
  rule: "auth.session.failed_signin_burst",
  severity: "high",
  openedAt: -90,
  autoContainAt: null,
  containTopIps: 0,
  resolution: null,
};

/** Share of the stuffing past the WAF that ends in a valid login: the combo list's hit rate. */
const COMBO_HIT_RATE = 0.008;

function authSummary(state: ClusterState): string[] {
  const { commerce } = state;
  if (!commerce) return [];
  const passed = 1 - blockedAttackShare(commerce.wafRules);
  const total = RANGES.reduce((sum, range) => sum + range.ips, 0);
  return [
    ...signInSummary(state, COMBO_HIT_RATE, (STUFFING.requestsPerSecond * 60 * 15) / total, 1),
    "",
    "Failed sign-ins by ClientASN · last 15 min",
    ...table([
      ["ClientASN", "NETWORK", "SOURCE IPs", "SHARE OF FAILURES", "PAST THE WAF"],
      ...RANGES.map((range) => [String(range.asn), range.network, String(range.ips), percent(range.ips / total, 0), percent(passed, 0)]),
    ]),
  ];
}

export const credentialStuffingHosting: Scenario = {
  id: SEED,
  tier: 2,
  title: "Login storm from the cloud",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Sign-ins are running at twenty times normal and checkout is failing. POST /session, the sign-in endpoint, is served by checkout-api: the same three pods that take payments. A login storm fills them, and checkouts are shed with it. The SIEM has a credential-stuffing alert open.",
  roles: ["security"],
  roleBriefings: {
    security:
      "SOC on-call: siem and waf. The sign-in endpoint shares checkout-api's pods, so a login storm is a checkout outage. Work out who is signing in, stop it without locking out customers, and close the alert with the right disposition.",
  },
  opensAtSecondOfDay: 21 * 3600 + 40 * 60,
  seed: SEED,
  initialState: () => attackedCluster(SEED, checkoutCommerce({ attack: STUFFING, alerts: [ALERT] })),
  // A per-address limit stops ~80% of it, enough for the pods; blocking both ranges stops all of it.
  isRootCauseFixed: (state) => isAttackStopped(state, 0.75),
  objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), alertClosedAs(state.commerce, SIGN_IN_ALERT, "true-positive")] : []),
  evidence: [{ tool: "siem", name: "auth-summary", description: "Sign-ins against the 7-day baseline, and failures by network", run: authSummary }],
  suggestions: { security: ["siem alerts", `siem show ${SIGN_IN_ALERT}`, "siem search auth-summary", "waf top", "waf top --by asn", `siem resolve ${SIGN_IN_ALERT} --disposition false-positive`] },
  // ~30 checkouts a second shed until the storm is contained; a diagnosis in under a minute stays near S.
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: `SEV2 triggered — checkout-api 5xx at 22%. ${SIGN_IN_ALERT} (high) open on POST /session. Assigned to SOC on-call (you).` },
    { at: 20, from: "Dev Raman · Identity team", text: "Reminder that /session isn't its own service: sign-in runs on checkout-api, so anything hammering login lands on the checkout pods." },
    { at: 55, from: "Maya Okonkwo · Support", text: "Customers are getting “too many failed sign-in attempts” emails for logins they never tried." },
    { at: 95, from: "Lena Park · SOC lead", text: "Sign-in floods usually come from somewhere nobody shops from. Check the networks before you block anything." },
    { at: 160, from: "Sam Tan · Eng manager", text: "Can we not just mark the alert a false positive and move on? Customers are complaining about checkout, not login." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout still failing? This is now a customer-trust problem, not just an outage." },
  ],
  hints: [
    "The pods are full of something that isn't checkout. Look at what the sign-in endpoint has been seeing.",
    "Hundreds of usernames per address, from networks where nobody lives. Group the sources by network.",
    "A real shopper signs in a handful of times a minute at most. A cap per address costs them nothing.",
    "Once it's contained, close the alert with the disposition the evidence supports.",
  ],
  solution: {
    security: [
      { command: `siem show ${SIGN_IN_ALERT}`, why: "Failed sign-ins far above normal on POST /session, which checkout-api serves." },
      { command: "siem search auth-summary", why: "Sign-ins up ~20×, almost none succeed, over a thousand usernames per address, nearly all from two hosting ASNs: credential stuffing." },
      { command: "waf top --by asn", why: "AS14061 and AS16276: 120 hosting addresses at ~100 requests a minute each. No customer address sends more than about 13." },
      { command: "waf ratelimit 20/1m", why: "Caps every address at 20 a minute: stops ~80% of the stuffing and no customer comes near the limit." },
      {
        command: `siem resolve ${SIGN_IN_ALERT} --disposition true-positive --note "credential stuffing from DigitalOcean and OVH, rate limited per IP"`,
        why: "It is a real attack. A false positive would close it while the stuffing goes on.",
      },
      { command: "waf rules", why: "The rate limit is matching the stuffing and 0% of checkout; the 5xx drain within seconds." },
    ],
  },
  postmortem: {
    question: "Why did an attack on sign-in take checkout down?",
    options: [
      "Sign-in runs on checkout-api, so the stuffing filled its pods",
      "The attackers checked out with stolen cards and filled the queue",
      "Locked-out customers retried checkout until the gateway gave up",
      "The old /login rate limit blocked customers' checkout requests",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Credential stuffing on POST /session, which runs on the same pods as checkout.",
      why: "120 hosting addresses replayed a leaked combo list at ~200 sign-ins a second and growing. The pods serve ~390 requests a second and customers need 300, so the overflow was shed, checkouts included. A 20-a-minute limit per address cut the stuffing below the spare capacity and touched no customer.",
      tell: "Sign-ins up ~20× with almost none succeeding, over a thousand usernames per address, and two hosting ASNs sending ~100 requests a minute per address.",
    },
  },
};
