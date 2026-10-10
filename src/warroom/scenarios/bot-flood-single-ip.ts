import type { Scenario } from "../scenario.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack } from "../sim/commerce.ts";
import { blockedShare, DISTINCT_SOURCE_IPS } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

const SEED = "bot-flood-single-ip";
export const FLOOD_IP = "167.99.7.204";

/** A stuck script on a rented server, posting an empty cart to checkout as fast as it can. */
const FLOOD: Attack = {
  label: "single-source flood",
  path: "/checkout",
  requestsPerSecond: 150,
  growthPerSecond: 0.3,
  sources: { kind: "ranges", ranges: [{ cidr: `${FLOOD_IP}/32`, asn: 14061, network: "DIGITALOCEAN-ASN", ips: 1 }] },
  // FoxIO ja4plus-mapping.csv: Python.
  ja4: "t13d4312h1_c7886603b240_b26ce05bbdd6",
  userAgent: "python-requests/2.32.3",
};

/** "201 87% · 503 13%": how the edge answered a group of requests. */
function statuses(parts: readonly (readonly [string, number])[]): string {
  return parts
    .filter(([, share]) => share > 0.0005)
    .map(([status, share]) => `${status} ${percent(share, 0)}`)
    .join(" · ");
}

/** Edge requests on POST /checkout grouped by client, as the SIEM indexes the WAF's logs. */
function edgeRequests(state: ClusterState): string[] {
  const { commerce } = state;
  if (!commerce?.attack) return [];
  const { perMinute, passed } = attackAtEdge(commerce, state.t);
  const shed = state.errorRate;
  const blocked = blockedShare(commerce.wafRules);
  const customers = commerce.platforms.map((platform) => [
    `${platform.id} ${platform.current.version}`,
    count(commerce.pulse.checkoutAttemptsPerSecond * platform.customerShare * WINDOW_SECONDS),
    count(DISTINCT_SOURCE_IPS * platform.customerShare),
    statuses([
      ["201", (1 - blocked) * (1 - shed)],
      ["503", (1 - blocked) * shed],
      ["403", blocked],
    ]),
  ]);
  return [
    "Edge requests · POST /checkout · last 5 min, by ClientRequestUserAgent",
    ...table([
      ["CLIENT", "REQUESTS", "ClientIP (distinct)", "EdgeResponseStatus"],
      [
        commerce.attack.userAgent,
        count((perMinute * WINDOW_SECONDS) / 60),
        "1",
        statuses([
          ["422", passed * (1 - shed)],
          ["503", passed * shed],
          ["403", 1 - passed],
        ]),
      ],
      ...customers,
    ]),
    `${commerce.attack.userAgent}: every request from ClientIP ${FLOOD_IP} (ClientASN 14061), same empty cart, no session cookie; checkout-api answers 422 cart_empty.`,
  ];
}

export const botFloodSingleIp: Scenario = {
  id: SEED,
  tier: 1,
  title: "One client is eating checkout",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Your first SOC page. checkout-api's three pods are full and shedding requests, but orders are flat and nobody deployed anything. You have the WAF and the SIEM on your laptop, and Lena, a senior SOC analyst, is on the call.",
  roles: ["security"],
  roleBriefings: {
    security:
      "SOC on-call: waf and siem. checkout-api is answering some requests with 503 because something is sending it far more than customers do. Find the source and stop it without turning a single customer away.",
  },
  opensAtSecondOfDay: 14 * 3600 + 20 * 60,
  seed: SEED,
  initialState: () => attackedCluster(SEED, checkoutCommerce({ attack: FLOOD })),
  isRootCauseFixed: (state) => isAttackStopped(state, 0.99),
  objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce)] : []),
  evidence: [{ tool: "siem", name: "edge-requests", description: "POST /checkout at the edge, grouped by client", run: edgeRequests }],
  suggestions: { security: ["waf top", "siem search edge-requests", "waf rules", "waf block --top 500"] },
  // About 15 checkouts a second shed while the flood runs; a quick, clean block costs a handful of points.
  lostCheckoutsPerPoint: 150,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 13%, pods at capacity, no deploy in the last 24 h. Assigned to SOC on-call (you)." },
    { at: 15, from: "Lena Park · Senior SOC analyst (your mentor)", text: "Traffic up, orders flat: first find out who's sending it. waf top lists the busiest source addresses on checkout." },
    { at: 45, from: "Sam Tan · Eng manager", text: "Requests to checkout are up by half and orders haven't moved. Whatever this is, it isn't shoppers." },
    {
      at: 80,
      from: "Lena Park · Senior SOC analyst (your mentor)",
      text: "One address at thousands a minute from a hosting provider isn't a shopper. Block that one address with waf block and its IP. Not a top-N list: the busiest customer addresses are phone carriers, one IP in front of thousands of people.",
    },
    { at: 150, from: "Maya Okonkwo · Support", text: "A few customers say the Pay button errors once and works on the second try." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "The traffic graph on checkout is still climbing. Where are we?" },
  ],
  hints: [
    "Nothing was deployed and the pods are healthy, just full. Look at who is sending the traffic.",
    "One source address sends far more than any shopper could. Which network is it on?",
    "Stop that one address, not a list of the busiest: the top customer addresses are phone carriers that put thousands of people behind one IP.",
  ],
  solution: {
    security: [
      { command: "waf top", why: "One hosting address sends ~9,000 requests a minute; the busiest customer address sends about 13." },
      { command: "siem search edge-requests", why: "It's a script posting an empty cart over and over: python-requests from one IP, every answer a 422 or a 503." },
      { command: `waf block ${FLOOD_IP}`, why: "Blocks that one address. The preview shows 0% of checkout customers behind it." },
      { command: "waf rules", why: "The new rule is matching the flood; give the pods a few seconds to drain and the 5xx stop." },
    ],
  },
  postmortem: {
    question: "What was taking checkout down?",
    options: [
      "A sale email sent more shoppers than three pods could serve",
      "One hosting IP posting to checkout faster than the pods serve",
      "A checkout-api deploy that halved what each pod could serve",
      "Mobile carrier NAT addresses sending too many checkouts",
    ],
    answerIndex: 1,
    explanation: {
      cause: "One DigitalOcean address posted an empty cart to checkout ~9,000 times a minute.",
      why: "Three pods serve about 390 requests a second and customers need 300. The script's 150 a second, and growing, pushed the pods past capacity, so they shed requests and real checkouts failed with them. Blocking its one address freed the capacity without touching a customer.",
      tell: "waf top: one hosting IP at ~9,000 req/min while the busiest customer IP sent about 13, and every one of its requests was the same empty cart from python-requests.",
    },
  },
};
