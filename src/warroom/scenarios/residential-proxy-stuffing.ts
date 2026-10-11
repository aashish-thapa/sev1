import type { Scenario } from "../scenario.ts";
import { count, percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, SiemAlert } from "../sim/commerce.ts";
import { BROWSER_JA4, DISTINCT_SOURCE_IPS } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked, signInSummary } from "./edge-attack.ts";

const SEED = "residential-proxy-stuffing";
export const PROXY_ALERT = "SEC-5317";
/** FoxIO ja4plus-mapping.csv: Python. TLS 1.3, 43 ciphers, 12 extensions, ALPN http/1.1 only. */
export const BOT_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
const PROXIES = 40_000;
/** Chrome's reduced User-Agent, frozen at a version from mid-2023. */
const STALE_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

/** A stuffing kit renting residential proxies: each address tries a sign-in every couple of minutes. */
const STUFFING: Attack = {
  label: "credential stuffing",
  path: "/session",
  requestsPerSecond: 330,
  growthPerSecond: 0.1,
  sources: { kind: "residential-proxies", ips: PROXIES },
  ja4: BOT_JA4,
  userAgent: STALE_CHROME,
};

const ALERT: SiemAlert = {
  id: PROXY_ALERT,
  title: "Sign-in failure ratio far above baseline on POST /session",
  rule: "auth.session.failure_ratio_anomaly",
  severity: "high",
  openedAt: -60,
  autoContainAt: null,
  containTopIps: 0,
  resolution: null,
};

const COMBO_HIT_RATE = 0.011;
/** Sign-ins a minute from real customers, at the 7-day baseline. */
const CUSTOMER_SIGN_INS = 604;

function authSummary(state: ClusterState): string[] {
  // Each proxy address tries about one username every two minutes: no address stands out.
  return signInSummary(state, COMBO_HIT_RATE, (STUFFING.requestsPerSecond * 60 * 15) / PROXIES, 0.004);
}

/** Sign-ins grouped by TLS client fingerprint, labelled the way FoxIO's JA4 database names them. */
function tlsFingerprints(state: ClusterState): string[] {
  const { commerce } = state;
  if (!commerce) return [];
  const { perMinute, passed } = attackAtEdge(commerce, state.t);
  const browsers = BROWSER_JA4.map((entry) => [
    entry.ja4,
    entry.client,
    entry.client === "Chromium Browser" ? "Chrome/141.0.0.0 (Mac, Windows)" : entry.client === "Safari" ? "Version/18.6 Safari (iPhone, Mac)" : "Firefox/143.0",
    count(CUSTOMER_SIGN_INS * entry.customerShare),
    count(DISTINCT_SOURCE_IPS * entry.customerShare),
    "97.8%",
  ]);
  const listed = BROWSER_JA4.reduce((sum, entry) => sum + entry.customerShare, 0);
  return [
    "POST /session by JA4 · last 15 min (fingerprint names: FoxIO JA4 database)",
    ...table([
      ["JA4", "KNOWN AS", "TOP USER-AGENT", "SIGN-INS/MIN PAST WAF", "ClientIP (distinct)", "SUCCESS"],
      [BOT_JA4, "Python", "Chrome/114.0.0.0 (Windows)", count(perMinute * passed), count(PROXIES), percent(COMBO_HIT_RATE)],
      ...browsers,
      ["(other: Marlow apps, unlisted)", "—", "Marlow/7.3.0 (com.marlow.shop; …)", count(CUSTOMER_SIGN_INS * (1 - listed)), count(DISTINCT_SOURCE_IPS * (1 - listed)), "97.4%"],
    ]),
    `${BOT_JA4} with ${STALE_CHROME}: ${count(PROXIES)} addresses across T-Mobile, Verizon Wireless, AT&T Mobility and Comcast, none above 1 sign-in a minute.`,
  ];
}

export const residentialProxyStuffing: Scenario = {
  id: SEED,
  tier: 4,
  title: "Bots that look like customers",
  severity: "SEV1",
  service: CHECKOUT,
  briefing:
    "A credential-stuffing kit is replaying a combo list against sign-in through residential proxies: tens of thousands of home and mobile addresses, the same networks our customers use, each trying a sign-in every couple of minutes. POST /session runs on checkout-api, so checkout is shedding requests.",
  roles: ["security"],
  roleBriefings: {
    security:
      "SOC on-call: siem and waf. The stuffing comes from the same carriers and ISPs as our customers, slower per address than any shopper. The blocks that worked last time won't. Find what the bots can't hide, and stop them without turning customers away.",
  },
  opensAtSecondOfDay: 7 * 3600,
  seed: SEED,
  initialState: () => attackedCluster(SEED, checkoutCommerce({ attack: STUFFING, alerts: [ALERT] })),
  isRootCauseFixed: (state) => isAttackStopped(state, 0.99),
  objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), alertClosedAs(state.commerce, PROXY_ALERT, "true-positive")] : []),
  evidence: [
    { tool: "siem", name: "auth-summary", description: "Sign-ins against the 7-day baseline", run: authSummary },
    { tool: "siem", name: "tls-fingerprints", description: "Sign-ins by TLS client fingerprint (JA4)", run: tlsFingerprints },
  ],
  suggestions: { security: [`siem show ${PROXY_ALERT}`, "siem search auth-summary", "waf top", "waf top --by asn", "waf ratelimit 1/1m", "siem search tls-fingerprints"] },
  // The page opens with ~45 checkouts a second shed; finding the one tell takes a minute even when it goes well.
  lostCheckoutsPerPoint: 400,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: `SEV1 triggered — checkout-api 5xx at 38%. ${PROXY_ALERT} (high): sign-in failure ratio far above baseline. Assigned to SOC on-call (you).` },
    { at: 25, from: "Dev Raman · Identity team", text: "Sign-in failures are 30× normal, and every username is tried once or twice. That's a combo list, not people forgetting passwords." },
    { at: 70, from: "Lena Park · SOC lead", text: "Rate limiting got us out of the last one. I doubt it will this time: look how slow each address is." },
    { at: 120, from: "Sam Tan · Eng manager", text: "Can we block Comcast for an hour? Most of the bad addresses seem to be there." },
    { at: 180, from: "Maya Okonkwo · Support", text: "Customers are locked out of their accounts and checkout is failing for the ones who aren't." },
    { at: 280, from: "Elena Ruiz · VP Engineering", text: "We're two hours from the 9am email. Whatever we block has to leave customers alone." },
  ],
  hints: [
    "Every address is quiet. What's wrong is in what the requests have in common, not in who sends the most.",
    "A browser identifies itself twice: in its User-Agent, and in how it opens the TLS connection. Only one of those is easy to fake.",
    "A rate limit low enough to catch an address that signs in twice an hour catches customers first, and their networks are the attackers' networks.",
  ],
  solution: {
    security: [
      { command: `siem show ${PROXY_ALERT}`, why: "Sign-in failures far above baseline on POST /session, which checkout-api serves." },
      { command: "siem search auth-summary", why: "Sign-ins up ~30×, a few percent succeed, a handful of usernames per address, almost nothing from hosting: stuffing through residential proxies." },
      { command: "waf top", why: "Nothing stands out: every proxy sends less than the busiest customers. Rate limits and IP blocks have nothing to grab." },
      { command: "siem search tls-fingerprints", why: `One JA4, ${BOT_JA4}, carries most of the sign-ins from 40,000 addresses with a Chrome 114 User-Agent. Chrome doesn't offer 43 ciphers or HTTP/1.1-only ALPN.` },
      { command: `waf block --ja4 ${BOT_JA4}`, why: "Blocks the one TLS client every bot shares; no browser our customers use presents it." },
      {
        command: `siem resolve ${PROXY_ALERT} --disposition true-positive --contained-by r-0003 --note "residential-proxy stuffing, blocked by JA4"`,
        why: "Closes it as the true positive it is, contained by the fingerprint block (r-0003 is the id `waf rules` gave your block).",
      },
      { command: "waf rules", why: "The new rule is matching the stuffing and 0% of checkout; the 5xx drain within seconds." },
    ],
  },
  postmortem: {
    question: "What singled out the stuffing bots from the customers?",
    options: [
      "They shared one TLS fingerprint that no real browser presents",
      "They came from a few hosting ASNs that one range block covers",
      "Each address sent far more sign-ins than any customer did",
      "Their User-Agent named an automation library, not a browser",
    ],
    answerIndex: 0,
    explanation: {
      cause: "Every bot opened TLS like Python's HTTP stack while claiming to be Chrome 114.",
      why: "The proxies were real home and mobile addresses, slower per address than shoppers, so top-N lists, CIDR blocks and per-IP rate limits caught customers first and bots barely. The kit could rewrite its User-Agent but not its TLS ClientHello: one JA4 shared by 40,000 addresses, which no customer browser presents.",
      tell: "siem search tls-fingerprints: one JA4 that FoxIO's database names Python, carrying most sign-ins from 40,000 addresses, each with a Chrome/114 User-Agent.",
    },
  },
};
