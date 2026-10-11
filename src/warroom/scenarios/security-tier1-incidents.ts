import type { CommsMessage, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent, WINDOW_SECONDS } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, AttackRange, SiemAlert } from "../sim/commerce.ts";
import { blockedShare, BROWSER_JA4, DISTINCT_SOURCE_IPS } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

const MENTOR = "Lena Park · Senior SOC analyst (your mentor)";

// FoxIO ja4plus-mapping.csv and JA4 README.
const PYTHON_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
const GO_JA4 = "t13d190900_9dc949149365_97f8aa674fd9";
const CHROMIUM_JA4 = "t13d1517h2_8daaf6152771_cb7bf5808d99";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** One tier-1 security page: an attack on a checkout-api endpoint, and the story that goes with it. */
type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly attack: Attack;
  /** Share of the attack the WAF must stop for the root cause to count as fixed. */
  readonly stopShare: number;
  readonly alert?: Omit<SiemAlert, "openedAt" | "autoContainAt" | "containTopIps" | "resolution"> & { readonly openedAt: number };
  readonly view: {
    readonly name: string;
    readonly description: string;
    /** What checkout-api answers the attack with when it gets through, e.g. "404 card_not_found". */
    readonly answer: string;
    readonly facts: readonly (readonly [string, string, string])[];
    readonly tell: string;
  };
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly suggestions: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly lostCheckoutsPerPoint: number;
  readonly postmortem: Postmortem;
};

function attackerIps(attack: Attack): number {
  return attack.sources.kind === "ranges" ? attack.sources.ranges.reduce((sum, range) => sum + range.ips, 0) : attack.sources.ips;
}

/** "201 87% · 503 13%": how the edge answered a group of requests. */
function statuses(parts: readonly (readonly [string, number])[]): string {
  return parts
    .filter(([, share]) => share > 0.0005)
    .map(([status, share]) => `${status} ${percent(share, 0)}`)
    .join(" · ");
}

/** The attacked path and checkout at the edge, by client and by TLS fingerprint, as the SIEM indexes the WAF's logs. */
function edgeView(row: Row) {
  return (state: ClusterState): string[] => {
    const { commerce } = state;
    if (!commerce?.attack) return [];
    const { attack } = commerce;
    const { perMinute, passed } = attackAtEdge(commerce, state.t);
    const shed = state.errorRate;
    const blocked = blockedShare(commerce.wafRules);
    const customers = commerce.platforms.map((platform) => [
      `${platform.id} ${platform.current.version}`,
      "/checkout",
      count(commerce.pulse.checkoutAttemptsPerSecond * platform.customerShare * WINDOW_SECONDS),
      count(DISTINCT_SOURCE_IPS * platform.customerShare),
      statuses([
        ["201", (1 - blocked) * (1 - shed)],
        ["503", (1 - blocked) * shed],
        ["403", blocked],
      ]),
    ]);
    const attackRequests = (perMinute * WINDOW_SECONDS) / 60;
    const checkoutRequests = commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS;
    const browsers = BROWSER_JA4.map((browser) => [browser.ja4, browser.client, count(checkoutRequests * browser.customerShare)]);
    const attackerBrowser = BROWSER_JA4.find((browser) => browser.ja4 === attack.ja4);
    return [
      `Edge requests · POST ${attack.path} and POST /checkout · last 5 min, by ClientRequestUserAgent`,
      ...table([
        ["CLIENT", "PATH", "REQUESTS", "ClientIP (distinct)", "EdgeResponseStatus"],
        [
          attack.userAgent.length > 48 ? `${attack.userAgent.slice(0, 45)}...` : attack.userAgent,
          attack.path,
          count(attackRequests),
          count(attackerIps(attack)),
          statuses([
            [row.view.answer, passed * (1 - shed)],
            ["503", passed * shed],
            ["403", 1 - passed],
          ]),
        ],
        ...customers,
      ]),
      "",
      "TLS client fingerprints (JA4) · same window",
      ...table([
        ["JA4", "CLIENT (FoxIO mapping)", "REQUESTS"],
        ...(attackerBrowser
          ? browsers.map(([ja4, client, requests]) => (ja4 === attack.ja4 ? [ja4, client, `${requests} + ${count(attackRequests)} on ${attack.path}`] : [ja4, client, requests]))
          : [[attack.ja4, attack.ja4 === GO_JA4 ? "GoLang" : "Python", `${count(attackRequests)} (all on ${attack.path})`], ...browsers]),
      ]),
      "",
      `${attack.path} · signals vs the 7-day baseline`,
      ...table([["SIGNAL", "NOW", "BASELINE"], ...row.view.facts]),
      row.view.tell,
    ];
  };
}

function scenarioFrom(row: Row): Scenario {
  const id = `sec-t1-${row.slug}`;
  const alert: SiemAlert | undefined = row.alert && { ...row.alert, autoContainAt: null, containTopIps: 0, resolution: null };
  return {
    id,
    tier: 1,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["security"],
    roleBriefings: { security: row.roleBriefing },
    opensAtSecondOfDay: row.opensAt[0] * 3600 + row.opensAt[1] * 60,
    seed: id,
    initialState: () => attackedCluster(id, checkoutCommerce({ attack: row.attack, alerts: alert ? [alert] : [] })),
    isRootCauseFixed: (state) => isAttackStopped(state, row.stopShare),
    objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), ...(alert ? [alertClosedAs(state.commerce, alert.id, "true-positive")] : [])] : []),
    evidence: [{ tool: "siem", name: row.view.name, description: row.view.description, run: edgeView(row) }],
    suggestions: { security: row.suggestions },
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [],
    comms: row.comms,
    postmortem: row.postmortem,
    hints: row.hints,
    solution: { security: row.solution },
  };
}

function oneAddress(cidr: string, asn: number, network: string): Attack["sources"] {
  return { kind: "ranges", ranges: [{ cidr, asn, network, ips: 1 }] };
}

function ranges(...list: readonly AttackRange[]): Attack["sources"] {
  return { kind: "ranges", ranges: list };
}

const ROWS: readonly Row[] = [
  // ── One address: block it ────────────────────────────────────────────────────
  {
    slug: "gift-card-guesser",
    title: "Someone is guessing gift cards",
    severity: "SEV2",
    opensAt: [9, 10],
    attack: {
      label: "gift card enumeration",
      path: "/gift-cards/balance",
      requestsPerSecond: 140,
      growthPerSecond: 0.25,
      sources: oneAddress("95.216.142.77/32", 24940, "HETZNER-AS"),
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    stopShare: 0.99,
    alert: {
      id: "SEC-6011",
      title: "Gift card enumeration: balance lookups for unknown card numbers",
      rule: "payments.giftcard.balance_miss_burst",
      severity: "high",
      openedAt: -150,
    },
    view: {
      name: "giftcard-lookups",
      description: "Gift card balance lookups and checkout at the edge, by client",
      answer: "404",
      facts: [
        ["balance lookups / min", "8,400+", "35"],
        ["lookups for card numbers that don't exist", "99.97%", "4%"],
        ["card numbers tried, sequential in the last 6 digits", "yes", "no"],
      ],
      tell: "Go-http-client/1.1: every lookup from ClientIP 95.216.142.77 (ClientASN 24940), card numbers counting up one at a time; checkout-api answers 404 card_not_found.",
    },
    briefing:
      "Gift card balance lookups are up three hundred times and checkout is shedding requests. Balance lookups run on checkout-api, the same three pods that take payments. The SIEM has an enumeration alert open, and Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Something is checking gift card balances far faster than any customer and filling checkout-api's pods. Find it, stop it without turning a customer away, and close the alert for what it is.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 11%. SEC-6011 (high) open: gift card balance misses. Assigned to SOC on-call (you)." },
      { at: 15, from: MENTOR, text: "Read the alert first, then see who's doing the lookups. waf top shows the busiest addresses on the paths under attack." },
      { at: 50, from: "Noor Haddad · Payments", text: "None of the lookups have hit a live card yet, as far as I can see. But the card numbers are sequential, so it's a matter of time." },
      { at: 90, from: MENTOR, text: "One rented server isn't a customer. Stop that one address. Don't block a list of the busiest: the top customer addresses are phone carriers." },
      { at: 160, from: "Maya Okonkwo · Support", text: "Customers say the Pay button errors once and works on the second try." },
      { at: 250, from: "Elena Ruiz · VP Engineering", text: "Is checkout still shedding? Finance wants to know if any gift card balance was drained." },
    ],
    hints: [
      "The alert is about balance lookups, and checkout-api serves them. Who is doing them?",
      "One address sends thousands of lookups a minute from a hosting network. No shopper does that.",
      "Stop that address alone, then close the alert with the disposition the evidence supports.",
    ],
    suggestions: ["siem alerts", "siem show SEC-6011", "siem search giftcard-lookups", "waf top", "waf rules"],
    solution: [
      { command: "siem show SEC-6011", why: "Balance lookups for card numbers that don't exist, far above baseline, on an endpoint checkout-api serves." },
      { command: "waf top", why: "One Hetzner address sends ~8,400 lookups a minute; the busiest customer address sends about 13." },
      { command: "siem search giftcard-lookups", why: "Go-http-client counting through card numbers one by one: enumeration, almost every answer a 404." },
      { command: "waf block 95.216.142.77", why: "Blocks that one address. The preview shows 0% of checkout customers behind it." },
      { command: 'siem resolve SEC-6011 --disposition true-positive --note "gift card enumeration from one Hetzner IP, blocked at the WAF"', why: "It's a real attack; the block contains it." },
      { command: "waf rules", why: "The new rule matches the lookups and nothing on checkout; the pods drain in seconds." },
    ],
    lostCheckoutsPerPoint: 150,
    postmortem: {
      question: "What was filling checkout-api's pods?",
      options: [
        "A holiday rush of customers checking their gift card balances",
        "One Hetzner IP guessing gift card numbers on balance lookup",
        "A gift card provider outage making every lookup retry",
        "Phone carrier addresses sending too many balance lookups",
      ],
      answerIndex: 1,
      explanation: {
        cause: "One Hetzner address enumerated gift card numbers on the balance endpoint.",
        why: "Balance lookups run on checkout-api. Three pods serve about 390 requests a second and customers need 300; the script's 140 a second, and growing, pushed them past capacity, so real checkouts were shed with it. Blocking its one address freed the pods without touching a customer.",
        tell: "waf top: one hosting IP at ~8,400 lookups a minute, and the SIEM view: sequential card numbers, almost every lookup a 404.",
      },
    },
  },
  {
    slug: "promo-code-brute",
    title: "Promo codes tried by the thousand",
    severity: "SEV2",
    opensAt: [11, 35],
    attack: {
      label: "promo code brute force",
      path: "/cart/promo",
      requestsPerSecond: 120,
      growthPerSecond: 0.3,
      sources: oneAddress("51.38.66.190/32", 16276, "OVH"),
      ja4: PYTHON_JA4,
      userAgent: "python-httpx/0.27.0",
    },
    stopShare: 0.99,
    view: {
      name: "promo-attempts",
      description: "Promo code redemptions and checkout at the edge, by client",
      answer: "422",
      facts: [
        ["promo attempts / min", "7,200+", "90"],
        ["attempts rejected promo_invalid", "99.9%", "18%"],
        ["codes tried that look like SPRING-XXXX", "100%", "0%"],
      ],
      tell: "python-httpx/0.27.0: every attempt from ClientIP 51.38.66.190 (ClientASN 16276) on one cart, a new SPRING-XXXX code each time; checkout-api answers 422 promo_invalid.",
    },
    briefing:
      "Marketing's SPRING codes went out to the newsletter an hour ago and checkout-api is shedding requests. The promo field on the cart is served by the same three pods that take payments. Orders are flat. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. checkout-api's promo endpoint is taking far more requests than shoppers send, and checkouts are failing with it. Find the source and stop it without blocking a single customer.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 9%, pods at capacity. No deploy since yesterday. Assigned to SOC on-call (you)." },
      { at: 20, from: "Iris Chen · Marketing", text: "The newsletter went out at 10:30 with three SPRING codes. Is that what's breaking checkout? It was 40,000 emails, not millions." },
      { at: 45, from: MENTOR, text: "Forty thousand emails don't make this. Rank the sources on the promo path and see who's busy." },
      { at: 100, from: MENTOR, text: "A blanket per-IP limit sounds safe, but set it low and you cap the carrier addresses too: thousands of phones share each one. Aim at the source." },
      { at: 170, from: "Maya Okonkwo · Support", text: "Two people say the promo field spins forever, then checkout errors." },
      { at: 260, from: "Sam Tan · Eng manager", text: "Graph's still climbing on checkout-api. Anything I should tell the business?" },
    ],
    hints: [
      "The newsletter is a red herring at that volume. Who is calling the promo endpoint?",
      "One address on a hosting network tries codes thousands of times a minute.",
      "Stop just that address. A tight per-address cap would also hit phone carriers' shared addresses.",
    ],
    suggestions: ["waf top", "siem search promo-attempts", "waf top --by asn", "waf rules"],
    solution: [
      { command: "waf top", why: "One OVH address sends ~7,200 requests a minute; the busiest customer address sends about 13." },
      { command: "siem search promo-attempts", why: "python-httpx guessing SPRING-XXXX codes on one cart, nearly every answer a 422 promo_invalid." },
      { command: "waf block 51.38.66.190", why: "Blocks that one address and no customer: the preview shows 0% of checkout behind it." },
      { command: "waf rules", why: "The rule matches the brute force; the pods drain and the 5xx stop." },
    ],
    lostCheckoutsPerPoint: 120,
    postmortem: {
      question: "What took checkout-api past capacity?",
      options: [
        "The SPRING newsletter sent more shoppers than three pods hold",
        "One OVH address brute-forcing SPRING promo codes on a cart",
        "A broken promo code that made every customer's cart retry",
        "A marketing pixel on the newsletter calling the promo endpoint",
      ],
      answerIndex: 1,
      explanation: {
        cause: "One OVH address tried SPRING promo codes thousands of times a minute.",
        why: "The promo endpoint runs on checkout-api. Its 120 requests a second, and growing, took the pods past the ~390 they serve while customers need 300, so checkouts were shed. Blocking the one address freed them; a low per-IP limit would also have capped carrier addresses shared by thousands of phones.",
        tell: "waf top: one hosting IP at ~7,200 requests a minute, all on one cart, each a different SPRING-XXXX code.",
      },
    },
  },
  {
    slug: "catalogue-scraper",
    title: "A scraper pricing the whole catalogue",
    severity: "SEV2",
    opensAt: [3, 5],
    attack: {
      label: "price scraping",
      path: "/api/price-check",
      requestsPerSecond: 160,
      growthPerSecond: 0.2,
      sources: oneAddress("54.162.31.9/32", 14618, "AMAZON-AES"),
      ja4: PYTHON_JA4,
      userAgent: "Scrapy/2.11.2 (+https://scrapy.org)",
    },
    stopShare: 0.99,
    view: {
      name: "price-check-clients",
      description: "Price checks and checkout at the edge, by client",
      answer: "200",
      facts: [
        ["price checks / min", "9,600+", "60"],
        ["distinct SKUs per client (p99)", "41,000", "6"],
        ["price checks with a cart cookie", "0.0%", "96%"],
      ],
      tell: "Scrapy/2.11.2: every price check from ClientIP 54.162.31.9 (ClientASN 14618), walking the SKU list in order with no cart cookie.",
    },
    briefing:
      "It's 3 a.m. and checkout-api is shedding requests with nobody shopping. The overnight price-check endpoint the apps use for cart totals runs on the same three pods. Nothing was deployed. Lena, a senior SOC analyst, picked up the bridge from home.",
    roleBriefing:
      "SOC on-call: waf and siem. Night traffic should be light, but checkout-api's pods are full. Find what is calling the price-check endpoint so hard and stop it, with no customer blocked.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 15% at 03:05. Overnight traffic should be a third of this. Assigned to SOC on-call (you)." },
      { at: 25, from: MENTOR, text: "At this hour any big talker stands out. Rank the sources." },
      { at: 70, from: "Tomás Ortega · Pricing", text: "A competitor's prices matched ours to the cent within an hour last week. Someone's been reading our catalogue." },
      { at: 115, from: MENTOR, text: "One address doesn't need a top-100 block: the rest of that list is customers. Take the one." },
      { at: 200, from: "Asia-Pacific support", text: "Customers in Sydney say checkout failed twice before it went through." },
    ],
    hints: [
      "Night traffic is light, so whatever fills the pods is easy to spot. Who sends the most?",
      "One cloud address walks every SKU in order, with no cart and no cookie.",
      "Block that address alone; everything below it in the ranking is a customer.",
    ],
    suggestions: ["waf top", "siem search price-check-clients", "waf top --by asn", "waf rules"],
    solution: [
      { command: "waf top", why: "One AWS address sends ~9,600 requests a minute; the next is a customer at about 13." },
      { command: "siem search price-check-clients", why: "Scrapy walking 41,000 SKUs with no cart cookie: a price scraper, not the apps." },
      { command: "waf block 54.162.31.9", why: "Blocks that address only. The preview shows 0% of checkout customers." },
      { command: "waf rules", why: "The rule is matching the scraper; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 150,
    postmortem: {
      question: "What filled checkout-api at 3 a.m.?",
      options: [
        "A nightly price sync from the apps running at the wrong hour",
        "A Scrapy crawler on one AWS address checking every SKU price",
        "Asia-Pacific customers shopping during their business hours",
        "A cache flush that sent every price check to the pods at once",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A Scrapy crawler on one AWS address priced the whole catalogue.",
        why: "The price-check endpoint runs on checkout-api. The crawler's 160 requests a second, and growing, took the three pods past the ~390 they serve, so checkouts were shed with it. One /32 block stopped it; a top-100 block would also have taken 99 customer addresses, carrier NAT among them.",
        tell: "waf top: one hosting IP at ~9,600 req/min, and the SIEM view: 41,000 distinct SKUs from it, none with a cart cookie.",
      },
    },
  },
  {
    slug: "load-test-on-prod",
    title: "A load test pointed at production",
    severity: "SEV2",
    opensAt: [16, 0],
    attack: {
      label: "misdirected load test",
      path: "/checkout",
      requestsPerSecond: 130,
      growthPerSecond: 0.35,
      sources: oneAddress("139.162.88.41/32", 63949, "AKAMAI-LINODE-AP"),
      ja4: GO_JA4,
      userAgent: "k6/0.52.0 (https://k6.io/)",
    },
    stopShare: 0.99,
    view: {
      name: "checkout-clients",
      description: "POST /checkout at the edge, by client",
      answer: "400",
      facts: [
        ["checkouts with a sandbox payment token", "7,800+ / min", "0"],
        ["requests ramping in steps of", "+20 VUs / min", "—"],
        ["X-Test-Run header present", "yes (perf-agency-q3)", "no"],
      ],
      tell: "k6/0.52.0: every request from ClientIP 139.162.88.41 (ClientASN 63949) with a sandbox payment token and X-Test-Run: perf-agency-q3; checkout-api answers 400 sandbox_token.",
    },
    briefing:
      "checkout-api is shedding requests at four in the afternoon, and the traffic keeps stepping up every minute. An outside agency was booked to load-test the staging checkout this week. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. checkout-api's pods are full of requests that never become orders, rising in steps. Find where they come from and stop them at the edge without turning a customer away.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 10% and rising in steps. No deploy today. Assigned to SOC on-call (you)." },
      { at: 20, from: "Ravi Menon · QA lead", text: "The perf agency's run was meant for staging this afternoon. I've emailed them, no reply yet." },
      { at: 45, from: MENTOR, text: "Don't wait for the agency. Find the source at the edge and stop it there; we can unblock them later." },
      { at: 110, from: MENTOR, text: "It's one address. A top-500 block would take that one and 499 customer addresses with it, most of them phone carriers." },
      { at: 180, from: "Maya Okonkwo · Support", text: "Some customers get an error on Pay and it works on the retry." },
      { at: 270, from: "Ravi Menon · QA lead", text: "Agency confirms: their script had the production hostname. They're stopping it, but it'll take them a while to find the runner." },
    ],
    hints: [
      "The traffic steps up minute by minute, like a ramp someone configured. Who sends it?",
      "One cloud address, a load-testing tool's User-Agent, and a sandbox payment token on every checkout.",
      "Stop that address at the edge. The agency can stop their runner later.",
    ],
    suggestions: ["waf top", "siem search checkout-clients", "waf top --by asn", "waf rules"],
    solution: [
      { command: "waf top", why: "One Linode address sends ~7,800 requests a minute and climbing; the busiest customer address sends about 13." },
      { command: "siem search checkout-clients", why: "k6 with sandbox tokens and an X-Test-Run header: the agency's load test, aimed at production." },
      { command: "waf block 139.162.88.41", why: "Blocks the test runner and nothing else; the preview shows 0% of checkout customers." },
      { command: "waf rules", why: "The rule matches the test traffic; the pods drain and the 5xx stop." },
    ],
    lostCheckoutsPerPoint: 150,
    postmortem: {
      question: "Where did the stepped traffic on checkout come from?",
      options: [
        "Customers retrying checkout after a slow payment gateway",
        "A perf agency's k6 run that had the production hostname",
        "A checkout-api autoscaler that removed a pod every minute",
        "A partner integration replaying a day of orders after an outage",
      ],
      answerIndex: 1,
      explanation: {
        cause: "An agency's k6 load test, meant for staging, ran against production checkout.",
        why: "It added 130 requests a second and 20 virtual users a minute to checkout-api, past the ~390 three pods serve while customers need 300, so real checkouts were shed. Its one runner address blocked at the WAF freed the pods at once, before the agency found their script.",
        tell: "waf top: one Linode IP at ~7,800 req/min, and every request carried k6's User-Agent, a sandbox token and X-Test-Run.",
      },
    },
  },
  // ── One hosting range: block the CIDR ─────────────────────────────────────────
  {
    slug: "password-reset-flood",
    title: "Reset emails nobody asked for",
    severity: "SEV2",
    opensAt: [7, 45],
    attack: {
      label: "password reset flood",
      path: "/password/reset",
      requestsPerSecond: 150,
      growthPerSecond: 0.2,
      sources: ranges({ cidr: "161.97.140.0/24", asn: 51167, network: "CONTABO", ips: 180 }),
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.31.0",
    },
    stopShare: 0.95,
    alert: {
      id: "SEC-6034",
      title: "Password reset requests far above baseline",
      rule: "auth.password_reset.volume_anomaly",
      severity: "medium",
      openedAt: -200,
    },
    view: {
      name: "reset-requests",
      description: "Password reset requests and checkout at the edge, by client",
      answer: "202",
      facts: [
        ["reset requests / min", "9,000+", "25"],
        ["distinct emails per source IP (15 min)", "700", "1"],
        ["source IPs, all inside", "161.97.140.0/24", "—"],
      ],
      tell: "python-requests/2.31.0: 180 ClientIPs, every one in 161.97.140.0/24 (ClientASN 51167), each asking for resets for hundreds of different emails; checkout-api answers 202 reset_sent.",
    },
    briefing:
      "Customers are getting password reset emails they never asked for, and checkout-api is shedding requests. Password resets run on the same three pods that take payments. The SIEM has a volume alert open. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Someone is asking for password resets on a mass scale and filling checkout-api's pods. Find where it comes from, stop all of it without blocking customers, and close the alert.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 12%. SEC-6034 (medium) open: password reset volume. Assigned to SOC on-call (you)." },
      { at: 30, from: "Maya Okonkwo · Support", text: "Dozens of tickets: “I got a reset email I didn't ask for, have I been hacked?”" },
      { at: 55, from: MENTOR, text: "Look at the sources. Is it one address, or many from the same place?" },
      { at: 100, from: MENTOR, text: "Blocking the busiest address one at a time is whack-a-mole: there are 180 of them. See what they have in common." },
      { at: 150, from: "Dev Raman · Identity team", text: "Our email provider is throttling us. Real customers' order confirmations are queueing behind the resets." },
      { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout and email both degraded. Where are we?" },
    ],
    hints: [
      "Password resets run on checkout-api. Who is asking for them?",
      "Many addresses, each asking for hundreds of different emails. Group them by network.",
      "Every one sits inside the same hosting /24. Stop the range, not the addresses one by one.",
      "Once it's contained, close the alert for what it was.",
    ],
    suggestions: ["siem show SEC-6034", "siem search reset-requests", "waf top", "waf top --by asn", "waf rules"],
    solution: [
      { command: "siem show SEC-6034", why: "Reset requests hundreds of times above baseline on an endpoint checkout-api serves." },
      { command: "siem search reset-requests", why: "180 addresses, each asking for resets for ~700 emails, every one inside 161.97.140.0/24." },
      { command: "waf top --by asn", why: "AS51167 CONTABO: 180 hosting addresses, one prefix, ~50 requests a minute each. No customer sits in it." },
      { command: "waf block 161.97.140.0/24", why: "Blocks the whole range: all 180 addresses, 0% of checkout customers." },
      { command: 'siem resolve SEC-6034 --disposition true-positive --note "reset flood from Contabo 161.97.140.0/24, blocked at the WAF"', why: "A real attack, contained by the block." },
      { command: "waf rules", why: "The rule matches the flood; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 180,
    postmortem: {
      question: "How should the reset flood have been stopped?",
      options: [
        "Block the busiest address in waf top, then the next, and so on",
        "Block the one Contabo /24 that every flooding address sat in",
        "Turn off password resets for every customer until it stopped",
        "Block the top 500 source IPs on checkout and the reset path",
      ],
      answerIndex: 1,
      explanation: {
        cause: "180 Contabo addresses in one /24 requested password resets for thousands of emails.",
        why: "Resets run on checkout-api. The flood's 150 requests a second, and growing, took the three pods past the ~390 they serve, so checkouts were shed. One block on the /24 stopped every address at once; one address at a time leaves 179 running, and a top-500 block takes hundreds of carrier addresses.",
        tell: "Every flooding IP was inside 161.97.140.0/24 on AS51167, each asking for hundreds of different emails.",
      },
    },
  },
  {
    slug: "signup-farm",
    title: "A thousand new accounts an hour",
    severity: "SEV3",
    opensAt: [13, 20],
    attack: {
      label: "fake sign-ups",
      path: "/accounts",
      requestsPerSecond: 170,
      growthPerSecond: 0.15,
      sources: ranges({ cidr: "206.189.96.0/22", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 240 }),
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.32.3",
    },
    stopShare: 0.95,
    view: {
      name: "signup-sources",
      description: "Account sign-ups and checkout at the edge, by client",
      answer: "201",
      facts: [
        ["sign-ups / min", "10,200+", "14"],
        ["sign-up emails at one throwaway domain", "98%", "0.2%"],
        ["new accounts that ever reach checkout", "0.0%", "38%"],
      ],
      tell: "python-requests/2.32.3: 240 ClientIPs, all in 206.189.96.0/22 (ClientASN 14061), creating accounts at mailpoof.example addresses that never shop.",
    },
    briefing:
      "The growth dashboard shows a record day for new accounts, and checkout-api is shedding requests. Account sign-up runs on the same three pods that take payments. Nobody on the growth team ran a campaign. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Sign-ups are running at hundreds of times normal and checkout is failing with them. Find where the accounts come from and stop all of it, with no customer blocked.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx at 13%. No deploy since yesterday. Assigned to SOC on-call (you)." },
      { at: 25, from: "Hana Sato · Growth", text: "We're at 1,000 new accounts an hour. That's a year's best day and I didn't do anything. Should I be celebrating?" },
      { at: 60, from: MENTOR, text: "Don't celebrate yet. Rank the sources and see where the sign-ups come from." },
      { at: 110, from: MENTOR, text: "Blocking the top 50 would only catch some of them: there are hundreds, all about as busy. Look for what they share." },
      { at: 200, from: "Hana Sato · Growth", text: "Every one of the new emails is at the same domain I've never heard of. Not celebrating." },
    ],
    hints: [
      "Sign-up runs on checkout-api. Where are the new accounts coming from?",
      "Hundreds of addresses, all at about the same rate. What network are they on?",
      "They all sit in one DigitalOcean prefix. Stop the prefix, not a slice of the ranking.",
    ],
    suggestions: ["waf top", "siem search signup-sources", "waf top --by asn", "waf rules"],
    solution: [
      { command: "siem search signup-sources", why: "10,000 sign-ups a minute from 240 addresses, nearly all at one throwaway domain, none ever shopping." },
      { command: "waf top --by asn", why: "AS14061 DIGITALOCEAN-ASN: 240 hosting addresses in 206.189.96.0/22, ~42 requests a minute each." },
      { command: "waf block 206.189.96.0/22", why: "Blocks the whole prefix: all 240 addresses and 0% of checkout customers." },
      { command: "waf rules", why: "The rule matches the sign-up farm; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 200,
    postmortem: {
      question: "What was behind the record sign-up day?",
      options: [
        "A referral link shared on social media without telling Growth",
        "A bot farm in one DigitalOcean /22 creating throwaway accounts",
        "A mobile app bug that created a new account on every app launch",
        "Customers re-registering after a password policy change",
      ],
      answerIndex: 1,
      explanation: {
        cause: "240 DigitalOcean addresses in one /22 created throwaway accounts.",
        why: "Sign-up runs on checkout-api. 170 sign-ups a second, and growing, took the three pods past the ~390 they serve, so checkouts were shed. Every bot sat in one prefix, so one CIDR block stopped all of it; a top-50 block would have caught about a fifth.",
        tell: "All 240 sign-up IPs inside 206.189.96.0/22 on AS14061, nearly every email at one throwaway domain, none ever reaching checkout.",
      },
    },
  },
  {
    slug: "restock-watchers",
    title: "Resellers watching the restock",
    severity: "SEV2",
    opensAt: [8, 55],
    attack: {
      label: "stock monitoring",
      path: "/inventory/availability",
      requestsPerSecond: 140,
      growthPerSecond: 0.25,
      sources: ranges({ cidr: "45.76.32.0/24", asn: 20473, network: "AS-CHOOPA", ips: 120 }),
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    stopShare: 0.95,
    view: {
      name: "availability-checks",
      description: "Stock availability checks and checkout at the edge, by client",
      answer: "200",
      facts: [
        ["availability checks / min", "8,400+", "300"],
        ["checks for the 9 a.m. drop SKUs", "99.6%", "4%"],
        ["checks with a session cookie", "0.0%", "93%"],
      ],
      tell: "Go-http-client/1.1: 120 ClientIPs, all in 45.76.32.0/24 (ClientASN 20473), polling the drop's SKUs with no session; customers' checks come from carriers and ISPs.",
    },
    briefing:
      "A limited sneaker drop goes live at 9:00 and checkout-api is already shedding requests at 8:55. Stock availability checks run on the same three pods that take payments. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Something is polling stock availability far faster than shoppers and filling checkout-api's pods before the drop. Find it and stop it without blocking a customer.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 10% at 08:55. Drop goes live at 09:00. Assigned to SOC on-call (you)." },
      { at: 20, from: "Jules Moreau · Merchandising", text: "Last drop sold out in four seconds and half of it was on resale sites by lunch. Please don't let that happen again." },
      { at: 55, from: MENTOR, text: "Rank the sources by network. Resellers' monitors usually live in one rented range." },
      { at: 110, from: MENTOR, text: "A very low per-IP limit would slow the bots, but it also caps carrier addresses with thousands of phones behind each. Find the range." },
      { at: 200, from: "Maya Okonkwo · Support", text: "Customers waiting for the drop say the page errors when they refresh." },
    ],
    hints: [
      "Availability checks run on checkout-api. Who is polling so hard before the drop?",
      "120 addresses, all on one hosting network. Group them by network.",
      "They share one /24. Stop the range; a tight per-address cap would also catch phone carriers.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search availability-checks", "waf rules"],
    solution: [
      { command: "waf top --by asn", why: "AS20473 AS-CHOOPA (Vultr): 120 hosting addresses in 45.76.32.0/24, ~70 requests a minute each." },
      { command: "siem search availability-checks", why: "Go-http-client polling only the drop's SKUs with no session: resellers' stock monitors." },
      { command: "waf block 45.76.32.0/24", why: "Blocks the whole range and 0% of checkout customers." },
      { command: "waf rules", why: "The rule matches the monitors; the pods drain before the drop opens." },
    ],
    lostCheckoutsPerPoint: 150,
    postmortem: {
      question: "What was filling checkout-api before the drop?",
      options: [
        "Shoppers refreshing the product page as 9:00 got closer",
        "Stock monitors in one Vultr /24 polling the drop's SKUs",
        "The inventory service's cache expiring right before the drop",
        "A push notification that sent every app user in at once",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Resellers' stock monitors in one Vultr /24 polled the drop's availability.",
        why: "Availability runs on checkout-api. 140 checks a second, and growing, took the three pods past the ~390 they serve while customers need 300, so checkouts were shed. One CIDR block stopped every monitor; a 2-a-minute cap would also have throttled carrier addresses with thousands of phones.",
        tell: "All 120 polling IPs inside 45.76.32.0/24 on AS20473, checking only the drop's SKUs, never with a session cookie.",
      },
    },
  },
  {
    slug: "review-spam",
    title: "Five-star reviews by the minute",
    severity: "SEV3",
    opensAt: [19, 15],
    attack: {
      label: "review spam",
      path: "/reviews",
      requestsPerSecond: 125,
      growthPerSecond: 0.3,
      sources: ranges({ cidr: "185.206.224.0/24", asn: 9009, network: "M247", ips: 90 }),
      ja4: PYTHON_JA4,
      userAgent: "Python/3.12 aiohttp/3.9.5",
    },
    stopShare: 0.95,
    view: {
      name: "review-posts",
      description: "Review submissions and checkout at the edge, by client",
      answer: "201",
      facts: [
        ["reviews posted / min", "7,500+", "4"],
        ["reviews with a verified purchase", "0.0%", "88%"],
        ["reviews linking to an outside store", "100%", "0%"],
      ],
      tell: "Python/3.12 aiohttp/3.9.5: 90 ClientIPs, all in 185.206.224.0/24 (ClientASN 9009), posting five-star reviews with a link out and no purchase behind them.",
    },
    briefing:
      "Product pages are filling with five-star reviews that link to another store, and checkout-api is shedding requests. Reviews are posted through the same three pods that take payments. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Review spam is pouring into checkout-api and checkouts are failing with it. Find where it comes from and stop it without turning a customer away.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx at 9%. No deploy today. Assigned to SOC on-call (you)." },
      { at: 25, from: "Priya Das · Content moderation", text: "Our queue went from 40 reviews to 9,000 in twenty minutes. All five stars, all linking to the same knock-off site." },
      { at: 60, from: MENTOR, text: "See who's posting. Group the sources by network; spam crews rent their addresses in bulk." },
      { at: 115, from: MENTOR, text: "A top-500 block would get the spammers and 400-odd customer addresses with them. Something narrower." },
      { at: 210, from: "Maya Okonkwo · Support", text: "A customer says checkout failed and then she saw the spam on the product page. She's asking if we've been hacked." },
    ],
    hints: [
      "Reviews are posted through checkout-api. Who is posting them?",
      "Ninety addresses, all on the same network, none with a purchase behind its reviews.",
      "Stop their range. A top-N list would reach far past the spammers into customers.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search review-posts", "waf rules"],
    solution: [
      { command: "siem search review-posts", why: "7,500 reviews a minute, none from a verified purchase, every one linking out: spam." },
      { command: "waf top --by asn", why: "AS9009 M247: 90 hosting addresses in 185.206.224.0/24, ~80 requests a minute each." },
      { command: "waf block 185.206.224.0/24", why: "Blocks the spammers' range and 0% of checkout customers." },
      { command: "waf rules", why: "The rule matches the spam; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 120,
    postmortem: {
      question: "What should have stopped the review spam?",
      options: [
        "A block on the top 500 source IPs on checkout and reviews",
        "Blocking the one M247 /24 every spamming address came from",
        "Turning off reviews site-wide until moderation caught up",
        "A rate limit of 2 requests a minute on every source address",
      ],
      answerIndex: 1,
      explanation: {
        cause: "90 M247 addresses in one /24 posted five-star spam reviews.",
        why: "Reviews post through checkout-api. 125 a second, and growing, took the three pods past the ~390 they serve, so checkouts were shed. Blocking the one /24 stopped all of it with no customer touched; a top-500 block would also take ~410 customer addresses, carrier NAT among them.",
        tell: "Every spamming IP inside 185.206.224.0/24 on AS9009, no purchase behind any review, every one linking out.",
      },
    },
  },
  // ── Many networks, one TLS client: block the JA4 ──────────────────────────────
  {
    slug: "loyalty-drain",
    title: "Loyalty points leaking by the second",
    severity: "SEV2",
    opensAt: [10, 40],
    attack: {
      label: "loyalty point draining",
      path: "/loyalty/redeem",
      requestsPerSecond: 180,
      growthPerSecond: 0.2,
      sources: ranges(
        { cidr: "18.204.0.0/14", asn: 14618, network: "AMAZON-AES", ips: 1_500 },
        { cidr: "20.42.0.0/16", asn: 8075, network: "MICROSOFT-CORP-MSN-AS-BLOCK", ips: 1_200 },
        { cidr: "34.75.0.0/16", asn: 396982, network: "GOOGLE-CLOUD-PLATFORM", ips: 1_300 },
      ),
      ja4: GO_JA4,
      userAgent: CHROME_UA,
    },
    stopShare: 0.99,
    view: {
      name: "redeem-clients",
      description: "Loyalty redemptions and checkout at the edge, by client and TLS fingerprint",
      answer: "401",
      facts: [
        ["redemption attempts / min", "10,800+", "50"],
        ["attempts with a session from another device", "99%", "1%"],
        ["Chrome User-Agent but no HTTP/2", "100%", "0%"],
      ],
      tell: "Its User-Agent says Chrome 126, but its TLS handshake is Go's (no ALPN, HTTP/1.1). Real Chrome negotiates h2. 4,000 cloud IPs across three providers, a couple of requests each a minute.",
    },
    briefing:
      "Customers are reporting loyalty points spent on gift cards they never bought, and checkout-api is shedding requests. Point redemptions run on the same three pods that take payments. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Someone is redeeming loyalty points from thousands of cloud addresses and filling checkout-api's pods. Stop all of it without blocking customers.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 16%. No deploy today. Assigned to SOC on-call (you)." },
      { at: 25, from: "Maya Okonkwo · Support", text: "Customers say their points were spent on gift cards overnight. Ten tickets in fifteen minutes." },
      { at: 60, from: MENTOR, text: "Thousands of addresses, three clouds, a couple of requests each. No single address or range will do. What do the requests have in common?" },
      { at: 120, from: MENTOR, text: "It calls itself Chrome. Careful: blocking Chrome's fingerprint takes out a third of our customers. Check what its handshake actually is." },
      { at: 200, from: "Noor Haddad · Payments", text: "I've frozen the gift cards bought with points in the last hour. The redemptions keep coming." },
    ],
    hints: [
      "Redemptions run on checkout-api. Who is making them?",
      "Thousands of cloud addresses, each quiet. Ranking or ranges won't single them out.",
      "The User-Agent claims Chrome, but its TLS handshake doesn't match Chrome's. The fingerprint is the thing they all share.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search redeem-clients", "waf rules"],
    solution: [
      { command: "waf top --by asn", why: "4,000 hosting addresses spread over AWS, Azure and Google Cloud, a few requests a minute each." },
      { command: "siem search redeem-clients", why: "A Chrome User-Agent over Go's TLS handshake: one tool, faking its name, from every address." },
      { command: `waf block --ja4 ${GO_JA4}`, why: "Blocks that one TLS client on every address. No customer browser presents it: 0% of checkout." },
      { command: "waf rules", why: "The rule matches the redemptions; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 220,
    postmortem: {
      question: "What did every point-draining request have in common?",
      options: [
        "A Chrome 126 User-Agent, which only the bots were sending",
        "Go's TLS fingerprint, under a User-Agent claiming Chrome",
        "One AWS range that held every one of the 4,000 addresses",
        "A source address that ranked in the top 500 at the edge",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A Go tool from 4,000 cloud addresses redeemed points, posing as Chrome.",
        why: "Redemptions run on checkout-api, and 180 a second took its three pods past capacity. No address or range singled the bots out, but every connection shared Go's JA4, which no customer browser presents. Blocking Chrome's own fingerprint would have cut off a third of customers.",
        tell: "The SIEM view: a Chrome User-Agent on a handshake with no ALPN (HTTP/1.1), Go's JA4, from every attacking address.",
      },
    },
  },
  {
    slug: "address-check-abuse",
    title: "Our address check is someone's free API",
    severity: "SEV2",
    opensAt: [14, 50],
    attack: {
      label: "address validation abuse",
      path: "/address/validate",
      requestsPerSecond: 200,
      growthPerSecond: 0.15,
      sources: ranges(
        { cidr: "149.28.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 2_000 },
        { cidr: "54.36.0.0/16", asn: 16276, network: "OVH", ips: 1_500 },
        { cidr: "51.15.0.0/16", asn: 12876, network: "Online S.A.S.", ips: 1_000 },
        { cidr: "134.209.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 1_500 },
      ),
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.32.3",
    },
    stopShare: 0.99,
    view: {
      name: "address-validations",
      description: "Address validations and checkout at the edge, by client and TLS fingerprint",
      answer: "200",
      facts: [
        ["validations / min", "12,000+", "220"],
        ["validations with a cart in the session", "0.0%", "97%"],
        ["addresses outside our shipping countries", "71%", "0.3%"],
      ],
      tell: "6,000 hosting IPs over four networks, two requests a minute each, no cart, addresses we don't even ship to; every connection the same Python TLS client.",
    },
    briefing:
      "The address validation vendor emailed: we've used a month of lookups in a day. checkout-api, which serves address validation at checkout, is shedding requests. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Something is calling checkout-api's address validation from thousands of addresses and filling the pods. Stop it without blocking customers.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 18%. No deploy since yesterday. Assigned to SOC on-call (you)." },
      { at: 20, from: "Owen Price · Finance", text: "The address vendor bills per lookup. We're at a month's spend today and it's not 3 p.m." },
      { at: 60, from: MENTOR, text: "Six thousand addresses at a couple of requests each won't show in the top of the ranking. Look at what's the same about them." },
      { at: 120, from: MENTOR, text: "A top-500 block won't touch them: they're quieter than our customers. You'd block 500 customer addresses and stop almost nothing." },
      { at: 210, from: "Maya Okonkwo · Support", text: "Customers say the address step at checkout hangs, then fails." },
    ],
    hints: [
      "Address validation runs on checkout-api. Who calls it without ever having a cart?",
      "Thousands of hosting addresses across several networks, each sending very little.",
      "Their User-Agent and TLS fingerprint are the same everywhere, and no browser presents it.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search address-validations", "waf rules"],
    solution: [
      { command: "waf top --by asn", why: "6,000 hosting addresses over Vultr, OVH, Scaleway and DigitalOcean, two requests a minute each." },
      { command: "siem search address-validations", why: "No carts, foreign addresses, and one Python TLS client on every connection." },
      { command: `waf block --ja4 ${PYTHON_JA4}`, why: "Blocks that TLS client everywhere it comes from; no customer browser presents it: 0% of checkout." },
      { command: "waf rules", why: "The rule matches the abuse; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 250,
    postmortem: {
      question: "Why wouldn't a top-500 block have stopped the abuse?",
      options: [
        "The abuse came from carrier NAT that the edge can't rank",
        "Each of 6,000 bots sent less than most customer addresses",
        "The WAF can't block requests on the address validation path",
        "The top 500 addresses were all the vendor's own servers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A Python client on 6,000 hosting addresses used address validation as a free API.",
        why: "Each address sent two requests a minute, less than the hundreds of busiest customer addresses, so a top-500 block takes customers and almost no bots. 200 a second together filled checkout-api. All shared one Python JA4 no browser presents, so blocking it stopped them all.",
        tell: "waf top --by asn: 6,000 hosting IPs at ~2 req/min each, and the SIEM view: one Python TLS fingerprint on every request.",
      },
    },
  },
  {
    slug: "shipping-quote-scrape",
    title: "Rate cards scraped behind a Safari mask",
    severity: "SEV3",
    opensAt: [22, 10],
    attack: {
      label: "shipping quote scraping",
      path: "/shipping/quote",
      requestsPerSecond: 160,
      growthPerSecond: 0.25,
      sources: ranges(
        { cidr: "65.108.0.0/16", asn: 24940, network: "HETZNER-AS", ips: 2_500 },
        { cidr: "129.146.0.0/16", asn: 31898, network: "ORACLE-BMC-31898", ips: 1_500 },
        { cidr: "167.86.0.0/16", asn: 51167, network: "CONTABO", ips: 1_000 },
      ),
      ja4: PYTHON_JA4,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    },
    stopShare: 0.99,
    view: {
      name: "quote-requests",
      description: "Shipping quotes and checkout at the edge, by client and TLS fingerprint",
      answer: "200",
      facts: [
        ["shipping quotes / min", "9,600+", "180"],
        ["quotes for every zone × weight band in order", "yes", "no"],
        ["Safari User-Agent over HTTP/1.1 only", "100%", "0%"],
      ],
      tell: "Its User-Agent says Safari 17.5, but the handshake is Python's (HTTP/1.1 only); real Safari negotiates h2. 5,000 hosting IPs over three networks, two requests each a minute.",
    },
    briefing:
      "checkout-api is shedding requests late in the evening, and shipping quotes are up fifty times. The quote endpoint runs on the same three pods that take payments. Logistics says a competitor launched 'our exact rates minus a pound' last week. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Someone is requesting every shipping quote we offer from thousands of addresses and filling checkout-api. Stop it without blocking customers.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx at 14% at 22:10. No deploy today. Assigned to SOC on-call (you)." },
      { at: 25, from: "Kofi Mensah · Logistics", text: "Someone is pulling every zone and weight band, in order. That's our rate card." },
      { at: 60, from: MENTOR, text: "It claims to be Safari. Don't take its word for it: compare its handshake with real browsers'." },
      { at: 120, from: MENTOR, text: "Blocking Safari's fingerprint would cut off one in six customers and stop none of it, if it isn't really Safari." },
      { at: 210, from: "Maya Okonkwo · Support", text: "Late shoppers say checkout fails at the delivery step." },
    ],
    hints: [
      "Shipping quotes run on checkout-api. Who asks for every zone and weight in order?",
      "Thousands of quiet hosting addresses: no address, range or ranking will catch them all.",
      "It says Safari, but its TLS handshake isn't Safari's. Block what it really is.",
    ],
    suggestions: ["waf top --by asn", "siem search quote-requests", "waf top", "waf rules"],
    solution: [
      { command: "waf top --by asn", why: "5,000 hosting addresses over Hetzner, Oracle Cloud and Contabo, two requests a minute each." },
      { command: "siem search quote-requests", why: "A Safari User-Agent over Python's TLS fingerprint: a scraper in disguise, walking the rate card." },
      { command: `waf block --ja4 ${PYTHON_JA4}`, why: "Blocks the scraper's real TLS client; no customer browser presents it: 0% of checkout." },
      { command: "waf rules", why: "The rule matches the scraper; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 200,
    postmortem: {
      question: "Which signal singled out the rate-card scraper?",
      options: [
        "Its Safari User-Agent, which customers on Macs don't send",
        "Python's TLS fingerprint, under a User-Agent claiming Safari",
        "Its source addresses, which all sat inside one Hetzner /16 range",
        "Its rank: every scraper address sat in the top 500",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A Python scraper on 5,000 hosting addresses pulled the rate card, posing as Safari.",
        why: "Quotes run on checkout-api, and 160 a second took its three pods past capacity. The User-Agent was a lie and the addresses too many and too quiet, but every connection shared Python's JA4. Blocking Safari's real fingerprint would have cut off 17% of customers and none of the scraper.",
        tell: "The SIEM view: a Safari User-Agent on an HTTP/1.1-only handshake, Python's JA4, from every scraping address.",
      },
    },
  },
  // ── A few busy headless browsers on many networks: rate-limit per address ─────
  {
    slug: "cart-hold-bots",
    title: "Bots holding every pair in a cart",
    severity: "SEV2",
    opensAt: [12, 0],
    attack: {
      label: "cart holding",
      path: "/cart/hold",
      requestsPerSecond: 200,
      growthPerSecond: 0.1,
      sources: ranges(
        { cidr: "18.208.0.0/13", asn: 14618, network: "AMAZON-AES", ips: 30 },
        { cidr: "35.196.0.0/15", asn: 396982, network: "GOOGLE-CLOUD-PLATFORM", ips: 20 },
        { cidr: "20.84.0.0/14", asn: 8075, network: "MICROSOFT-CORP-MSN-AS-BLOCK", ips: 15 },
        { cidr: "167.99.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 15 },
      ),
      ja4: CHROMIUM_JA4,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.6478.126 Safari/537.36",
    },
    stopShare: 0.75,
    view: {
      name: "cart-holds",
      description: "Cart holds and checkout at the edge, by client and TLS fingerprint",
      answer: "200",
      facts: [
        ["cart holds / min", "12,000+", "400"],
        ["holds released unpaid after 10 min", "99.8%", "31%"],
        ["requests per source IP / min (p99)", "150", "13"],
      ],
      tell: "HeadlessChrome/126: 80 cloud IPs across four providers, ~150 holds a minute each. Its TLS is real Chromium, the same JA4 as a third of our customers.",
    },
    briefing:
      "The noon drop opened and every size shows 'in someone's cart'. checkout-api, which serves cart holds, is shedding requests. Nothing was deployed. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Headless browsers are holding stock in carts and filling checkout-api's pods. Cut them down to a shopper's pace without blocking customers.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 20% at 12:00. Drop is live. Assigned to SOC on-call (you)." },
      { at: 20, from: "Jules Moreau · Merchandising", text: "Every size says it's in a cart. Nobody's paying for any of them. The holds expire and get grabbed again." },
      { at: 55, from: MENTOR, text: "Eighty addresses over four clouds. They run real Chrome, so the fingerprint is the same as our customers'. What's different is how fast each one goes." },
      { at: 115, from: MENTOR, text: "Don't block Chromium's JA4: that's a third of our shoppers. A shopper holds a cart a few times a minute at most." },
      { at: 210, from: "Maya Okonkwo · Support", text: "Customers are furious: the site says sold out, then the sizes come back ten minutes later." },
    ],
    hints: [
      "Cart holds run on checkout-api. Who is holding carts that fast?",
      "Eighty cloud addresses across four providers, each holding carts every half-second.",
      "Their fingerprint is real Chrome, like customers'. Their pace is the difference: no shopper comes near it.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search cart-holds", "waf rules"],
    solution: [
      { command: "waf top", why: "80 cloud addresses at ~150 requests a minute each; the busiest customer address sends about 13." },
      { command: "siem search cart-holds", why: "HeadlessChrome over real Chromium TLS: a JA4 block would hit 31% of customers." },
      { command: "waf ratelimit 20/1m", why: "Caps every address at 20 a minute: stops ~87% of the holds and no customer comes near the limit." },
      { command: "waf rules", why: "The limit matches the bots and 0% of checkout; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 280,
    postmortem: {
      question: "Why was a per-address limit the right tool for the cart bots?",
      options: [
        "They came from one cloud range that a CIDR block can't express",
        "Real Chromium TLS, but each held carts 10× faster than anyone",
        "Rate limits are cheaper for the WAF to run than block rules",
        "Their User-Agent changed every request, so nothing else matched",
      ],
      answerIndex: 1,
      explanation: {
        cause: "80 headless Chrome bots across four clouds held drop stock in carts.",
        why: "Cart holds run on checkout-api; 200 a second took its three pods past capacity. The bots used real Chromium TLS, so a JA4 block would hit a third of customers, and four providers made ranges awkward. Each sent ~150 a minute, ten times the busiest customer, so 20 a minute stopped them alone.",
        tell: "waf top: 80 hosting IPs at ~150 req/min each, against ~13 for the busiest customer address; JA4 identical to Chromium's.",
      },
    },
  },
  {
    slug: "sms-otp-pumping",
    title: "Text messages to numbers nobody owns",
    severity: "SEV2",
    opensAt: [2, 25],
    attack: {
      label: "SMS OTP pumping",
      path: "/auth/otp/send",
      requestsPerSecond: 180,
      growthPerSecond: 0.1,
      sources: ranges(
        { cidr: "45.32.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 40 },
        { cidr: "51.68.0.0/16", asn: 16276, network: "OVH", ips: 30 },
        { cidr: "95.217.0.0/16", asn: 24940, network: "HETZNER-AS", ips: 30 },
      ),
      ja4: CHROMIUM_JA4,
      userAgent: CHROME_UA,
    },
    stopShare: 0.75,
    alert: {
      id: "SEC-6102",
      title: "SMS OTP sends to premium-rate number ranges",
      rule: "auth.otp.sms_send_velocity",
      severity: "high",
      openedAt: -240,
    },
    view: {
      name: "otp-sends",
      description: "SMS one-time-code sends and checkout at the edge, by client and TLS fingerprint",
      answer: "202",
      facts: [
        ["SMS codes sent / min", "10,800+", "45"],
        ["codes sent to premium-rate prefixes", "96%", "0.1%"],
        ["codes ever entered back", "0.0%", "91%"],
        ["requests per source IP / min (p99)", "108", "13"],
      ],
      tell: "100 hosting IPs over three networks, ~108 sends a minute each, almost all to premium-rate prefixes. Selenium-driven Chrome: the same JA4 as a third of our customers.",
    },
    briefing:
      "The SMS provider paged finance at 2 a.m.: our text-message bill is a month's worth since midnight. The one-time-code endpoint runs on checkout-api, the same three pods that take payments, and checkout is shedding requests. The SIEM has an alert open. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. Something is requesting one-time codes to premium-rate numbers and filling checkout-api's pods. Slow it to a customer's pace without blocking anyone, and close the alert for what it is.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 17%. SEC-6102 (high) open: SMS OTP sends to premium-rate ranges. Assigned to SOC on-call (you)." },
      { at: 20, from: "Owen Price · Finance", text: "Our SMS provider says we've sent 400,000 codes since midnight, mostly to numbers in a handful of countries we don't ship to. Every one costs us." },
      { at: 60, from: MENTOR, text: "That's SMS pumping: someone earns a cut of every premium text we send. Who's asking for the codes, and how fast?" },
      { at: 120, from: MENTOR, text: "A limit of a couple a minute would catch shoppers on shared carrier addresses. Pick a ceiling no customer gets near." },
      { at: 220, from: "Dev Raman · Identity team", text: "If we have to, we can turn off SMS codes, but then nobody can sign in on a new phone. I'd rather you stopped it at the edge." },
    ],
    hints: [
      "Code sends run on checkout-api. Who is asking for them, and to which numbers?",
      "A hundred hosting addresses over three networks, each sending a code every second or so.",
      "Their browser is real Chrome, so fingerprints won't separate them. No customer asks for codes at that pace.",
      "Once it's contained, close the alert for what it was.",
    ],
    suggestions: ["siem show SEC-6102", "siem search otp-sends", "waf top", "waf top --by asn", "waf rules"],
    solution: [
      { command: "siem show SEC-6102", why: "Code sends to premium-rate number ranges far above baseline, on an endpoint checkout-api serves." },
      { command: "siem search otp-sends", why: "~108 sends a minute per address, none ever entered back, over real Chrome TLS: SMS pumping." },
      { command: "waf top", why: "100 hosting addresses at ~108 requests a minute each; the busiest customer address sends about 13." },
      { command: "waf ratelimit 20/1m", why: "Caps every address at 20 a minute: stops ~80% of the pumping and no customer comes near the limit." },
      { command: 'siem resolve SEC-6102 --disposition true-positive --note "SMS OTP pumping from Vultr, OVH and Hetzner, rate limited per IP"', why: "A real attack, now contained." },
      { command: "waf rules", why: "The limit matches the pumping and 0% of checkout; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 260,
    postmortem: {
      question: "Who profits from an SMS OTP pumping attack?",
      options: [
        "Customers, who get free codes they can resell to other shoppers",
        "Whoever gets a cut of the premium-rate texts we're billed for",
        "Our SMS provider, which earns more the more codes we send",
        "Competitors, who want our checkout down during their own sale",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Bots requested one-time codes to premium-rate numbers to earn a share of the fees.",
        why: "Code sends run on checkout-api; 180 a second took its three pods past capacity. The bots drove real Chrome, so a JA4 block would hit a third of customers, but each sent ~108 a minute, eight times the busiest customer. A 20-a-minute limit cut most of it and touched no one.",
        tell: "The SIEM view: 96% of codes to premium-rate prefixes, none ever entered back, ~108 sends a minute per address.",
      },
    },
  },
  {
    slug: "search-hammer",
    title: "Search typed faster than anyone types",
    severity: "SEV3",
    opensAt: [17, 30],
    attack: {
      label: "search scraping",
      path: "/search",
      requestsPerSecond: 150,
      growthPerSecond: 0.15,
      sources: ranges(
        { cidr: "139.162.0.0/16", asn: 63949, network: "AKAMAI-LINODE-AP", ips: 20 },
        { cidr: "152.70.0.0/16", asn: 31898, network: "ORACLE-BMC-31898", ips: 15 },
        { cidr: "47.88.0.0/16", asn: 45102, network: "ALIBABA-CN-NET", ips: 15 },
      ),
      ja4: CHROMIUM_JA4,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.6422.26 Safari/537.36",
    },
    stopShare: 0.75,
    view: {
      name: "search-queries",
      description: "Search queries and checkout at the edge, by client and TLS fingerprint",
      answer: "200",
      facts: [
        ["searches / min", "9,000+", "700"],
        ["queries that are a single brand name", "94%", "11%"],
        ["requests per source IP / min (p99)", "180", "13"],
      ],
      tell: "HeadlessChrome/125 (Playwright): 50 cloud IPs across three providers, ~180 searches a minute each. Real Chromium TLS, the same JA4 as a third of customers.",
    },
    briefing:
      "checkout-api is shedding requests at 5:30 p.m., and search traffic has tripled with no campaign running. Search runs on the same three pods that take payments. Lena, a senior SOC analyst, is on the call.",
    roleBriefing:
      "SOC on-call: waf and siem. A few dozen headless browsers are searching far faster than any shopper and filling checkout-api's pods. Bring them down to human speed without blocking a customer.",
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx at 12% at 17:30. No deploy today. Assigned to SOC on-call (you)." },
      { at: 25, from: "Leah Brandt · Search team", text: "Search QPS is triple normal and the queries are just brand names, one after another. Nobody searches like that." },
      { at: 60, from: MENTOR, text: "Fifty addresses over three clouds, real Chrome under the hood. A shopper searches a few times a minute; look at how fast each of these goes." },
      { at: 120, from: MENTOR, text: "A top-500 block would get the fifty and 450 customer addresses with them. Use their pace, not a list." },
      { at: 210, from: "Maya Okonkwo · Support", text: "After-work shoppers say search is slow and checkout fails sometimes." },
    ],
    hints: [
      "Search runs on checkout-api. Who is searching that much?",
      "Fifty cloud addresses on three providers, each searching several times a second.",
      "They run real Chromium, so the fingerprint matches customers'. What sets them apart is their pace.",
    ],
    suggestions: ["waf top", "waf top --by asn", "siem search search-queries", "waf rules"],
    solution: [
      { command: "waf top", why: "50 cloud addresses at ~180 searches a minute each; the busiest customer address sends about 13." },
      { command: "siem search search-queries", why: "HeadlessChrome over Chromium TLS: blocking the fingerprint would hit 31% of customers." },
      { command: "waf ratelimit 30/1m", why: "Caps every address at 30 a minute: stops ~83% of the scraping and no customer comes near it." },
      { command: "waf rules", why: "The limit matches the scrapers and 0% of checkout; the pods drain within seconds." },
    ],
    lostCheckoutsPerPoint: 200,
    postmortem: {
      question: "What set the search scrapers apart from customers?",
      options: [
        "Their TLS fingerprint, which no real Chrome install presents",
        "Each address searched ~180 times a minute, past any shopper",
        "They all came from a single Linode /16 that held every bot",
        "Their requests carried no User-Agent header at all",
      ],
      answerIndex: 1,
      explanation: {
        cause: "50 Playwright browsers on three clouds scraped search by brand name.",
        why: "Search runs on checkout-api; 150 queries a second took its three pods past capacity. The bots ran real Chromium, so a JA4 block would hit a third of customers. Each searched ~180 times a minute against ~13 for the busiest customer, so a 30-a-minute limit stopped most of it alone.",
        tell: "waf top: 50 hosting IPs at ~180 req/min each against ~13 for the busiest customer; JA4 identical to Chromium's.",
      },
    },
  },
];

export const SECURITY_TIER1_INCIDENTS: readonly Scenario[] = ROWS.map(scenarioFrom);
