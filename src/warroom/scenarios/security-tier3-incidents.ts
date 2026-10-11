import type { CommsMessage, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, SiemAlert } from "../sim/commerce.ts";
import { BROWSER_JA4, DISTINCT_SOURCE_IPS } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

/**
 * Security tier 3: the attack is real and the obvious containment backfires on customers. Three
 * traps the edge already models: a SOAR playbook that blocks the top N source IPs (carrier NAT sits at
 * the top), a per-IP rate limit tight enough to touch slow bots (it touches carriers first), and a block
 * on the browser fingerprint the bots only claim in their User-Agent.
 */

/** FoxIO ja4plus-mapping.csv: GoLang. No ALPN, so HTTP/1.1 and Go's default User-Agent for it. */
const GO_JA4 = "t13d190900_9dc949149365_97f8aa674fd9";
/** FoxIO ja4plus-mapping.csv: Python. TLS 1.3, 43 ciphers, 12 extensions, ALPN http/1.1 only. */
const PYTHON_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
const TOOL_NAMES: Readonly<Record<string, string>> = { [GO_JA4]: "GoLang", [PYTHON_JA4]: "Python" };

const SAFARI_JA4 = "t13d2014h2_a09f3c656075_14788d8d241b";
const CHROMIUM_JA4 = "t13d1517h2_8daaf6152771_cb7bf5808d99";
const FIREFOX_JA4 = "t13d1715h2_5b57614c22b0_7121afd63204";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WINDOWS_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const FIREFOX_ESR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const MARLOW_IOS = "Marlow/7.3.0 (com.marlow.shop; build:7301; iOS 18.6.2) Alamofire/5.10.2";

/** A blended percentage (what the bots show, what customers show), or a fixed now/baseline pair. */
type Signal = readonly [label: string, attack: number, baseline: number] | readonly [label: string, now: string, baseline: string];

type View = {
  readonly name: string;
  readonly description: string;
  readonly heading: string;
  /** Customer requests a minute on the attacked path at the 7-day baseline. */
  readonly baselinePerMinute: number;
  readonly signals: readonly Signal[];
  /** Adds requests grouped by TLS fingerprint; the User-Agent the bots claim is shown beside theirs. */
  readonly byJa4?: { readonly claimed: string };
};

type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAtSecondOfDay: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly attack: Attack;
  readonly alert: Omit<SiemAlert, "autoContainAt" | "containTopIps" | "resolution">;
  /** The SOAR auto-contain block: top N source IPs at second `at`. Absent: the alert has no playbook. */
  readonly playbook?: { readonly topIps: number; readonly at: number };
  readonly view: View;
  readonly suggestions: readonly string[];
  readonly lostCheckoutsPerPoint: number;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

function attackerIps(attack: Attack): number {
  return attack.sources.kind === "ranges" ? attack.sources.ranges.reduce((sum, range) => sum + range.ips, 0) : attack.sources.ips;
}

function evidence(row: Row) {
  const { attack, view } = row;
  return (state: ClusterState): string[] => {
    const { commerce } = state;
    if (!commerce) return [];
    const { perMinute, passed } = attackAtEdge(commerce, state.t);
    const bots = perMinute * passed;
    const people = view.baselinePerMinute;
    const isAttacking = bots > 1;
    const signalRow = ([label, now, baseline]: Signal): string[] =>
      typeof now === "number" && typeof baseline === "number" ? [label, percent((baseline * people + now * bots) / (people + bots)), percent(baseline)] : [label, isAttacking ? String(now) : String(baseline), String(baseline)];
    const ips = attackerIps(attack);
    const lines = [`${view.heading} · POST ${attack.path} · last 5 min`, ...table([["METRIC", "NOW", "7-DAY BASELINE"], ...view.signals.map(signalRow)])];
    if (attack.sources.kind === "ranges") {
      lines.push(
        "",
        `POST ${attack.path} by ClientASN · last 5 min`,
        ...table([
          ["ClientASN", "NETWORK", "ClientIP (distinct)", "REQ/MIN PAST WAF", "ClientRequestUserAgent"],
          ...attack.sources.ranges.map((range) => [String(range.asn), range.network, count(range.ips), count((bots * range.ips) / ips), attack.userAgent]),
          ["21928 · 22394 · 20057 · 7922", "carriers and home ISPs", count(DISTINCT_SOURCE_IPS), count(people), "Marlow apps, Safari, Chrome, Firefox"],
        ]),
      );
    }
    if (view.byJa4) {
      const listed = BROWSER_JA4.reduce((sum, entry) => sum + entry.customerShare, 0);
      lines.push(
        "",
        `POST ${attack.path} by JA4 · last 5 min (fingerprint names: FoxIO JA4 database)`,
        ...table([
          ["JA4", "KNOWN AS", "TOP USER-AGENT", "REQ/MIN PAST WAF", "ClientIP (distinct)"],
          [attack.ja4, TOOL_NAMES[attack.ja4] ?? "unknown", view.byJa4.claimed, count(bots), count(ips)],
          ...BROWSER_JA4.map((entry) => [entry.ja4, entry.client, entry.client, count(people * entry.customerShare), count(DISTINCT_SOURCE_IPS * entry.customerShare)]),
          ["(other: Marlow apps, unlisted)", "—", "Marlow/7.3.0 (com.marlow.shop; …)", count(people * (1 - listed)), count(DISTINCT_SOURCE_IPS * (1 - listed))],
        ]),
      );
    }
    return lines;
  };
}

function incident(row: Row): Scenario {
  const seed = `sec-t3-${row.slug}`;
  const alert: SiemAlert = { ...row.alert, autoContainAt: row.playbook?.at ?? null, containTopIps: row.playbook?.topIps ?? 0, resolution: null };
  return {
    id: seed,
    tier: 3,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["security"],
    roleBriefings: { security: row.roleBriefing },
    opensAtSecondOfDay: row.opensAtSecondOfDay,
    seed,
    initialState: () => attackedCluster(seed, checkoutCommerce({ attack: row.attack, alerts: [alert] })),
    isRootCauseFixed: (state) => isAttackStopped(state, 0.99),
    objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), alertClosedAs(state.commerce, alert.id, "true-positive")] : []),
    evidence: [{ tool: "siem", name: row.view.name, description: row.view.description, run: evidence(row) }],
    suggestions: { security: row.suggestions },
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [],
    comms: row.comms,
    postmortem: row.postmortem,
    hints: row.hints,
    solution: { security: row.solution },
  };
}

const at = (hours: number, minutes: number) => hours * 3600 + minutes * 60;

const ROWS: readonly Row[] = [
  {
    slug: "gift-card-enumeration",
    title: "Gift cards guessed from 3,200 droplets",
    severity: "SEV2",
    opensAtSecondOfDay: at(10, 40),
    briefing:
      "Someone is walking gift card numbers against the balance check, which runs on checkout-api, from thousands of small cloud servers. Checkout is shedding requests. SEC-6110 is right about the enumeration, and its SOAR playbook will block the top 400 source IPs in five minutes.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6110 is real gift card enumeration on POST /gift-cards/balance. Its playbook auto-blocks the top 400 source IPs at 10:45. Stop the guessing yourself, and make sure the playbook's block never runs.",
    attack: {
      label: "gift card enumeration",
      path: "/gift-cards/balance",
      requestsPerSecond: 170,
      growthPerSecond: 0.04,
      sources: {
        kind: "ranges",
        ranges: [
          { cidr: "159.89.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 1_800 },
          { cidr: "64.225.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 1_400 },
        ],
      },
      ja4: PYTHON_JA4,
      userAgent: "python-httpx/0.27.2",
    },
    alert: {
      id: "SEC-6110",
      title: "Gift card enumeration: sequential card numbers on POST /gift-cards/balance",
      rule: "giftcards.balance.enumeration_velocity",
      severity: "high",
      openedAt: -150,
    },
    playbook: { topIps: 400, at: 300 },
    view: {
      name: "giftcard-checks",
      description: "Gift card balance checks against the baseline, and by network",
      heading: "Gift card balance checks",
      baselinePerMinute: 90,
      signals: [
        ["card numbers checked per source IP (p99)", "47", "1"],
        ["checks for a card number that doesn't exist", 0.97, 0.04],
        ["numbers within 10 of the previous check", 0.88, 0.001],
        ["requests with no session cookie", 1, 0.03],
      ],
    },
    suggestions: ["siem show SEC-6110", "siem search giftcard-checks", "waf top", "waf top --by asn", "siem resolve SEC-6110 --disposition true-positive"],
    lostCheckoutsPerPoint: 260,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 17%. SEC-6110 (high): gift card enumeration on POST /gift-cards/balance. Assigned to SOC on-call (you)." },
      { at: 20, from: "SOC · SOAR", text: "SEC-6110: playbook auto-contain will block the top 400 source IPs at 10:45 unless the alert is resolved." },
      { at: 75, from: "Nadia Brooks · Gift cards", text: "Three customers already found their holiday gift cards drained. Whoever this is, they're finding live numbers." },
      { at: 130, from: "Sam Tan · Eng manager", text: "Top 400 IPs sounds like exactly the guys hammering us. Let SOAR have it." },
      { at: 190, from: "Lena Park · SOC lead", text: "Each of those servers checks a card every 20 seconds or so. Count how many shoppers send more than that before you trust a top-N list." },
      { at: 260, from: "Maya Okonkwo · Support", text: "Checkout fails for roughly one customer in six right now." },
    ],
    hints: [
      "The enumeration is real. Ask who sits at the top of the source list, not whether there's an attack.",
      "A single cloud server here checks a few cards a minute. A phone carrier's NAT address carries far more than that.",
      "The guessers' addresses are scattered one by one but grouped by network. Read them as a group.",
      "Closing the alert as a plain true positive runs its playbook. It needs to know something already contains the attack.",
    ],
    solution: [
      { command: "siem show SEC-6110", why: "Real enumeration on the balance check, and a top-400 block scheduled for 10:45." },
      { command: "siem search giftcard-checks", why: "47 card numbers per address, almost all of them nonexistent, in near-sequence: guessing, not shoppers." },
      { command: "waf top", why: "The busiest addresses are carriers at ~13 a minute; each droplet sends about 3, below ~360 customer addresses." },
      { command: "waf top --by asn", why: "3,200 addresses in DigitalOcean, inside two prefixes: 159.89.0.0/16 and 64.225.0.0/16." },
      { command: "waf block 159.89.0.0/16", why: "Stops the first pool; the preview shows 0% of checkout." },
      { command: "waf block 64.225.0.0/16", why: "Stops the second pool, again 0% of checkout." },
      {
        command: 'siem resolve SEC-6110 --disposition true-positive --contained-by r-0003 --note "gift card enumeration from AS14061, blocked by range"',
        why: "True positive, contained by our own rule (r-0003 from `waf rules`), so the playbook's top-400 block never runs.",
      },
      { command: "waf rules", why: "Both range rules match the guessing and none of checkout; the 5xx drain." },
    ],
    postmortem: {
      question: "What made SEC-6110's top-400 block the wrong containment?",
      options: [
        "Each droplet sent less than ~360 customer addresses did",
        "The guessers rotated to fresh droplets every few minutes",
        "Guessed gift card numbers can't be revoked after the fact",
        "Its block covered /checkout but not the gift card balance path",
      ],
      answerIndex: 0,
      explanation: {
        cause: "3,200 droplets at ~3 checks a minute each ranked below ~360 carrier NAT addresses.",
        why: "A top-400 list is mostly phone carriers, where one address fronts thousands of shoppers: the playbook would have blocked about 35% of customers and almost no guessers. The guessers shared two DigitalOcean /16s, so blocking those ranges stopped all of them and no customer.",
        tell: "waf top had carriers at ~13 a minute above droplets at 3; waf top --by asn put 3,200 addresses in AS14061, inside 159.89.0.0/16 and 64.225.0.0/16.",
      },
    },
  },
  {
    slug: "promo-code-brute-force",
    title: "Promo codes brute-forced from OVH",
    severity: "SEV2",
    opensAtSecondOfDay: at(8, 5),
    briefing:
      "The Autumn Sale's single-use promo codes are being brute-forced on POST /cart/promo from an OVH range, and checkout-api is shedding requests. SEC-6124 is real; its SOAR playbook will block the top 600 source IPs at 08:09 unless someone closes it first.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6124 is genuine promo brute force against /cart/promo. Four minutes until SOAR blocks the top 600 source IPs. Contain the brute force your own way and stop the playbook.",
    attack: {
      label: "promo code brute force",
      path: "/cart/promo",
      requestsPerSecond: 180,
      growthPerSecond: 0.05,
      sources: { kind: "ranges", ranges: [{ cidr: "51.38.0.0/16", asn: 16276, network: "OVH", ips: 3_100 }] },
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    alert: {
      id: "SEC-6124",
      title: "Promo brute force: invalid code rate far above baseline on POST /cart/promo",
      rule: "growth.promo.invalid_code_ratio",
      severity: "high",
      openedAt: -90,
    },
    playbook: { topIps: 600, at: 240 },
    view: {
      name: "promo-attempts",
      description: "Promo code attempts against the baseline, and by network",
      heading: "Promo code attempts",
      baselinePerMinute: 260,
      signals: [
        ["codes tried per cart (p99)", "212", "2"],
        ["codes rejected as unknown", 0.995, 0.11],
        ["codes matching AUTUMN-[A-Z0-9]{6}", 0.99, 0.62],
        ["carts with no item added first", 0.98, 0.01],
      ],
    },
    suggestions: ["siem show SEC-6124", "siem search promo-attempts", "waf top", "waf top --by asn", "siem resolve SEC-6124 --disposition true-positive"],
    lostCheckoutsPerPoint: 260,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 19%. SEC-6124 (high): promo brute force on POST /cart/promo. Assigned to SOC on-call (you)." },
      { at: 15, from: "SOC · SOAR", text: "SEC-6124: playbook auto-contain will block the top 600 source IPs at 08:09 unless the alert is resolved." },
      { at: 60, from: "Lena Ortiz · Growth", text: "Eleven AUTUMN codes redeemed in the last ten minutes by carts nobody browsed. They're finding the real ones." },
      { at: 110, from: "Sam Tan · Eng manager", text: "SOAR is set to 600 because we tuned it after last year's sale. Trust the tuning?" },
      { at: 160, from: "Lena Park · SOC lead", text: "That tuning was for one noisy scraper. Six hundred addresses at 8am is the whole commute on mobile data." },
      { at: 210, from: "Maya Okonkwo · Support", text: "People are tweeting that checkout breaks on the first try." },
    ],
    hints: [
      "Nobody doubts the brute force. What would the scheduled containment actually hit?",
      "Six hundred addresses is a lot of morning commuters behind carrier NAT. Compare their rate with one attacking address.",
      "The attackers rented one block of addresses from one provider.",
      "Tell the alert what contains the attack, or it will contain it its own way.",
    ],
    solution: [
      { command: "siem show SEC-6124", why: "Real brute force on /cart/promo, and a top-600 block at 08:09." },
      { command: "siem search promo-attempts", why: "Hundreds of AUTUMN- codes per cart, nearly all unknown, carts with nothing in them." },
      { command: "waf top", why: "Carriers lead at ~13 a minute; each OVH address sends ~3.5, under ~340 customer addresses." },
      { command: "waf top --by asn", why: "All 3,100 attacking addresses are in AS16276 OVH, inside 51.38.0.0/16." },
      { command: "waf block 51.38.0.0/16", why: "Stops the brute force; the preview shows 0% of checkout." },
      {
        command: 'siem resolve SEC-6124 --disposition true-positive --contained-by r-0003 --note "promo brute force from OVH 51.38.0.0/16"',
        why: "Closes the true positive on our range rule (r-0003), cancelling the top-600 block.",
      },
      { command: "waf rules", why: "r-0003 matches the brute force and 0% of checkout; the 5xx drain." },
    ],
    postmortem: {
      question: "Why was a top-600 block tuned last year wrong for this attack?",
      options: [
        "Its top 600 is carrier NAT, busier than any OVH address",
        "OVH addresses are shared with our own CDN origin servers",
        "Promo brute force needs a per-code limit, not an IP block",
        "The playbook's block would expire before the Autumn Sale ended",
      ],
      answerIndex: 0,
      explanation: {
        cause: "3,100 OVH addresses at ~3.5 codes a minute ranked below ~340 carrier NAT addresses.",
        why: "The tuning came from one loud scraper. Here each attacker was quiet and the top of the list was morning commuters behind carrier NAT, so the playbook would have blocked a third of customers and under a tenth of the attack. One /16 held every attacker.",
        tell: "waf top showed carriers far above any OVH address, and waf top --by asn put all 3,100 attacking addresses in 51.38.0.0/16.",
      },
    },
  },
  {
    slug: "referral-signup-farm",
    title: "A signup farm SOAR wants to stop",
    severity: "SEV2",
    opensAtSecondOfDay: at(13, 20),
    briefing:
      "A bot farm is creating accounts on POST /signup to harvest the $10 referral credit, from two Vultr ranges, and the extra load has checkout-api shedding requests. SEC-6131's SOAR playbook will block the top 300 source IPs in six minutes.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6131 is a genuine referral-abuse signup farm. SOAR blocks the top 300 source IPs at 13:26. Contain the farm without turning shoppers away, and make sure that block never runs.",
    attack: {
      label: "fake signups",
      path: "/signup",
      requestsPerSecond: 160,
      growthPerSecond: 0.035,
      sources: {
        kind: "ranges",
        ranges: [
          { cidr: "45.32.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 2_200 },
          { cidr: "149.28.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 1_600 },
        ],
      },
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.32.3",
    },
    alert: {
      id: "SEC-6131",
      title: "Referral abuse: new accounts from one referral code far above baseline",
      rule: "identity.signup.referral_velocity",
      severity: "high",
      openedAt: -200,
    },
    playbook: { topIps: 300, at: 360 },
    view: {
      name: "signup-velocity",
      description: "New accounts against the baseline, and by network",
      heading: "New accounts",
      baselinePerMinute: 70,
      signals: [
        ["signups using referral code MAYA-3F9K", 0.99, 0.0004],
        ["email domains on a disposable list", 0.94, 0.02],
        ["signups with no page view before POST", 1, 0.03],
        ["accounts per device fingerprint (p99)", "1 (no device data)", "1"],
      ],
    },
    suggestions: ["siem show SEC-6131", "siem search signup-velocity", "waf top", "waf top --by asn", "siem resolve SEC-6131 --disposition true-positive"],
    lostCheckoutsPerPoint: 250,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 15%. SEC-6131 (high): referral signup velocity. Assigned to SOC on-call (you)." },
      { at: 25, from: "SOC · SOAR", text: "SEC-6131: playbook auto-contain will block the top 300 source IPs at 13:26 unless the alert is resolved." },
      { at: 70, from: "Ivy Chen · Growth", text: "One referral code has earned $41,000 in credit since noon. That's a farm cashing out." },
      { at: 140, from: "Sam Tan · Eng manager", text: "Three hundred is a small number. How much harm can it do?" },
      { at: 200, from: "Lena Park · SOC lead", text: "Small number, big addresses. Look at what the top 300 actually are before the timer does it for you." },
      { at: 280, from: "Maya Okonkwo · Support", text: "Lunchtime orders are failing and customers are calling it." },
    ],
    hints: [
      "The farm is real. The playbook's target list is the question.",
      "The top 300 sources on a weekday lunchtime are a handful of very crowded addresses.",
      "Every fake signup came from one hosting provider, through two blocks of its addresses.",
      "A true positive with nothing recorded as containment runs the playbook.",
    ],
    solution: [
      { command: "siem show SEC-6131", why: "Genuine referral abuse, with a top-300 block scheduled at 13:26." },
      { command: "siem search signup-velocity", why: "One referral code, disposable inboxes, no page views: a farm." },
      { command: "waf top", why: "The top is carriers at ~13 a minute; each farm address sends ~2.5, below hundreds of customers." },
      { command: "waf top --by asn", why: "3,800 farm addresses in AS20473 (Vultr), inside 45.32.0.0/16 and 149.28.0.0/16." },
      { command: "waf block 45.32.0.0/16", why: "Stops the larger pool; 0% of checkout." },
      { command: "waf block 149.28.0.0/16", why: "Stops the rest; 0% of checkout." },
      {
        command: 'siem resolve SEC-6131 --disposition true-positive --contained-by r-0003 --note "referral signup farm, Vultr ranges blocked"',
        why: "True positive, contained by r-0003, so the top-300 block never runs.",
      },
      { command: "waf rules", why: "Both rules match only the farm; the 5xx drain." },
    ],
    postmortem: {
      question: "Why would blocking only 300 addresses have hurt checkout?",
      options: [
        "The top 300 were carrier NAT, each in front of many shoppers",
        "The farm's accounts would keep their referral credit anyway",
        "Vultr reassigns addresses, so the block lands on new tenants",
        "SOAR blocks for an hour, too short for a farm that keeps going",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Farm addresses sent ~2.5 signups a minute, under ~400 carrier NAT addresses.",
        why: "A few hundred addresses sounds surgical, but checkout's busiest sources are carrier NAT, each one a crowd of phones. The playbook's 300 would all have been customers, roughly 30% of them, and no farm address. The farm sat in two Vultr /16s.",
        tell: "waf top showed only carriers and ISPs in its first hundreds; waf top --by asn put 3,800 addresses in AS20473, inside 45.32.0.0/16 and 149.28.0.0/16.",
      },
    },
  },
  {
    slug: "sneaker-drop-hoarding",
    title: "Scalpers before the sneaker drop",
    severity: "SEV1",
    opensAtSecondOfDay: at(9, 58),
    briefing:
      "Two minutes before the limited sneaker drop, scalper bots on AWS are holding inventory with POST /cart/items, and checkout-api is shedding requests. SEC-6140 is real, and SOAR will block the top 800 source IPs at 10:05 unless it's closed first.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6140 is genuine cart hoarding before the 10:00 drop. Its playbook blocks the top 800 source IPs at 10:05, right as real buyers pile in. Stop the scalpers and keep the playbook's block from running.",
    attack: {
      label: "cart hoarding",
      path: "/cart/items",
      requestsPerSecond: 230,
      growthPerSecond: 0.06,
      sources: {
        kind: "ranges",
        ranges: [
          { cidr: "3.92.0.0/16", asn: 16509, network: "AMAZON-02", ips: 2_800 },
          { cidr: "18.208.0.0/16", asn: 16509, network: "AMAZON-02", ips: 1_500 },
        ],
      },
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    alert: {
      id: "SEC-6140",
      title: "Inventory hoarding: one SKU held in carts far above sell-through",
      rule: "catalog.cart.limited_sku_hold_ratio",
      severity: "critical",
      openedAt: -60,
    },
    playbook: { topIps: 800, at: 420 },
    view: {
      name: "cart-holds",
      description: "Cart holds on the drop SKU against the baseline, and by network",
      heading: "Cart holds on SKU AJ1-LOST-FOUND",
      baselinePerMinute: 150,
      signals: [
        ["drop-SKU units held per cart (p99)", "2 (the limit)", "1"],
        ["holds released unpaid after 10 min", 0.97, 0.18],
        ["carts created and filled in < 300 ms", 0.99, 0.0],
        ["sessions with no product page view", 1, 0.04],
      ],
    },
    suggestions: ["siem show SEC-6140", "siem search cart-holds", "waf top", "waf top --by asn", "siem resolve SEC-6140 --disposition true-positive"],
    lostCheckoutsPerPoint: 320,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 26%. SEC-6140 (critical): limited SKU hold ratio. Assigned to SOC on-call (you)." },
      { at: 20, from: "SOC · SOAR", text: "SEC-6140: playbook auto-contain will block the top 800 source IPs at 10:05 unless the alert is resolved." },
      { at: 50, from: "Theo Grant · Merchandising", text: "Every pair of the drop is already sitting in someone's cart and the drop hasn't opened. Not one has been paid for." },
      { at: 100, from: "Elena Ruiz · VP Engineering", text: "The drop email went to 400,000 people. Whatever we do, buyers on their phones have to get through." },
      { at: 170, from: "Sam Tan · Eng manager", text: "800 IPs at 10:05 lines up nicely with the drop. Let it run." },
      { at: 240, from: "Lena Park · SOC lead", text: "At 10:05 the busiest addresses on the site will be phones on carrier NAT, not scalpers." },
    ],
    hints: [
      "The scalpers are real. Who will be the busiest addresses at the moment the playbook fires?",
      "One scalper address adds a few carts a minute. One carrier address carries a crowd.",
      "Their addresses come from one cloud provider, in two blocks.",
      "The alert needs to be closed in a way that tells it the attack is already contained.",
    ],
    solution: [
      { command: "siem show SEC-6140", why: "Real hoarding on the drop SKU, and a top-800 block scheduled at 10:05." },
      { command: "siem search cart-holds", why: "Carts filled in under 300 ms with no product view, released unpaid: scalper bots." },
      { command: "waf top", why: "Carriers lead at ~13 a minute; each scalper address adds ~3.2, below hundreds of customers." },
      { command: "waf top --by asn", why: "4,300 addresses in AS16509 AMAZON-02, inside 3.92.0.0/16 and 18.208.0.0/16." },
      { command: "waf block 3.92.0.0/16", why: "Stops the first pool; 0% of checkout." },
      { command: "waf block 18.208.0.0/16", why: "Stops the second; 0% of checkout." },
      {
        command: 'siem resolve SEC-6140 --disposition true-positive --contained-by r-0003 --note "scalper bots on AWS, ranges blocked before drop"',
        why: "True positive, contained by r-0003; the top-800 block is cancelled before the drop opens.",
      },
      { command: "waf rules", why: "Both rules hit only the scalpers; the 5xx drain." },
    ],
    postmortem: {
      question: "What would the top-800 block have done at 10:05?",
      options: [
        "Blocked mostly drop buyers on carrier NAT, few scalpers",
        "Blocked every scalper but released their held carts too late",
        "Nothing, because AWS addresses are exempt from SOAR blocks",
        "Blocked the drop page's CDN, so nobody could load the product",
      ],
      answerIndex: 0,
      explanation: {
        cause: "4,300 scalper addresses at ~3 holds a minute each ranked below ~360 carrier NAT addresses.",
        why: "Carrier NAT puts thousands of phones behind one address, so the head of the source list is customers. A top-800 block would have taken ~34% of customers and about a tenth of the scalpers, right when the drop opened. Blocking the two AWS /16s stopped every scalper and no buyer.",
        tell: "waf top --by asn put 4,300 addresses in AS16509 inside 3.92.0.0/16 and 18.208.0.0/16, each sending less than the busiest carriers in waf top.",
      },
    },
  },
  {
    slug: "sms-pumping-reset",
    title: "SMS pumping through password reset",
    severity: "SEV2",
    opensAtSecondOfDay: at(2, 35),
    briefing:
      "Bots are requesting password-reset codes by SMS to premium-rate numbers on POST /password/reset, from Hetzner and Contabo servers. The traffic has checkout-api shedding requests and the SMS bill climbing. SEC-6152's playbook will block the top 250 source IPs at 02:40.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6152 is genuine SMS toll fraud through password reset. SOAR blocks the top 250 source IPs at 02:40. Stop the pumping without blocking the night's shoppers, and keep the playbook's block from running.",
    attack: {
      label: "SMS pumping",
      path: "/password/reset",
      requestsPerSecond: 165,
      growthPerSecond: 0.04,
      sources: {
        kind: "ranges",
        ranges: [
          { cidr: "135.181.0.0/16", asn: 24940, network: "HETZNER-AS", ips: 1_900 },
          { cidr: "161.97.0.0/16", asn: 51167, network: "CONTABO", ips: 1_300 },
        ],
      },
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.31.0",
    },
    alert: {
      id: "SEC-6152",
      title: "SMS pumping: reset codes to premium-rate prefixes on POST /password/reset",
      rule: "identity.sms.premium_prefix_velocity",
      severity: "high",
      openedAt: -240,
    },
    playbook: { topIps: 250, at: 300 },
    view: {
      name: "sms-resets",
      description: "SMS reset codes against the baseline, and by network",
      heading: "Password-reset SMS",
      baselinePerMinute: 40,
      signals: [
        ["destination numbers on premium-rate prefixes", 0.96, 0.002],
        ["destinations in +882 / +979 ranges", 0.71, 0.0],
        ["reset codes ever entered", 0.0, 0.81],
        ["resets for phone numbers with no account", 0.99, 0.06],
      ],
    },
    suggestions: ["siem show SEC-6152", "siem search sms-resets", "waf top", "waf top --by asn", "siem resolve SEC-6152 --disposition true-positive"],
    lostCheckoutsPerPoint: 250,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 16%. SEC-6152 (high): SMS to premium-rate prefixes. Assigned to SOC on-call (you)." },
      { at: 20, from: "SOC · SOAR", text: "SEC-6152: playbook auto-contain will block the top 250 source IPs at 02:40 unless the alert is resolved." },
      { at: 80, from: "Priya Shah · Identity", text: "Our SMS provider just flagged $3,800 of international texts in twenty minutes. Nobody is entering the codes." },
      { at: 150, from: "Sam Tan · Eng manager", text: "It's 2:30 in the morning, nobody's shopping. SOAR can block whatever it likes." },
      { at: 210, from: "Lena Park · SOC lead", text: "Night shift on mobile data is still mostly carrier NAT. The top 250 won't be the pumpers." },
    ],
    hints: [
      "The fraud is clear from the destinations. What the playbook blocks is a separate question.",
      "Even at night, the busiest addresses are carriers. The pumping comes from thousands of quiet servers.",
      "Two hosting providers, one block of addresses each.",
      "Closing the alert without naming your containment lets its playbook loose.",
    ],
    solution: [
      { command: "siem show SEC-6152", why: "Real SMS pumping through reset, and a top-250 block at 02:40." },
      { command: "siem search sms-resets", why: "Premium-rate destinations, numbers with no account, codes never entered: toll fraud." },
      { command: "waf top", why: "Carriers lead at ~13 a minute; each pumping server sends ~3, below hundreds of customers." },
      { command: "waf top --by asn", why: "1,900 addresses in Hetzner (135.181.0.0/16) and 1,300 in Contabo (161.97.0.0/16)." },
      { command: "waf block 135.181.0.0/16", why: "Stops the Hetzner pool; 0% of checkout." },
      { command: "waf block 161.97.0.0/16", why: "Stops the Contabo pool; 0% of checkout." },
      {
        command: 'siem resolve SEC-6152 --disposition true-positive --contained-by r-0003 --note "SMS pumping from Hetzner and Contabo, ranges blocked"',
        why: "True positive, contained by r-0003; the top-250 block is cancelled.",
      },
      { command: "waf rules", why: "Both rules match only the pumping; the 5xx drain." },
    ],
    postmortem: {
      question: "Why would SEC-6152's top-250 block have missed the pumpers?",
      options: [
        "Each server sent fewer resets than ~360 carrier addresses",
        "The pumpers used IPv6, which the playbook doesn't block",
        "Premium-rate SMS is billed even after the source is blocked",
        "The SMS provider's own servers would have been in the top 250",
      ],
      answerIndex: 0,
      explanation: {
        cause: "3,200 servers at ~3 resets a minute sat below the busiest few hundred carrier addresses.",
        why: "Even at night the head of the source list is carrier NAT. A top-250 block would have hit about 28% of customers and none of the pumpers. The pumping came from two hosting /16s, Hetzner and Contabo, which two range rules stopped completely.",
        tell: "waf top showed only carriers at the top; waf top --by asn showed Hetzner 135.181.0.0/16 and Contabo 161.97.0.0/16 holding every pumping address.",
      },
    },
  },
  {
    slug: "otp-guessing-gcp",
    title: "Second-factor codes guessed from GCP",
    severity: "SEV2",
    opensAtSecondOfDay: at(19, 10),
    briefing:
      "Someone holding stolen passwords is guessing six-digit sign-in codes on POST /session/otp from Google Cloud addresses, and checkout-api is shedding requests. SEC-6167's SOAR playbook will block the top 500 source IPs at 19:14.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6167 is real OTP guessing against accounts whose passwords already leaked. SOAR blocks the top 500 source IPs at 19:14, peak evening shopping. Stop the guessing yourself and keep that block from running.",
    attack: {
      label: "OTP guessing",
      path: "/session/otp",
      requestsPerSecond: 190,
      growthPerSecond: 0.045,
      sources: { kind: "ranges", ranges: [{ cidr: "34.75.0.0/16", asn: 396982, network: "GOOGLE-CLOUD-PLATFORM", ips: 2_400 }] },
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    alert: {
      id: "SEC-6167",
      title: "OTP guessing: failed second-factor codes far above baseline on POST /session/otp",
      rule: "auth.mfa.otp_failure_velocity",
      severity: "high",
      openedAt: -45,
    },
    playbook: { topIps: 500, at: 270 },
    view: {
      name: "otp-failures",
      description: "Second-factor failures against the baseline, and by network",
      heading: "Second-factor codes",
      baselinePerMinute: 120,
      signals: [
        ["codes tried per challenge (p99)", "5 (the lockout)", "2"],
        ["codes rejected", 0.999, 0.07],
        ["challenges reached with a correct password", 1, 1],
        ["challenges locked out", 0.97, 0.004],
      ],
    },
    suggestions: ["siem show SEC-6167", "siem search otp-failures", "waf top", "waf top --by asn", "siem resolve SEC-6167 --disposition true-positive"],
    lostCheckoutsPerPoint: 280,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 20%. SEC-6167 (high): OTP failure velocity. Assigned to SOC on-call (you)." },
      { at: 15, from: "SOC · SOAR", text: "SEC-6167: playbook auto-contain will block the top 500 source IPs at 19:14 unless the alert is resolved." },
      { at: 55, from: "Dev Raman · Identity", text: "Every one of these got the password right. They're working through a leaked list and only the second factor is holding." },
      { at: 115, from: "Sam Tan · Eng manager", text: "The playbook did fine on the scraper in July. Why not now?" },
      { at: 180, from: "Lena Park · SOC lead", text: "July's scraper was one address. This is thousands of quiet ones, and it's 7pm: carriers are at their busiest." },
      { at: 230, from: "Maya Okonkwo · Support", text: "Customers locked out of their own accounts are calling, and checkout is failing too." },
    ],
    hints: [
      "The guessing is real. Picture the busiest few hundred addresses at seven in the evening.",
      "Each guessing address stops at the lockout and moves on, so none of them is loud.",
      "One cloud provider, one block of addresses.",
      "A true positive with no containment named runs the playbook on the spot.",
    ],
    solution: [
      { command: "siem show SEC-6167", why: "Real OTP guessing, and a top-500 block at 19:14." },
      { command: "siem search otp-failures", why: "Correct passwords, then five wrong codes to lockout: leaked credentials and a guessing bot." },
      { command: "waf top", why: "Carriers lead at ~13 a minute; each GCP address sends ~4.7, under ~250 customer addresses." },
      { command: "waf top --by asn", why: "All 2,400 guessing addresses in AS396982, inside 34.75.0.0/16." },
      { command: "waf block 34.75.0.0/16", why: "Stops the guessing; 0% of checkout." },
      {
        command: 'siem resolve SEC-6167 --disposition true-positive --contained-by r-0003 --note "OTP guessing from GCP 34.75.0.0/16"',
        why: "True positive on r-0003; the playbook's top-500 block is cancelled.",
      },
      { command: "waf rules", why: "r-0003 matches the guessing only; the 5xx drain." },
    ],
    postmortem: {
      question: "Why did the July playbook tuning not fit SEC-6167?",
      options: [
        "Here the attackers each sent less than ~250 carrier addresses",
        "Google Cloud addresses can't be blocked at our edge provider",
        "OTP guessing has to be stopped by locking accounts, not the edge",
        "The top 500 by request count is recalculated too slowly to help",
      ],
      answerIndex: 0,
      explanation: {
        cause: "2,400 GCP addresses at under 5 guesses a minute ranked below ~250 carrier NAT addresses.",
        why: "A top-N block works on one loud address, like July's scraper. Here the guessing was spread thin and it was peak evening on mobile, so a top-500 block would have hit ~28% of customers and a tenth of the guessers. All of them sat in one Google Cloud /16.",
        tell: "waf top showed carriers ahead of any guessing address; waf top --by asn put all 2,400 in AS396982 inside 34.75.0.0/16.",
      },
    },
  },
  {
    slug: "loyalty-redemption-proxies",
    title: "Points cashed out through home proxies",
    severity: "SEV1",
    opensAtSecondOfDay: at(21, 30),
    briefing:
      "Taken-over accounts are redeeming loyalty points on POST /loyalty/redeem through residential proxies: home and mobile addresses on the same networks as our customers. checkout-api is shedding requests, and SEC-6178's playbook will block the top 350 source IPs at 21:35.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6178 is genuine loyalty fraud. The traffic comes from residential proxies, so no range singles it out, and SOAR blocks the top 350 source IPs at 21:35. Find what the bots share, contain them, and keep the playbook's block from running.",
    attack: {
      label: "loyalty redemption fraud",
      path: "/loyalty/redeem",
      requestsPerSecond: 250,
      growthPerSecond: 0.06,
      sources: { kind: "residential-proxies", ips: 25_000 },
      ja4: PYTHON_JA4,
      userAgent: FIREFOX_ESR,
    },
    alert: {
      id: "SEC-6178",
      title: "Loyalty fraud: points redeemed to new gift cards from accounts with a fresh sign-in",
      rule: "loyalty.redeem.fresh_session_drain",
      severity: "critical",
      openedAt: -100,
    },
    playbook: { topIps: 350, at: 330 },
    view: {
      name: "redemptions",
      description: "Loyalty redemptions against the baseline, and by TLS fingerprint",
      heading: "Loyalty redemptions",
      baselinePerMinute: 50,
      signals: [
        ["redemptions within 2 min of a new sign-in", 0.98, 0.03],
        ["redeemed to a digital gift card", 0.99, 0.12],
        ["accounts redeemed per source IP (p99)", "1", "1"],
        ["sign-ins from a device seen before", 0.01, 0.91],
      ],
      byJa4: { claimed: "Firefox/128.0 (Windows)" },
    },
    suggestions: ["siem show SEC-6178", "siem search redemptions", "waf top", "waf top --by asn", "siem resolve SEC-6178 --disposition true-positive"],
    lostCheckoutsPerPoint: 360,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 29%. SEC-6178 (critical): loyalty points drained to gift cards. Assigned to SOC on-call (you)." },
      { at: 20, from: "SOC · SOAR", text: "SEC-6178: playbook auto-contain will block the top 350 source IPs at 21:35 unless the alert is resolved." },
      { at: 70, from: "Rafa Moreno · Payments ops", text: "2.1 million points turned into gift cards in fifteen minutes, every one from a session that signed in moments before." },
      { at: 130, from: "Sam Tan · Eng manager", text: "Can we at least let SOAR knock out the worst 350?" },
      { at: 190, from: "Lena Park · SOC lead", text: "There is no 'worst 350'. Each proxy redeems one account and goes quiet. The top of that list is customers." },
      { at: 260, from: "Maya Okonkwo · Support", text: "Members are emailing that their points vanished, and checkout is failing for others." },
    ],
    hints: [
      "Every address is quiet and sits on a customer network. Look at what the requests share, not who sends most.",
      "A browser's User-Agent is a claim. How it opens the TLS connection is harder to fake.",
      "A top-N list here would be nothing but customers.",
      "When the alert closes, it should know what contained the attack.",
    ],
    solution: [
      { command: "siem show SEC-6178", why: "Real loyalty fraud, and a top-350 block at 21:35." },
      { command: "siem search redemptions", why: "Fresh sign-ins on unseen devices redeeming straight to gift cards; one JA4 carries the redemptions." },
      { command: "waf top", why: "Nothing to grab: each proxy redeems less than one a minute, far below the busiest customers." },
      { command: "waf top --by asn", why: "25,000 addresses spread over T-Mobile, Verizon, AT&T and Comcast: no range to block." },
      { command: `waf block --ja4 ${PYTHON_JA4}`, why: "The Python TLS stack every bot shares under its Firefox 128 User-Agent; no customer browser presents it." },
      {
        command: 'siem resolve SEC-6178 --disposition true-positive --contained-by r-0003 --note "loyalty drain via residential proxies, blocked by JA4"',
        why: "True positive, contained by r-0003; the top-350 block is cancelled.",
      },
      { command: "waf rules", why: "r-0003 matches the redemptions and 0% of checkout; the 5xx drain." },
    ],
    postmortem: {
      question: "Why was a JA4 block the containment for SEC-6178, not an IP block?",
      options: [
        "The bots shared one TLS client but no address or network",
        "Residential proxy addresses change faster than a JA4 does",
        "JA4 rules are cheaper for the edge to evaluate than IP lists",
        "The redemptions all came from one carrier's CGNAT address pool",
      ],
      answerIndex: 0,
      explanation: {
        cause: "25,000 residential proxies, each redeeming once, all opening TLS like Python.",
        why: "The proxies were real home and mobile addresses on customer networks, each quieter than any shopper, so a top-350 block would have caught ~33% of customers and no bot, and no CIDR fit. They claimed Firefox 128 but every one presented the same Python JA4, which no customer browser does.",
        tell: "siem search redemptions put one JA4, named Python by FoxIO, on 25,000 addresses with a Firefox/128 User-Agent; waf top --by asn showed only carriers and ISPs.",
      },
    },
  },
  {
    slug: "wallet-topup-fake-app",
    title: "Wallet top-ups from a fake app",
    severity: "SEV1",
    opensAtSecondOfDay: at(16, 45),
    briefing:
      "Stolen cards are topping up Marlow wallets on POST /wallet/top-up, sent through residential proxies by a client that calls itself our iOS app. checkout-api is shedding requests, and SEC-6185's playbook will block the top 700 source IPs at 16:50.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6185 is genuine wallet top-up fraud. The requests claim to be Marlow iOS 7.3.0 and come from customer networks. SOAR blocks the top 700 source IPs at 16:50. Contain the fraud without touching real customers, and keep that block from running.",
    attack: {
      label: "wallet top-up fraud",
      path: "/wallet/top-up",
      requestsPerSecond: 240,
      growthPerSecond: 0.05,
      sources: { kind: "residential-proxies", ips: 30_000 },
      ja4: GO_JA4,
      userAgent: MARLOW_IOS,
    },
    alert: {
      id: "SEC-6185",
      title: "Wallet fraud: top-ups with issuer declines and new cards far above baseline",
      rule: "payments.wallet.topup_decline_velocity",
      severity: "critical",
      openedAt: -130,
    },
    playbook: { topIps: 700, at: 300 },
    view: {
      name: "wallet-topups",
      description: "Wallet top-ups against the baseline, and by TLS fingerprint",
      heading: "Wallet top-ups",
      baselinePerMinute: 30,
      signals: [
        ["top-ups with a card added in the last 5 min", 0.99, 0.08],
        ["issuer decline rate", 0.64, 0.03],
        ["App Attest assertion present", 0, 0.99],
        ["top-ups of exactly $25.00", 0.93, 0.21],
      ],
      byJa4: { claimed: "Marlow/7.3.0 (iOS 18.6.2)" },
    },
    suggestions: ["siem show SEC-6185", "siem search wallet-topups", "waf top", "waf top --by asn", "siem resolve SEC-6185 --disposition true-positive"],
    lostCheckoutsPerPoint: 350,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 28%. SEC-6185 (critical): wallet top-up decline velocity. Assigned to SOC on-call (you)." },
      { at: 20, from: "SOC · SOAR", text: "SEC-6185: playbook auto-contain will block the top 700 source IPs at 16:50 unless the alert is resolved." },
      { at: 60, from: "Jonah Reyes · iOS", text: "The User-Agent says 7.3.0 build 7301, but none of these requests carry an App Attest assertion. Our app always sends one." },
      { at: 120, from: "Sam Tan · Eng manager", text: "700 is SOAR's biggest preset. Big problem, big hammer?" },
      { at: 180, from: "Lena Park · SOC lead", text: "These come through proxies on the same carriers as our app users. A top-700 hammer lands on our app users." },
      { at: 250, from: "Rafa Moreno · Payments ops", text: "The gateway wants to know why our decline rate on top-ups just went to 60%." },
    ],
    hints: [
      "The fraud is real. The addresses are customer addresses, so lists of addresses won't separate them.",
      "The requests say they're the iOS app. Something about the connection itself says otherwise.",
      "A top-N list here would be nothing but customers.",
      "Close the alert so that its playbook knows the attack is contained.",
    ],
    solution: [
      { command: "siem show SEC-6185", why: "Real top-up fraud, and a top-700 block at 16:50." },
      { command: "siem search wallet-topups", why: "Fresh cards, issuer declines, no App Attest; one GoLang JA4 behind a Marlow iOS User-Agent." },
      { command: "waf top", why: "Each proxy sends under half a request a minute: the top of the list is all customers." },
      { command: "waf top --by asn", why: "30,000 addresses spread over the same carriers and ISPs as our customers: no range to block." },
      { command: `waf block --ja4 ${GO_JA4}`, why: "Go's TLS client, which the real iOS app and customer browsers never present." },
      {
        command: 'siem resolve SEC-6185 --disposition true-positive --contained-by r-0003 --note "wallet top-up fraud, fake iOS client blocked by JA4"',
        why: "True positive on r-0003; the top-700 block is cancelled.",
      },
      { command: "waf rules", why: "r-0003 matches the fraud only; the 5xx drain." },
    ],
    postmortem: {
      question: "What gave the fake iOS client away?",
      options: [
        "A GoLang TLS fingerprint behind the app's User-Agent",
        "An app version, 7.3.0, that was never released to the store",
        "Every request came from one carrier's mobile address range",
        "Each address topped up wallets faster than any real customer",
      ],
      answerIndex: 0,
      explanation: {
        cause: "A Go client spoofing Marlow iOS's User-Agent through 30,000 residential proxies.",
        why: "The addresses were customers' own networks, each quieter than a shopper, so a top-700 block would have caught ~43% of customers and no fraud. The User-Agent was copied from the real app, but the TLS handshake was Go's, a JA4 no customer client presents. Blocking it stopped every top-up.",
        tell: "siem search wallet-topups: one JA4 named GoLang carried the top-ups under a Marlow/7.3.0 User-Agent, with no App Attest assertion on any of them.",
      },
    },
  },
  {
    slug: "shipping-quote-scraper",
    title: "Rate limiting the rate scraper",
    severity: "SEV2",
    opensAtSecondOfDay: at(11, 15),
    briefing:
      "A competitor's scraper is harvesting carrier shipping rates on POST /shipping/quote from Alibaba Cloud, and checkout-api is shedding requests. SEC-6203 has no playbook. The team wants a per-IP rate limit; the SOC lead has a number in mind.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6203 is a real scraper on /shipping/quote. Engineering wants a rate limit just under the scraper's per-address rate. Contain it without turning customers away, and close the alert as what it is.",
    attack: {
      label: "shipping quote scraping",
      path: "/shipping/quote",
      requestsPerSecond: 180,
      growthPerSecond: 0.04,
      sources: { kind: "ranges", ranges: [{ cidr: "47.88.0.0/14", asn: 45102, network: "ALIBABA-CN-NET", ips: 2_600 }] },
      ja4: PYTHON_JA4,
      userAgent: "python-requests/2.32.3",
    },
    alert: {
      id: "SEC-6203",
      title: "Scraping: shipping quotes for every postcode prefix from many sources",
      rule: "edge.shipping.quote_enumeration",
      severity: "medium",
      openedAt: -300,
    },
    view: {
      name: "quote-sweep",
      description: "Shipping quotes against the baseline, and by network",
      heading: "Shipping quotes",
      baselinePerMinute: 180,
      signals: [
        ["distinct postcodes quoted per source IP (p99)", "61", "2"],
        ["quotes with an empty cart", 0.99, 0.01],
        ["quotes followed by a checkout within 30 min", 0, 0.42],
        ["postcodes walked in numeric order", 0.95, 0.0],
      ],
    },
    suggestions: ["siem show SEC-6203", "siem search quote-sweep", "waf top", "waf top --by asn", "waf ratelimit 30/10m"],
    lostCheckoutsPerPoint: 270,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 19%. SEC-6203 (medium): shipping quote enumeration. Assigned to SOC on-call (you)." },
      { at: 40, from: "Oren Blake · Logistics", text: "Every postcode in the country got quoted this morning, in order. Someone wants our negotiated carrier rates." },
      { at: 100, from: "Lena Park · SOC lead", text: "Each scraper address sends about 4 a minute. A limit of 30 per 10 minutes sits just under it." },
      { at: 160, from: "Sam Tan · Eng manager", text: "Rate limit sounds safe. Nobody needs 3 quotes a minute, right?" },
      { at: 220, from: "Maya Okonkwo · Support", text: "Checkout is failing every few tries for customers." },
    ],
    hints: [
      "A per-address limit is only as good as the gap between the attacker's rate and the customers'.",
      "Plenty of carrier addresses carry more than three requests a minute, because each is a crowd of phones.",
      "The scraper rents one large block from one cloud provider.",
    ],
    solution: [
      { command: "siem show SEC-6203", why: "Real scraping on /shipping/quote; no playbook to race." },
      { command: "siem search quote-sweep", why: "Postcodes walked in order with empty carts: a scraper, not shoppers." },
      { command: "waf top", why: "Carriers send ~13 a minute; each scraper address ~4. A limit under 4 cuts carriers harder than scrapers." },
      { command: "waf top --by asn", why: "All 2,600 scraper addresses in AS45102 Alibaba Cloud, inside 47.88.0.0/14." },
      { command: "waf block 47.88.0.0/14", why: "Stops the scraper; the preview shows 0% of checkout." },
      { command: 'siem resolve SEC-6203 --disposition true-positive --note "shipping rate scraper from Alibaba Cloud, range blocked"', why: "Closes it as a true positive; it has no playbook to run." },
      { command: "waf rules", why: "r-0003 matches the scraper only; the 5xx drain." },
    ],
    postmortem: {
      question: "Why would a 30-per-10-minutes limit have backfired?",
      options: [
        "Carrier addresses send more than 3 a minute; scrapers ~4",
        "Rate limits on POST requests break the checkout redirect flow",
        "The scraper would retry blocked quotes and double its own load",
        "Alibaba Cloud rotates addresses on every request it forwards",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Scraper addresses sent ~4 quotes a minute; hundreds of carrier addresses send more.",
        why: "A per-IP limit stops only the excess over the limit. At 3 a minute it would have stopped about a quarter of the scraping and a slice of every busy carrier address, customers first. The scraper sat in one Alibaba Cloud /14 no customer uses, so a range block stopped all of it.",
        tell: "waf top showed carriers at ~13 a minute above scraper addresses at ~4, and waf top --by asn put every scraper inside 47.88.0.0/14.",
      },
    },
  },
  {
    slug: "address-verify-freeloaders",
    title: "Freeloaders on address verification",
    severity: "SEV2",
    opensAtSecondOfDay: at(14, 50),
    briefing:
      "Someone is using our paid address-verification endpoint, POST /address/verify, as a free lookup service from Oracle Cloud servers. Each lookup costs us, and the load has checkout-api shedding requests. SEC-6216 has no playbook; payments wants a strict rate limit.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6216 is real abuse of /address/verify. Payments ops is pushing for a tight per-IP rate limit. Stop the abuse without blocking customers, and close the alert as what it is.",
    attack: {
      label: "address lookup abuse",
      path: "/address/verify",
      requestsPerSecond: 160,
      growthPerSecond: 0.035,
      sources: {
        kind: "ranges",
        ranges: [
          { cidr: "129.146.0.0/16", asn: 31898, network: "ORACLE-BMC-31898", ips: 1_700 },
          { cidr: "152.70.0.0/16", asn: 31898, network: "ORACLE-BMC-31898", ips: 1_200 },
        ],
      },
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    alert: {
      id: "SEC-6216",
      title: "Address verification lookups with no checkout far above baseline",
      rule: "payments.address.verify_without_order",
      severity: "medium",
      openedAt: -420,
    },
    view: {
      name: "address-lookups",
      description: "Address verification calls against the baseline, and by network",
      heading: "Address verification",
      baselinePerMinute: 110,
      signals: [
        ["lookups with no cart in the session", 1, 0.02],
        ["addresses outside our shipping countries", 0.58, 0.003],
        ["lookups per source IP (p99)", "180 / hour", "3 / hour"],
        ["verification vendor spend / hour", "$1,140", "$38"],
      ],
    },
    suggestions: ["siem show SEC-6216", "siem search address-lookups", "waf top", "waf top --by asn", "waf ratelimit 2/1m"],
    lostCheckoutsPerPoint: 250,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 15%. SEC-6216 (medium): address verification without orders. Assigned to SOC on-call (you)." },
      { at: 45, from: "Rafa Moreno · Payments ops", text: "Our address vendor bill is 30× normal this hour. Just rate limit it to 2 a minute, nobody verifies more than that." },
      { at: 110, from: "Lena Park · SOC lead", text: "Nobody verifies more than that per person. Per address is a different question on mobile." },
      { at: 170, from: "Sam Tan · Eng manager", text: "Whatever stops the bill. I have finance on the phone." },
      { at: 240, from: "Maya Okonkwo · Support", text: "Customers say checkout times out at the address step." },
    ],
    hints: [
      "A per-address limit treats one carrier address like one person. It isn't.",
      "The abusers each send about three lookups a minute; plenty of customer addresses send more.",
      "All of the abuse comes from one cloud provider, through two blocks of addresses.",
    ],
    solution: [
      { command: "siem show SEC-6216", why: "Real abuse of /address/verify; no playbook." },
      { command: "siem search address-lookups", why: "Lookups with no cart, many outside our shipping countries: a free lookup service at our expense." },
      { command: "waf top", why: "Carriers send ~13 a minute; each Oracle address ~3.3. A 2-a-minute limit hits carriers hardest." },
      { command: "waf top --by asn", why: "2,900 addresses in AS31898 Oracle Cloud, inside 129.146.0.0/16 and 152.70.0.0/16." },
      { command: "waf block 129.146.0.0/16", why: "Stops the first pool; 0% of checkout." },
      { command: "waf block 152.70.0.0/16", why: "Stops the second; 0% of checkout." },
      { command: 'siem resolve SEC-6216 --disposition true-positive --note "address API abuse from Oracle Cloud, ranges blocked"', why: "True positive; nothing more to run." },
      { command: "waf rules", why: "Both rules match only the abuse; the 5xx drain." },
    ],
    postmortem: {
      question: "What was wrong with a 2-lookups-a-minute limit per IP?",
      options: [
        "One carrier address is many shoppers, busier than an abuser",
        "Address verification calls are cached, so limits don't apply",
        "The abusers would have switched to the GraphQL address query",
        "Oracle Cloud traffic arrives over IPv6 and skips IP-based rules",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Abusers sent ~3.3 lookups a minute per address; carrier NAT addresses send far more.",
        why: "Per person nobody verifies two addresses a minute, but a carrier address is thousands of people. The limit would have cut about 40% of the abuse and a large slice of mobile customers. The abuse came from two Oracle Cloud /16s, which range blocks stopped entirely.",
        tell: "waf top showed carrier addresses above every Oracle address, and waf top --by asn put all 2,900 in 129.146.0.0/16 and 152.70.0.0/16.",
      },
    },
  },
  {
    slug: "restock-monitor-linode",
    title: "Restock monitors under the limit",
    severity: "SEV2",
    opensAtSecondOfDay: at(17, 25),
    briefing:
      "Restock-monitor bots are polling POST /inventory/check for the console bundle from Linode, thousands of addresses each checking a few times a minute, and checkout-api is shedding requests. SEC-6229 has no playbook. The platform team suggests an hourly per-IP limit.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6229 is real restock polling. Platform wants a 200-an-hour per-IP limit. Stop the polling without turning shoppers away, and close the alert as what it is.",
    attack: {
      label: "restock polling",
      path: "/inventory/check",
      requestsPerSecond: 230,
      growthPerSecond: 0.05,
      sources: { kind: "ranges", ranges: [{ cidr: "172.104.0.0/15", asn: 63949, network: "AKAMAI-LINODE-AP", ips: 3_400 }] },
      ja4: GO_JA4,
      userAgent: "Go-http-client/1.1",
    },
    alert: {
      id: "SEC-6229",
      title: "Inventory polling: one SKU checked far above page views",
      rule: "catalog.inventory.check_without_view",
      severity: "medium",
      openedAt: -500,
    },
    view: {
      name: "stock-polls",
      description: "Inventory checks against the baseline, and by network",
      heading: "Inventory checks on SKU PS5-PRO-BUNDLE",
      baselinePerMinute: 200,
      signals: [
        ["checks with no product page view", 1, 0.06],
        ["checks on the bundle SKU", 0.99, 0.04],
        ["interval between checks per source (p50)", "15 s", "—"],
        ["checks followed by add-to-cart", 0, 0.31],
      ],
    },
    suggestions: ["siem show SEC-6229", "siem search stock-polls", "waf top", "waf top --by asn", "waf ratelimit 200/1h"],
    lostCheckoutsPerPoint: 300,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 26%. SEC-6229 (medium): inventory checks without page views. Assigned to SOC on-call (you)." },
      { at: 50, from: "Kai Moreau · Platform", text: "200 checks an hour per IP is generous for a human. Can we just put that on the endpoint?" },
      { at: 120, from: "Lena Park · SOC lead", text: "It's generous for a human. Is it generous for a carrier address with three thousand humans behind it?" },
      { at: 180, from: "Theo Grant · Merchandising", text: "The bundle restocks at six. If these bots see it first, it'll be gone in seconds again." },
      { at: 250, from: "Maya Okonkwo · Support", text: "Customers are getting errors at payment." },
    ],
    hints: [
      "An hourly limit that sounds generous per person can be stingy per address.",
      "The pollers each check every fifteen seconds or so. Compare that with the busiest customer addresses.",
      "The pollers all live in one provider's block of addresses.",
    ],
    solution: [
      { command: "siem show SEC-6229", why: "Real restock polling; no playbook." },
      { command: "siem search stock-polls", why: "Checks on one SKU every 15 s with no page view: monitors, not shoppers." },
      { command: "waf top", why: "Carriers send ~13 a minute; each Linode address ~4. 200 an hour is 3.3 a minute: carriers first." },
      { command: "waf top --by asn", why: "All 3,400 pollers in AS63949 Linode, inside 172.104.0.0/15." },
      { command: "waf block 172.104.0.0/15", why: "Stops the polling; 0% of checkout." },
      { command: 'siem resolve SEC-6229 --disposition true-positive --note "restock monitors from Linode 172.104.0.0/15"', why: "True positive; no playbook to run." },
      { command: "waf rules", why: "r-0003 matches the pollers only; the 5xx drain." },
    ],
    postmortem: {
      question: "Why was a 200-an-hour per-IP limit the wrong lever?",
      options: [
        "At 3.3 a minute it binds carriers before 4-a-minute bots",
        "Hourly windows reset on the hour, so bots burst right after",
        "Linode addresses are shared with our status page monitoring",
        "Inventory checks must stay unlimited for the drop to be fair",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Pollers sent ~4 checks a minute per address, under the busiest carrier NAT addresses.",
        why: "200 an hour is 3.3 a minute. Each poller lost under a fifth of its checks, while hundreds of carrier addresses, each a crowd of shoppers, were cut too. Every poller sat in one Linode /15 that no customer uses, so a range block stopped them all.",
        tell: "waf top showed carriers at ~13 a minute above the pollers' ~4; waf top --by asn put all 3,400 inside 172.104.0.0/15.",
      },
    },
  },
  {
    slug: "card-attach-safari-spoof",
    title: "Bots dressed as iPhone Safari",
    severity: "SEV2",
    opensAtSecondOfDay: at(12, 5),
    briefing:
      "Bots are attaching stolen cards to throwaway accounts on POST /payment-methods through residential proxies, every request claiming to be Safari on an iPhone. checkout-api is shedding requests. SEC-6241 has no playbook; someone wants to block Safari's fingerprint.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6241 is real card-attach fraud from customer networks, with an iPhone Safari User-Agent. The team wants to block the Safari JA4. Contain the bots without turning customers away, and close the alert.",
    attack: {
      label: "card attach fraud",
      path: "/payment-methods",
      requestsPerSecond: 200,
      growthPerSecond: 0.05,
      sources: { kind: "residential-proxies", ips: 18_000 },
      ja4: GO_JA4,
      userAgent: IPHONE_SAFARI,
    },
    alert: {
      id: "SEC-6241",
      title: "Card attach: new payment methods with failed $0 verifications far above baseline",
      rule: "payments.methods.zero_auth_failure_ratio",
      severity: "high",
      openedAt: -180,
    },
    view: {
      name: "card-attach",
      description: "Card attaches against the baseline, and by TLS fingerprint",
      heading: "Payment methods added",
      baselinePerMinute: 60,
      signals: [
        ["$0 verification declined", 0.83, 0.04],
        ["accounts created < 10 min before attach", 0.99, 0.05],
        ["cards attached per account (p99)", "6", "1"],
        ["User-Agent iPhone Safari 18.6", 1, 0.12],
      ],
      byJa4: { claimed: "Safari 18.6 (iPhone)" },
    },
    suggestions: ["siem show SEC-6241", "siem search card-attach", "waf top --by asn", `waf block --ja4 ${SAFARI_JA4}`],
    lostCheckoutsPerPoint: 300,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 22%. SEC-6241 (high): $0 verification failures on card attach. Assigned to SOC on-call (you)." },
      { at: 40, from: "Rafa Moreno · Payments ops", text: "Thousands of new accounts each attaching six cards. Somebody is sorting a stolen batch." },
      { at: 100, from: "Sam Tan · Eng manager", text: "They all say iPhone Safari. Block Safari's fingerprint for an hour and be done." },
      { at: 160, from: "Lena Park · SOC lead", text: "A User-Agent is a string anybody can type. Check what their TLS handshake looks like before blocking a real browser." },
      { at: 230, from: "Maya Okonkwo · Support", text: "Checkout is erroring for a lot of people, iPhone and otherwise." },
    ],
    hints: [
      "The User-Agent is the bots' claim. The TLS handshake is what they actually run.",
      "Blocking a real browser's fingerprint blocks every customer who uses that browser.",
      "Their addresses are customers' networks, so ranges won't separate them.",
    ],
    solution: [
      { command: "siem show SEC-6241", why: "Real card-attach fraud; no playbook." },
      { command: "siem search card-attach", why: "Every attach claims iPhone Safari, but they all present one GoLang JA4, not Safari's." },
      { command: "waf top --by asn", why: "18,000 addresses across the carriers and ISPs our customers use: no range to block." },
      { command: `waf block --ja4 ${GO_JA4}`, why: "Go's TLS client, which no customer browser presents; the preview shows 0% of checkout." },
      {
        command: 'siem resolve SEC-6241 --disposition true-positive --contained-by r-0003 --note "card attach fraud, Go client spoofing Safari, blocked by JA4"',
        why: "True positive, recorded against r-0003.",
      },
      { command: "waf rules", why: "r-0003 matches the bots only; the 5xx drain." },
    ],
    postmortem: {
      question: "Why would blocking Safari's JA4 have backfired?",
      options: [
        "The bots only claimed Safari; real Safari users have that JA4",
        "Safari resumes TLS sessions, so a JA4 block never sees one",
        "Apple Private Relay hides Safari's JA4 from the edge entirely",
        "The bots would switch their User-Agent to Chrome within minutes",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Go bots copied iPhone Safari's User-Agent; their TLS handshake stayed Go's.",
        why: "A JA4 block matches the handshake, not the User-Agent. Safari's fingerprint belongs to about 17% of our customers and none of the bots, so it would have turned those customers away and left every bot running. The bots' own Go JA4 matched no customer browser.",
        tell: "siem search card-attach: an iPhone Safari User-Agent on one JA4 that FoxIO names GoLang, while Safari's own JA4 carried normal customer traffic.",
      },
    },
  },
  {
    slug: "graphql-chrome-spoof",
    title: "A catalogue scraper wearing Chrome",
    severity: "SEV2",
    opensAtSecondOfDay: at(15, 35),
    briefing:
      "A price scraper is pulling the full catalogue through POST /graphql from Azure, every request claiming to be Chrome 141 on Windows, and checkout-api is shedding requests. SEC-6255 has no playbook. The fastest idea in the channel is to block Chrome's fingerprint.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6255 is a real catalogue scraper on /graphql with a Chrome 141 User-Agent. The channel wants Chrome's JA4 blocked. Contain the scraper without blocking customers, and close the alert.",
    attack: {
      label: "catalogue scraping",
      path: "/graphql",
      requestsPerSecond: 210,
      growthPerSecond: 0.045,
      sources: { kind: "ranges", ranges: [{ cidr: "20.42.0.0/16", asn: 8075, network: "MICROSOFT-CORP-MSN-AS-BLOCK", ips: 2_500 }] },
      ja4: PYTHON_JA4,
      userAgent: WINDOWS_CHROME,
    },
    alert: {
      id: "SEC-6255",
      title: "Scraping: GraphQL product queries paging the whole catalogue",
      rule: "edge.graphql.catalogue_pagination",
      severity: "medium",
      openedAt: -260,
    },
    view: {
      name: "graphql-pages",
      description: "GraphQL product queries against the baseline, and by TLS fingerprint",
      heading: "GraphQL products(first: 100) queries",
      baselinePerMinute: 240,
      signals: [
        ["queries paging past cursor 50", 0.99, 0.001],
        ["queries asking only for price and sku", 0.98, 0.02],
        ["sessions with no cookies set", 1, 0.03],
        ["User-Agent Chrome/141 on Windows", 1, 0.19],
      ],
      byJa4: { claimed: "Chrome/141.0.0.0 (Windows)" },
    },
    suggestions: ["siem show SEC-6255", "siem search graphql-pages", "waf top --by asn", `waf block --ja4 ${CHROMIUM_JA4}`],
    lostCheckoutsPerPoint: 280,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 23%. SEC-6255 (medium): GraphQL catalogue pagination. Assigned to SOC on-call (you)." },
      { at: 45, from: "Ivy Chen · Pricing", text: "Our whole price list is being paged out every few minutes. Someone's repricing against us live." },
      { at: 105, from: "Sam Tan · Eng manager", text: "They're all Chrome 141 on Windows. Block the Chrome fingerprint, we'll undo it tonight." },
      { at: 165, from: "Lena Park · SOC lead", text: "A third of our customers are on Chrome. Make sure the scraper really is Chrome before you block it." },
      { at: 240, from: "Maya Okonkwo · Support", text: "Checkout keeps failing for customers on desktop and phone." },
    ],
    hints: [
      "What a client says it is and how it opens TLS can disagree. Only one of those is easy to fake.",
      "A browser's fingerprint is shared by every customer using that browser.",
      "The scraper doesn't hide where it runs either.",
    ],
    solution: [
      { command: "siem show SEC-6255", why: "Real catalogue scraping; no playbook." },
      { command: "siem search graphql-pages", why: "Price-only pages past cursor 50 from a Chrome 141 User-Agent on one Python JA4, not Chromium's." },
      { command: "waf top --by asn", why: "2,500 addresses in AS8075 Microsoft (Azure), inside 20.42.0.0/16." },
      { command: `waf block --ja4 ${PYTHON_JA4}`, why: "The Python TLS stack the scraper actually runs; no customer browser presents it, so 0% of checkout." },
      {
        command: 'siem resolve SEC-6255 --disposition true-positive --contained-by r-0003 --note "catalogue scraper spoofing Chrome, blocked by JA4"',
        why: "True positive, recorded against r-0003.",
      },
      { command: "waf rules", why: "r-0003 matches the scraper only; the 5xx drain." },
    ],
    postmortem: {
      question: "Why was Chrome's JA4 the wrong thing to block?",
      options: [
        "The scraper ran Python TLS; Chrome's JA4 is ~31% of customers",
        "Chrome changes its JA4 every release, so the block would lapse",
        "GraphQL goes over HTTP/3, which JA4 can't fingerprint at all",
        "Azure ends TLS for its tenants, so the edge sees Azure's JA4",
      ],
      answerIndex: 0,
      explanation: {
        cause: "A Python scraper sent a Chrome 141 User-Agent; its TLS handshake was Python's.",
        why: "JA4 fingerprints the ClientHello, which the scraper couldn't make look like Chrome. Blocking Chromium's JA4 would have turned away about 31% of customers and no scraper request. The scraper's Python JA4, or its Azure /16, matched no customer.",
        tell: "siem search graphql-pages: the Chrome/141 User-Agent sat on one JA4 FoxIO names Python, while Chromium's JA4 carried ordinary customer traffic.",
      },
    },
  },
  {
    slug: "magic-link-firefox-spoof",
    title: "Magic links for a Firefox that isn't",
    severity: "SEV2",
    opensAtSecondOfDay: at(6, 50),
    briefing:
      "Someone is requesting sign-in links on POST /session/magic-link for a long list of emails to learn which ones have accounts, from M247 servers, each request claiming Firefox 143. checkout-api is shedding requests. SEC-6268 has no playbook; the quick suggestion is to block Firefox's fingerprint.",
    roleBriefing:
      "SOC on-call: siem and waf. SEC-6268 is real account enumeration through magic links. The requests claim Firefox 143. Someone wants Firefox's JA4 blocked since 'hardly anyone uses Firefox'. Contain it without blocking customers, and close the alert.",
    attack: {
      label: "account enumeration",
      path: "/session/magic-link",
      requestsPerSecond: 185,
      growthPerSecond: 0.04,
      sources: { kind: "ranges", ranges: [{ cidr: "37.120.128.0/17", asn: 9009, network: "M247", ips: 2_000 }] },
      ja4: GO_JA4,
      userAgent: WINDOWS_FIREFOX,
    },
    alert: {
      id: "SEC-6268",
      title: "Account enumeration: magic-link requests for unknown emails far above baseline",
      rule: "auth.magic_link.unknown_email_ratio",
      severity: "high",
      openedAt: -75,
    },
    view: {
      name: "magic-links",
      description: "Magic-link requests against the baseline, and by TLS fingerprint",
      heading: "Magic-link requests",
      baselinePerMinute: 80,
      signals: [
        ["requests for an email with no account", 0.86, 0.09],
        ["emails requested per source IP (p99)", "55", "1"],
        ["links ever opened", 0.0, 0.88],
        ["User-Agent Firefox/143 on Windows", 1, 0.02],
      ],
      byJa4: { claimed: "Firefox/143.0 (Windows)" },
    },
    suggestions: ["siem show SEC-6268", "siem search magic-links", "waf top --by asn", `waf block --ja4 ${FIREFOX_JA4}`],
    lostCheckoutsPerPoint: 260,
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 20%. SEC-6268 (high): magic-link requests for unknown emails. Assigned to SOC on-call (you)." },
      { at: 35, from: "Priya Shah · Identity", text: "The email provider is bouncing thousands of magic links. Someone's testing a list to see who has an account with us." },
      { at: 95, from: "Sam Tan · Eng manager", text: "It's all Firefox. Three percent of our customers use Firefox. Block it and apologise to the three percent." },
      { at: 155, from: "Lena Park · SOC lead", text: "Three percent of customers is still thousands of orders today. And the requests only say they're Firefox." },
      { at: 220, from: "Maya Okonkwo · Support", text: "Morning checkout is failing more than usual." },
    ],
    hints: [
      "Small share or not, a real browser's fingerprint belongs to real customers.",
      "Read what the connection itself says about the client, not what the client says about itself.",
      "The enumeration runs from one block of rented addresses too.",
    ],
    solution: [
      { command: "siem show SEC-6268", why: "Real account enumeration through magic links; no playbook." },
      { command: "siem search magic-links", why: "Unknown emails, links never opened, a Firefox 143 User-Agent on one GoLang JA4, not Firefox's." },
      { command: "waf top --by asn", why: "2,000 addresses in AS9009 M247, inside 37.120.128.0/17." },
      { command: `waf block --ja4 ${GO_JA4}`, why: "The Go client the enumeration really runs; no customer browser presents it." },
      {
        command: 'siem resolve SEC-6268 --disposition true-positive --contained-by r-0003 --note "account enumeration, Go client spoofing Firefox, blocked by JA4"',
        why: "True positive, recorded against r-0003.",
      },
      { command: "waf rules", why: "r-0003 matches the enumeration only; the 5xx drain." },
    ],
    postmortem: {
      question: "What would blocking Firefox's JA4 have done?",
      options: [
        "Blocked real Firefox users and no enumeration request",
        "Stopped the enumeration and only a few Firefox customers",
        "Nothing, because a JA4 block can't apply to magic-link requests",
        "Forced the bots onto Chrome, where we'd have no way to tell them",
      ],
      answerIndex: 0,
      explanation: {
        cause: "A Go client claimed Firefox 143 in its User-Agent; its handshake was Go's.",
        why: "The block matches the TLS handshake. Firefox's fingerprint is ~3% of customers and none of the bots, so it would have cost those customers their orders and left the enumeration running. The bots' Go JA4, or their M247 /17, matched no customer.",
        tell: "siem search magic-links: the Firefox/143 User-Agent sat on one JA4 FoxIO names GoLang, while Firefox's own JA4 carried normal customer sign-ins.",
      },
    },
  },
];

export const SECURITY_TIER3_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
