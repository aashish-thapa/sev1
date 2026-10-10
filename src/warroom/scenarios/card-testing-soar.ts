import type { Scenario } from "../scenario.ts";
import { count, percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, SiemAlert } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

const SEED = "card-testing-soar";
export const CARD_TESTING_ALERT = "SEC-5203";
export const TESTER_RANGE = "5.161.0.0/16";
const TESTERS = 4_000;
/** The playbook fires five minutes into the page unless an analyst closes the alert first. */
export const AUTO_CONTAIN_AT = 300;

/** Thousands of cheap cloud servers in one hosting /16, each trying a few stolen cards a minute. */
const CARD_TESTING: Attack = {
  label: "card testing",
  path: "/checkout",
  requestsPerSecond: 190,
  growthPerSecond: 0.03,
  sources: { kind: "ranges", ranges: [{ cidr: TESTER_RANGE, asn: 213230, network: "HETZNER-CLOUD2-AS", ips: TESTERS }] },
  // FoxIO ja4plus-mapping.csv: GoLang, no ALPN, so HTTP/1.1 and Go's default User-Agent for it.
  ja4: "t13d190900_9dc949149365_97f8aa674fd9",
  userAgent: "Go-http-client/1.1",
};

const ALERT: SiemAlert = {
  id: CARD_TESTING_ALERT,
  title: "Card testing: bursts of small authorisations on POST /checkout",
  rule: "payments.checkout.card_testing_velocity",
  severity: "high",
  openedAt: -120,
  autoContainAt: AUTO_CONTAIN_AT,
  containTopIps: 500,
  resolution: null,
};

function cardVelocity(state: ClusterState): string[] {
  const { commerce } = state;
  if (!commerce) return [];
  const { perMinute, passed } = attackAtEdge(commerce, state.t);
  const testing = perMinute * passed;
  // Customers' own checkouts at the 7-day pattern, plus whatever card testing gets past the WAF.
  const checkouts = commerce.pulse.checkoutAttemptsPerSecond * 60 + testing;
  const share = (now: number, baseline: number) => percent((baseline * (checkouts - testing) + now * testing) / checkouts);
  return [
    "Card-testing signals · POST /checkout · last 5 min",
    ...table([
      ["METRIC", "NOW", "7-DAY BASELINE"],
      ["distinct cards per session (p99)", testing > 1 ? "38" : "1", "1"],
      ["authorisations under $2.00", share(0.94, 0.001), "0.1%"],
      ["issuer decline rate", share(0.71, 0.023), "2.3%"],
      ["CVV mismatch rate", share(0.36, 0.003), "0.3%"],
      ["sessions with no prior page view", share(1, 0.02), "2.0%"],
    ]),
    "",
    "Declined authorisations by ClientASN · last 5 min",
    ...table([
      ["ClientASN", "NETWORK", "ClientIP (distinct)", "DECLINES", "ClientRequestUserAgent"],
      ["213230", "HETZNER-CLOUD2-AS", count(TESTERS), count(testing * 5 * 0.71), CARD_TESTING.userAgent],
      ["21928", "T-MOBILE-AS21928", "212", count(commerce.pulse.checkoutAttemptsPerSecond * 300 * 0.023 * 0.3), "Marlow/7.3.0 (com.marlow.shop; …)"],
    ]),
  ];
}

export const cardTestingSoar: Scenario = {
  id: SEED,
  tier: 3,
  title: "SOAR wants to block 500 IPs",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Card testers are trying stolen cards against checkout from thousands of addresses, and checkout-api is shedding requests. The SIEM alert is real, and its SOAR playbook will block the top 500 source IPs on checkout in five minutes unless someone closes the alert first.",
  roles: ["security"],
  roleBriefings: {
    security:
      "SOC on-call: siem and waf. SEC-5203 is genuine card testing, and its SOAR playbook will auto-block the top 500 source IPs on /checkout at 09:20. Contain the testers yourself before then, and make sure the playbook's block never runs.",
  },
  opensAtSecondOfDay: 9 * 3600 + 15 * 60,
  seed: SEED,
  initialState: () => attackedCluster(SEED, checkoutCommerce({ attack: CARD_TESTING, alerts: [ALERT] })),
  isRootCauseFixed: (state) => isAttackStopped(state, 0.99),
  objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), alertClosedAs(state.commerce, CARD_TESTING_ALERT, "true-positive")] : []),
  evidence: [{ tool: "siem", name: "card-velocity", description: "Card-testing signals on checkout, and declines by network", run: cardVelocity }],
  suggestions: {
    security: [`siem show ${CARD_TESTING_ALERT}`, "siem search card-velocity", "waf top", "waf top --by asn", "waf block --top 500", `siem resolve ${CARD_TESTING_ALERT} --disposition true-positive`],
  },
  // ~25 checkouts a second shed until the testers are blocked; reading the evidence first still lands near S.
  lostCheckoutsPerPoint: 250,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: `SEV2 triggered — checkout-api 5xx at 20%. ${CARD_TESTING_ALERT} (high): card testing on POST /checkout. Assigned to SOC on-call (you).` },
    { at: 20, from: "SOC · SOAR", text: `${CARD_TESTING_ALERT}: playbook auto-contain will block the top 500 source IPs on /checkout at 09:20 unless the alert is resolved.` },
    { at: 60, from: "Rafa Moreno · Payments ops", text: "Issuer declines are through the roof and it's all $1 authorisations. The gateway will start charging us dispute fees if this keeps up." },
    { at: 110, from: "Sam Tan · Eng manager", text: "Can't we just let SOAR do its thing? That's what we bought it for." },
    { at: 170, from: "Lena Park · SOC lead", text: "Before SOAR blocks anything: the top 500 talkers on checkout are normally phone carriers. Check who'd actually be on that list." },
    { at: 250, from: "Maya Okonkwo · Support", text: "Customers say checkout errors about one time in five." },
  ],
  hints: [
    "The alert is right that this is card testing. The question is what its playbook would block.",
    "Each tester sends fewer requests than hundreds of real customers do, so a list of the busiest addresses is mostly shoppers.",
    "Look at where the testers' addresses come from as a group, not one by one.",
    "Closing the alert as a plain true positive runs the playbook anyway. Tell it what already contains the attack.",
  ],
  solution: {
    security: [
      { command: `siem show ${CARD_TESTING_ALERT}`, why: "Real card testing, and the playbook will block the top 500 source IPs on /checkout at 09:20." },
      { command: "siem search card-velocity", why: "Dozens of cards per session, $1 authorisations, mostly declined: the alert is right." },
      { command: "waf top", why: "The busiest addresses are phone carriers at ~13 a minute. The testers send 3 each, below hundreds of customers." },
      { command: "waf top --by asn", why: "One hosting network, AS213230, holds 4,000 addresses, all in 5.161.0.0/16." },
      { command: `waf block ${TESTER_RANGE}`, why: "Stops every tester; the preview shows 0% of checkout customers." },
      {
        command: `siem resolve ${CARD_TESTING_ALERT} --disposition true-positive --contained-by r-0003 --note "card testing from AS213230, blocked by range"`,
        why: "Closes it as the true positive it is, naming our rule as the containment (r-0003 is the id `waf rules` gave your block), so the playbook's top-500 block never runs.",
      },
      { command: "waf rules", why: "The new rule is matching the testers and 0% of checkout; the 5xx drain within seconds." },
    ],
  },
  postmortem: {
    question: "Why would the playbook's top-500 block have backfired?",
    options: [
      "Each tester sent less than hundreds of customer addresses did",
      "The testers rotated addresses faster than SOAR could block them",
      "SOAR blocks for ten minutes, then lets the testers back in",
      "The testers all came through one mobile carrier's NAT address",
    ],
    answerIndex: 0,
    explanation: {
      cause: "4,000 testers at ~3 requests a minute each sat below the ~380 busiest customer addresses.",
      why: "The top of checkout's source list is phone carriers, one NAT address in front of thousands of shoppers. A top-500 block would have turned away about 35% of customers and stopped about 3% of the testers. The testers shared one hosting /16, so blocking that range stopped all of them and no customer.",
      tell: "waf top showed carriers at ~13 a minute above the testers' 3, while waf top --by asn put 4,000 addresses in one hosting ASN, all inside 5.161.0.0/16.",
    },
  },
};
