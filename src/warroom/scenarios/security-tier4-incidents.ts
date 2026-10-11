import type { CommsMessage, Evidence, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count, percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, AttackRange, SiemAlert } from "../sim/commerce.ts";
import { BROWSER_JA4, DISTINCT_SOURCE_IPS } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

/**
 * Tier 4 for the SOC: the attack is slow per address, so the rate limits and top-talker blocks that
 * usually end an attack match nothing. Two shapes share the mechanics:
 * - "proxies": residential proxies in the customers' own networks, given away by a TLS client no browser presents;
 * - "farm": real browsers driven from rented hosting ranges, so the fingerprint is a customer's and only the ranges single them out.
 */

/** One row of a saved search: what it reads with the attack at full strength, and on a normal day. */
type Signal = { readonly metric: string; readonly attack: number; readonly baseline: number; readonly unit: "share" | "count" };

type View = { readonly name: string; readonly description: string };

type Common = {
  readonly slug: string;
  readonly seed: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly alert: { readonly id: string; readonly title: string; readonly rule: string; readonly severity: SiemAlert["severity"]; readonly openedAt: number };
  readonly attack: { readonly label: string; readonly path: string; readonly requestsPerSecond: number; readonly growthPerSecond: number; readonly userAgent: string };
  /** Real customers' requests a minute on the attacked path, at this hour. */
  readonly customerPerMinute: number;
  readonly signals: View & { readonly heading: string; readonly rows: readonly Signal[] };
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly whys: { readonly show: string; readonly signals: string; readonly top: string; readonly tell: string; readonly fix: string; readonly rules: string };
  readonly resolveNote: string;
  readonly lostCheckoutsPerPoint: number;
  readonly postmortem: Postmortem;
};

type ProxyRow = Common & {
  readonly kind: "proxies";
  readonly ips: number;
  readonly ja4: string;
  /** What the fingerprint's a-part says about the client, since FoxIO's database doesn't name it. */
  readonly ja4Label: string;
  readonly userAgentShort: string;
  readonly fingerprints: View;
};

type FarmRow = Common & {
  readonly kind: "farm";
  readonly ranges: readonly AttackRange[];
  readonly browser: "Chromium Browser" | "Safari" | "Mozilla Firefox";
  readonly networks: View;
};

type Row = ProxyRow | FarmRow;

function browserJa4(client: FarmRow["browser"]) {
  const entry = BROWSER_JA4.find((candidate) => candidate.client === client);
  if (!entry) throw new Error(`no JA4 listed for ${client}`);
  return entry;
}

function attackOf(row: Row): Attack {
  return {
    ...row.attack,
    sources: row.kind === "proxies" ? { kind: "residential-proxies", ips: row.ips } : { kind: "ranges", ranges: row.ranges },
    ja4: row.kind === "proxies" ? row.ja4 : browserJa4(row.browser).ja4,
  };
}

function fixCommands(row: Row): readonly string[] {
  return row.kind === "proxies" ? [`waf block --ja4 ${row.ja4}`] : row.ranges.map((range) => `waf block ${range.cidr}`);
}

function signalsView(row: Row): Evidence {
  return {
    tool: "siem",
    name: row.signals.name,
    description: row.signals.description,
    run: (state: ClusterState) => {
      const { commerce } = state;
      if (!commerce) return [];
      const { perMinute, passed } = attackAtEdge(commerce, state.t);
      const blend = (signal: Signal) => signal.baseline + (signal.attack - signal.baseline) * passed;
      return [
        `${row.signals.heading} · last 15 min vs the same hour over the last 7 days`,
        ...table([
          ["METRIC", "NOW", "7-DAY BASELINE"],
          [`POST ${row.attack.path} requests / min (at the edge)`, count(row.customerPerMinute + perMinute), count(row.customerPerMinute)],
          ...row.signals.rows.map((signal) =>
            signal.unit === "share" ? [signal.metric, percent(blend(signal)), percent(signal.baseline)] : [signal.metric, count(blend(signal)), count(signal.baseline)],
          ),
        ]),
      ];
    },
  };
}

const BROWSER_UA: Record<string, string> = {
  "Chromium Browser": "Chrome/141.0.0.0 (Mac, Windows)",
  Safari: "Version/18.6 Safari (iPhone, Mac)",
  "Mozilla Firefox": "Firefox/143.0",
};

/** The attacked path by TLS client fingerprint: the bots' one JA4 beside the browsers customers use. */
function fingerprintView(row: ProxyRow): Evidence {
  return {
    tool: "siem",
    name: row.fingerprints.name,
    description: row.fingerprints.description,
    run: (state: ClusterState) => {
      const { commerce } = state;
      if (!commerce) return [];
      const { perMinute, passed } = attackAtEdge(commerce, state.t);
      const listed = BROWSER_JA4.reduce((sum, entry) => sum + entry.customerShare, 0);
      return [
        `POST ${row.attack.path} by JA4 · last 15 min (fingerprint names: FoxIO JA4 database)`,
        ...table([
          ["JA4", "KNOWN AS", "TOP USER-AGENT", "REQ/MIN PAST WAF", "ClientIP (distinct)"],
          [row.ja4, row.ja4Label, row.userAgentShort, count(perMinute * passed), count(row.ips)],
          ...BROWSER_JA4.map((entry) => [entry.ja4, entry.client, BROWSER_UA[entry.client] ?? entry.client, count(row.customerPerMinute * entry.customerShare), count(DISTINCT_SOURCE_IPS * entry.customerShare)]),
          ["(other: Marlow apps, unlisted)", "—", "Marlow/7.3.0 (com.marlow.shop; …)", count(row.customerPerMinute * (1 - listed)), count(DISTINCT_SOURCE_IPS * (1 - listed))],
        ]),
        `${row.ja4} with ${row.attack.userAgent}: ${count(row.ips)} addresses across T-Mobile, Verizon Wireless, AT&T Mobility and Comcast, none above 1 request a minute.`,
      ];
    },
  };
}

/** The attacked path by origin network: the hosting ranges beside the carriers customers come from. */
function networkView(row: FarmRow): Evidence {
  const browser = browserJa4(row.browser);
  return {
    tool: "siem",
    name: row.networks.name,
    description: row.networks.description,
    run: (state: ClusterState) => {
      const { commerce } = state;
      if (!commerce) return [];
      const { perMinute } = attackAtEdge(commerce, state.t);
      const blocks = commerce.wafRules.filter((rule) => rule.action === "block");
      const throttled = commerce.wafRules.reduce((open, rule) => open * (rule.action === "rate_limit" ? 1 - (rule.attackShare ?? 0) : 1), 1);
      const isJa4Blocked = blocks.some((rule) => rule.expression.includes(browser.ja4));
      const attackers = row.ranges.reduce((sum, range) => sum + range.ips, 0);
      const rangeRows = row.ranges.map((range) => {
        const isBlocked = isJa4Blocked || blocks.some((rule) => rule.expression.includes(range.cidr));
        const past = isBlocked ? 0 : (perMinute * range.ips * throttled) / attackers;
        return [String(range.asn), range.network, "hosting / datacenter", range.cidr, count(range.ips), count(past), browser.ja4];
      });
      const carriers: readonly (readonly [string, string, string, number])[] = [
        ["21928", "T-MOBILE-AS21928", "mobile carrier (CGNAT)", 0.34],
        ["22394", "CELLCO (Verizon Wireless)", "mobile carrier (CGNAT)", 0.27],
        ["7922", "COMCAST-7922", "residential ISP", 0.22],
      ];
      return [
        `POST ${row.attack.path} by ClientASN · last 15 min`,
        ...table([
          ["ClientASN", "NETWORK", "TYPE", "PREFIX", "ClientIP (distinct)", "REQ/MIN PAST WAF", "TOP JA4"],
          ...rangeRows,
          ...carriers.map(([asn, network, type, share]) => [asn, network, type, "—", count(DISTINCT_SOURCE_IPS * share), count(row.customerPerMinute * share), "(mixed: browsers and apps)"]),
        ]),
        `${browser.ja4} is FoxIO's ${browser.client}: the same fingerprint ${percent(browser.customerShare, 0)} of checkout customers present. Every hosting address sends it with ${row.attack.userAgent}.`,
      ];
    },
  };
}

function solutionOf(row: Row): readonly SolutionStep[] {
  const [first, ...more] = fixCommands(row);
  const tellCommand = row.kind === "proxies" ? `siem search ${row.fingerprints.name}` : `siem search ${row.networks.name}`;
  const extraBlocks =
    row.kind === "farm"
      ? more.map((command, index) => {
          const range = row.ranges[index + 1];
          return { command, why: `${range.network}'s ${count(range.ips)} addresses in ${range.cidr}: the same browser, the same slow pace. The preview shows 0% of checkout customers.` };
        })
      : [];
  return [
    { command: `siem show ${row.alert.id}`, why: row.whys.show },
    { command: `siem search ${row.signals.name}`, why: row.whys.signals },
    { command: "waf top", why: row.whys.top },
    { command: tellCommand, why: row.whys.tell },
    { command: first, why: row.whys.fix },
    ...extraBlocks,
    {
      command: `siem resolve ${row.alert.id} --disposition true-positive --contained-by r-0003 --note "${row.resolveNote}"`,
      why: "Closes it as the true positive it is, naming your rule as the containment (r-0003 is the id `waf rules` gave your first block).",
    },
    { command: "waf rules", why: row.whys.rules },
  ];
}

function scenarioOf(row: Row): Scenario {
  const alert: SiemAlert = { ...row.alert, autoContainAt: null, containTopIps: 0, resolution: null };
  const attack = attackOf(row);
  const fixes = fixCommands(row);
  return {
    id: row.slug,
    tier: 4,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["security"],
    roleBriefings: { security: row.roleBriefing },
    opensAtSecondOfDay: row.opensAt,
    seed: row.seed,
    initialState: () => attackedCluster(row.seed, checkoutCommerce({ attack, alerts: [alert] })),
    isRootCauseFixed: (state) => isAttackStopped(state, 0.99),
    objectives: (state) => (state.commerce ? [noCustomersBlocked(state.commerce), alertClosedAs(state.commerce, row.alert.id, "true-positive")] : []),
    evidence: [signalsView(row), row.kind === "proxies" ? fingerprintView(row) : networkView(row)],
    suggestions: {
      security: [
        `siem show ${row.alert.id}`,
        `siem search ${row.signals.name}`,
        "waf top",
        "waf top --by asn",
        "waf ratelimit 20/1m",
        `siem search ${row.kind === "proxies" ? row.fingerprints.name : row.networks.name}`,
      ].filter((suggestion) => !fixes.includes(suggestion)),
    },
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [],
    comms: row.comms,
    hints: row.hints,
    solution: { security: solutionOf(row) },
    postmortem: row.postmortem,
  };
}

const share = (metric: string, attack: number, baseline: number): Signal => ({ metric, attack, baseline, unit: "share" });
const tally = (metric: string, attack: number, baseline: number): Signal => ({ metric, attack, baseline, unit: "count" });

const ROWS: readonly Row[] = [
  {
    kind: "proxies",
    slug: "sec-t4-gift-card-balance-probe",
    seed: "sec-t4-gift-card-balance-probe",
    title: "Gift cards drained one guess at a time",
    severity: "SEV1",
    opensAt: 6 * 3600 + 40 * 60,
    briefing:
      "Someone is guessing gift card numbers against the balance lookup, POST /gift-cards/balance on checkout-api, through tens of thousands of home and phone addresses. Every hit is a card they can spend before its owner does, and the guessing is starving checkout.",
    roleBriefing:
      "SOC on-call: siem and waf. The guesses come from the same carriers and ISPs as our customers, each address asking about one card every couple of minutes. The edge rate limit we lean on catches nothing that slow. Find what every guess has in common.",
    alert: { id: "SEC-5402", title: "Gift card balance lookups: invalid-code ratio far above baseline", rule: "giftcard.balance.invalid_code_ratio", severity: "high", openedAt: -90 },
    attack: {
      label: "gift card enumeration",
      path: "/gift-cards/balance",
      requestsPerSecond: 270,
      growthPerSecond: 0.08,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1",
    },
    ips: 36_000,
    ja4: "t13d311100_e8f1e7e78f70_1f22a2ca17c4",
    ja4Label: "unlisted (31 ciphers, no ALPN)",
    userAgentShort: "Safari 16.1 (iPhone)",
    customerPerMinute: 140,
    signals: {
      name: "giftcard-lookups",
      description: "Gift card balance lookups against the 7-day baseline",
      heading: "Gift card balance lookups · POST /gift-cards/balance",
      rows: [
        share("lookups for a code that doesn't exist", 0.97, 0.04),
        tally("distinct codes per source IP (p99)", 2, 2),
        share("lookups followed by a checkout within 1 h", 0.004, 0.61),
        tally("cards found with a balance, then spent from a new device", 37, 0),
      ],
    },
    fingerprints: { name: "giftcard-tls", description: "Balance lookups by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 36%. SEC-5402 (high): gift card balance lookups, invalid-code ratio far above baseline. Assigned to SOC on-call (you)." },
      { at: 30, from: "Priya Nair · Payments ops", text: "Thirty-odd gift cards have been spent from new devices in the last hour. Their owners haven't touched them." },
      { at: 75, from: "Sam Tan · Eng manager", text: "Can we rate-limit the balance endpoint hard? Nobody needs to check a balance twenty times a minute." },
      { at: 140, from: "Lena Park · SOC lead", text: "Nobody is checking twenty times a minute. Look at the per-address numbers before you limit anything." },
      { at: 210, from: "Maya Okonkwo · Support", text: "Two customers say their holiday gift cards are at $0. And checkout keeps failing for everyone else." },
    ],
    hints: [
      "Each address asks about one or two cards and goes quiet. Volume per address will never single them out.",
      "The requests all claim to be Safari on an iPhone. Check whether the way they open the connection agrees.",
      "Safari always offers ALPN. A client that doesn't is not Safari, whatever its User-Agent says.",
    ],
    whys: {
      show: "Balance lookups for codes that don't exist, far above baseline, on checkout-api's gift card endpoint.",
      signals: "97% of lookups miss, almost none lead to a checkout, and each address tries only two codes: enumeration spread thin.",
      top: "The busiest addresses are phone carriers' NAT at ~13 a minute; the guessers send under one each. A limit or top-N block has nothing to grab.",
      tell: "One JA4 with no ALPN and 31 ciphers carries the guesses from 36,000 addresses, all claiming iPhone Safari 16.1. Safari never opens TLS that way.",
      fix: "Blocks the one TLS client every guesser shares; no browser our customers use presents it.",
      rules: "The new rule matches the guessing and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "gift card enumeration via residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 380,
    postmortem: {
      question: "Why did the balance-endpoint rate limit catch none of the guessers?",
      options: [
        "Each proxy address sent under one lookup a minute",
        "The rate limit was applied to the wrong path on checkout-api",
        "The guessers rotated their User-Agent every few requests",
        "The WAF exempts gift card endpoints from per-IP limits by default",
      ],
      answerIndex: 0,
      explanation: {
        cause: "36,000 residential proxies each asked about a card every couple of minutes, while one TLS client sat behind all of them.",
        why: "A per-address limit only bites on addresses sending more than the limit, and these sent less than any busy shopper. The kit claimed to be iPhone Safari but opened TLS with no ALPN and 31 ciphers, which Safari never does, so one JA4 block stopped every guess and no customer.",
        tell: "siem search giftcard-tls: one unlisted JA4 behind 36,000 addresses with a Safari 16.1 User-Agent, beside the real Safari fingerprint customers present.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-reset-account-enumeration",
    seed: "sec-t4-reset-account-enumeration",
    title: "Password resets for people who never signed up",
    severity: "SEV2",
    opensAt: 22 * 3600 + 5 * 60,
    briefing:
      "A list of email addresses is being run through password reset, POST /password-reset on checkout-api, to learn which ones have Marlow accounts. The requests come through residential proxies, and the load is pushing checkout over.",
    roleBriefing:
      "SOC on-call: siem and waf. Reset requests are 20× normal and most name an email we've never seen. Each address sends a reset every few minutes, so per-IP limits and top-talker blocks catch customers, not the bots.",
    alert: { id: "SEC-5418", title: "Password reset requests for unknown emails far above baseline", rule: "auth.password_reset.unknown_account_ratio", severity: "medium", openedAt: -150 },
    attack: {
      label: "account enumeration",
      path: "/password-reset",
      requestsPerSecond: 210,
      growthPerSecond: 0.06,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0",
    },
    ips: 52_000,
    ja4: "t13d521000_b262b3658495_8e6e362c5eac",
    ja4Label: "unlisted (52 ciphers, no ALPN)",
    userAgentShort: "Firefox/102.0 (Windows)",
    customerPerMinute: 46,
    signals: {
      name: "reset-requests",
      description: "Password reset requests against the 7-day baseline",
      heading: "Password resets · POST /password-reset",
      rows: [
        share("resets naming an email with no account", 0.82, 0.07),
        share("reset emails opened within 1 h", 0.002, 0.71),
        tally("distinct emails per source IP (p99)", 3, 3),
        share("requests answered 'account found' (enumeration oracle)", 0.18, 0.93),
      ],
    },
    fingerprints: { name: "reset-tls", description: "Reset requests by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 24%. SEC-5418 (medium): password reset requests for unknown emails. Assigned to SOC on-call (you)." },
      { at: 35, from: "Dev Raman · Identity team", text: "The reset endpoint still answers differently when an account exists. Someone is using that to sort a list of emails." },
      { at: 90, from: "Sam Tan · Eng manager", text: "Block the top 500 addresses on /password-reset and let's get some sleep." },
      { at: 160, from: "Lena Park · SOC lead", text: "The top 500 on checkout-api are carrier NAT addresses, thousands of phones each. Find something the bots share." },
      { at: 240, from: "Maya Okonkwo · Support", text: "Night-shift chats are all 'checkout failed, try again'." },
    ],
    hints: [
      "Fifty thousand addresses, a reset every few minutes each: whatever is wrong is in the requests, not in who sends the most.",
      "They say they are Firefox 102. Compare how they negotiate TLS with how real Firefox does.",
      "A list of the busiest addresses is phone carriers. Anything aimed at it lands on customers.",
    ],
    whys: {
      show: "Resets naming unknown emails far above baseline, on checkout-api's reset endpoint.",
      signals: "82% of resets name an email with no account, almost none are opened, and each address tries three emails: a list run through proxies.",
      top: "Phone carriers lead the list; the bots send a fraction of a request a minute each. Limits and top-N blocks have nothing to grab.",
      tell: "One JA4 with 52 ciphers and no ALPN carries the resets from 52,000 addresses, all claiming Firefox 102. Firefox offers 17 ciphers and h2.",
      fix: "Blocks the one TLS client every bot shares; no customer browser presents it.",
      rules: "The new rule matches the enumeration and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "account enumeration via password reset, residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 260,
    postmortem: {
      question: "What let one rule stop the enumeration without touching customers?",
      options: [
        "The bots' reset emails all bounced from one mail domain",
        "Every bot shared a TLS fingerprint no customer browser presents",
        "The bots came from a single hosting network that one range block covered",
        "Each bot address sent more resets a minute than any customer did",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A reset-endpoint account oracle was being queried from 52,000 residential proxies, all one TLS client.",
        why: "The proxies were real home and phone addresses, each sending a reset every few minutes, so top-N and per-IP limits caught carrier NAT first. The kit's User-Agent said Firefox 102, but its ClientHello offered 52 ciphers and no ALPN: one JA4 no customer presents.",
        tell: "siem search reset-tls: one unlisted JA4 behind 52,000 addresses, all with a Firefox/102.0 User-Agent.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-promo-code-guessing",
    seed: "sec-t4-promo-code-guessing",
    title: "Welcome codes guessed faster than we mint them",
    severity: "SEV1",
    opensAt: 11 * 3600 + 20 * 60,
    briefing:
      "Bots are guessing single-use WELCOME codes against POST /promotions/validate on checkout-api, through residential proxies. Valid codes are being resold, and the validation storm is shedding checkouts.",
    roleBriefing:
      "SOC on-call: siem and waf. Validation failures are 40× normal, spread over 28,000 home and phone addresses at a few guesses an hour each. The per-IP limit that stopped last spring's guessers won't see these.",
    alert: { id: "SEC-5431", title: "Promo code validation failures far above baseline", rule: "promo.validate.failure_ratio_anomaly", severity: "high", openedAt: -45 },
    attack: {
      label: "promo code guessing",
      path: "/promotions/validate",
      requestsPerSecond: 300,
      growthPerSecond: 0.1,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    ips: 28_000,
    ja4: "t12d1909h1_d83cc789557e_7af1ed941c26",
    ja4Label: "unlisted (TLS 1.2 only)",
    userAgentShort: "Chrome/126.0.0.0 (Windows)",
    customerPerMinute: 210,
    signals: {
      name: "promo-validations",
      description: "Promo code validations against the 7-day baseline",
      heading: "Promo validations · POST /promotions/validate",
      rows: [
        share("validations of a code that doesn't exist", 0.96, 0.06),
        share("codes validated with nothing in the cart", 0.99, 0.03),
        tally("WELCOME- codes redeemed by accounts under 1 h old", 112, 1),
        tally("distinct codes per source IP (p99)", 4, 4),
      ],
    },
    fingerprints: { name: "promo-tls", description: "Promo validations by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 41%. SEC-5431 (high): promo code validation failures far above baseline. Assigned to SOC on-call (you)." },
      { at: 25, from: "Jonah Weiss · Growth", text: "WELCOME codes are showing up on a deals Telegram channel. They're single-use and they're going fast." },
      { at: 80, from: "Lena Park · SOC lead", text: "Last spring a 20-a-minute limit on /promotions/validate ended it in five minutes. Check whether this lot is anywhere near that fast." },
      { at: 150, from: "Sam Tan · Eng manager", text: "Could we just turn off WELCOME codes? Growth will scream, but checkout matters more." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Lunch peak starts in forty minutes. Whatever you block, customers have to be able to pay." },
    ],
    hints: [
      "Last spring's guessers came from a few servers. These come from customers' own networks, a few guesses an hour each.",
      "Chrome 126 negotiates TLS 1.3. Check what version these clients actually speak.",
      "Find the property every guess shares and no shopper's browser has.",
    ],
    whys: {
      show: "Promo validations failing far above baseline on checkout-api.",
      signals: "Almost every validation is a code that doesn't exist, with an empty cart, four codes per address: guessing spread across proxies.",
      top: "Carrier NAT tops the list at ~13 a minute; each guesser sends well under one. A per-IP limit or top-N block catches nothing.",
      tell: "One JA4 that speaks only TLS 1.2 with HTTP/1.1 carries the guesses from 28,000 addresses claiming Chrome 126, which offers TLS 1.3 and h2.",
      fix: "Blocks the one TLS client the guessers share; no browser our customers use presents it.",
      rules: "The rule matches the guessing and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "promo code guessing via residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 420,
    postmortem: {
      question: "Why didn't last spring's per-IP rate limit work this time?",
      options: [
        "The guessers moved to TLS 1.3, which the WAF can't rate-limit",
        "Each guessing address sent a few requests an hour, not a minute",
        "WELCOME codes are validated on a path the WAF doesn't see at all",
        "The limit only counts requests that come with a session cookie set",
      ],
      answerIndex: 1,
      explanation: {
        cause: "28,000 residential proxies each guessed a few codes an hour, all through one TLS 1.2-only client.",
        why: "A per-IP limit only stops addresses faster than the limit, and these were slower than real shoppers. The kit claimed Chrome 126 yet spoke only TLS 1.2 over HTTP/1.1; that JA4 matched every guess and no customer.",
        tell: "siem search promo-tls: a TLS 1.2-only JA4 behind 28,000 addresses, each with a Chrome/126 User-Agent.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-referral-signup-farm",
    seed: "sec-t4-referral-signup-farm",
    title: "A thousand new friends an hour",
    severity: "SEV2",
    opensAt: 15 * 3600 + 50 * 60,
    briefing:
      "Fake accounts are being created against POST /accounts on checkout-api, each one claiming a $15 referral credit for a handful of referrers. The sign-ups come through residential proxies and the load is failing checkouts.",
    roleBriefing:
      "SOC on-call: siem and waf. Account creation is 25× baseline, every one carries a referral code, and each address signs up once or twice an hour. Rate limits and range blocks will hit our real sign-ups long before the farm.",
    alert: { id: "SEC-5447", title: "New-account creation 25× baseline with referral codes attached", rule: "growth.signup.referral_velocity", severity: "medium", openedAt: -200 },
    attack: {
      label: "referral sign-up farming",
      path: "/accounts",
      requestsPerSecond: 190,
      growthPerSecond: 0.05,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    },
    ips: 44_000,
    ja4: "t13d1812h2_e8a523a41297_4f04edce68a7",
    ja4Label: "unlisted (18 ciphers, 12 ext)",
    userAgentShort: "Chrome/141.0.0.0 (Mac)",
    customerPerMinute: 18,
    signals: {
      name: "signup-referrals",
      description: "New accounts and referral claims against the 7-day baseline",
      heading: "Account creation · POST /accounts",
      rows: [
        share("new accounts carrying a referral code", 0.99, 0.12),
        tally("distinct referral codes used (last 15 min)", 9, 41),
        share("new accounts with a verified email", 0.01, 0.88),
        tally("referral credit issued / min ($15 each)", 160, 2),
      ],
    },
    fingerprints: { name: "signup-tls", description: "Account creation by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 22%. SEC-5447 (medium): new-account creation 25× baseline with referral codes. Assigned to SOC on-call (you)." },
      { at: 40, from: "Jonah Weiss · Growth", text: "Nine referral codes are collecting all of it. That's $15 a sign-up into nine wallets." },
      { at: 95, from: "Sam Tan · Eng manager", text: "Rate-limit /accounts to a couple a minute. Real people sign up once." },
      { at: 170, from: "Lena Park · SOC lead", text: "Each address already signs up once or twice an hour. Your limit would have to be lower than that, and then it's customers it catches." },
      { at: 250, from: "Maya Okonkwo · Support", text: "Customers in the afternoon sale are getting checkout errors." },
    ],
    hints: [
      "The User-Agent is a current Chrome. Don't take its word for it.",
      "A real Chrome opens TLS the same way on every machine. Count what this client offers and compare.",
      "Anything keyed on the address lands on the carriers and ISPs our customers share with the farm.",
    ],
    whys: {
      show: "New accounts with referral codes far above baseline, on checkout-api's sign-up endpoint.",
      signals: "Nearly every sign-up carries one of nine referral codes and almost none verify an email: a farm cashing referral credit.",
      top: "Phone carriers lead the list; each farm address sends a sign-up every half hour or so. A limit or top-N block catches customers, not the farm.",
      tell: "One JA4 with 18 ciphers and 12 extensions carries the sign-ups from 44,000 addresses, all claiming Chrome 141, whose own fingerprint (15 ciphers, 17 extensions) sits right below it.",
      fix: "Blocks the one TLS client every farm account shares; real Chrome presents a different JA4.",
      rules: "The rule matches the farm and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "referral sign-up farm via residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 240,
    postmortem: {
      question: "What gave the farm away when its User-Agent matched a current Chrome?",
      options: [
        "Its TLS handshake differed from the one Chrome 141 makes",
        "All of its accounts were created from one hosting provider's ranges",
        "Its sign-ups arrived much faster per address than real customers' did",
        "It never sent cookies, which current Chrome always attaches to sign-up",
      ],
      answerIndex: 0,
      explanation: {
        cause: "A sign-up farm on 44,000 residential proxies, one HTTP library pretending to be Chrome 141.",
        why: "Copying a User-Agent string is trivial; copying Chrome's ClientHello isn't. The farm offered 18 ciphers and 12 extensions where Chrome offers 15 and 17, so its JA4 matched only the farm, while every address-based control landed on customers first.",
        tell: "siem search signup-tls: one unlisted JA4 with a Chrome/141 User-Agent behind 44,000 addresses, next to Chrome's real fingerprint.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-sms-pumping",
    seed: "sec-t4-sms-pumping",
    title: "Texts to numbers nobody owns",
    severity: "SEV2",
    opensAt: 3 * 3600 + 10 * 60,
    briefing:
      "Someone is pumping SMS verification codes, POST /otp/send on checkout-api, to premium-rate number ranges they get a cut of. Every text costs us, the requests come through residential proxies claiming to be our Android app, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. OTP sends to international premium ranges are 50× baseline. The requests say they're the Marlow Android app, from carrier and ISP addresses, a send or two an hour each. The usual per-IP limit on OTP does nothing here.",
    alert: { id: "SEC-5460", title: "SMS verification sends to premium-rate prefixes far above baseline", rule: "messaging.otp.premium_prefix_ratio", severity: "high", openedAt: -300 },
    attack: {
      label: "SMS pumping",
      path: "/otp/send",
      requestsPerSecond: 230,
      growthPerSecond: 0.07,
      userAgent: "Marlow/7.3.0 (Android 15; Pixel 8) okhttp/4.12.0",
    },
    ips: 31_000,
    ja4: "t13d2310h2_5ad5e9d1b8f4_0c2e9d7a3b61",
    ja4Label: "unlisted (23 ciphers, 10 ext)",
    userAgentShort: "Marlow/7.3.0 (Android 15)",
    customerPerMinute: 70,
    signals: {
      name: "otp-sends",
      description: "SMS verification sends against the 7-day baseline",
      heading: "SMS verification · POST /otp/send",
      rows: [
        share("sends to international premium-rate ranges", 0.91, 0.002),
        share("codes entered after the send", 0.003, 0.84),
        tally("SMS spend / min (USD)", 410, 3),
        tally("distinct destination numbers per source IP (p99)", 2, 2),
      ],
    },
    fingerprints: { name: "otp-tls", description: "OTP sends by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 25%. SEC-5460 (high): SMS verification sends to premium-rate prefixes. Assigned to SOC on-call (you)." },
      { at: 45, from: "Tomás Ferreira · Messaging platform", text: "Our SMS provider just flagged a spend spike: $400 a minute, almost all to premium international ranges." },
      { at: 100, from: "Sam Tan · Eng manager", text: "The OTP endpoint has a 5-a-minute limit already. Tighten it to one?" },
      { at: 170, from: "Lena Park · SOC lead", text: "These addresses send one text an hour. A limit of one a minute is a hundred times too loose, and anything tighter locks out real logins." },
      { at: 260, from: "Elena Ruiz · VP Engineering", text: "Finance wants the bleed stopped, but don't break sign-in for the app." },
    ],
    hints: [
      "The User-Agent says it's our own Android app. Our app's traffic has a shape of its own; compare.",
      "Every address sends a text or two an hour. Nothing keyed on the address can tell them from customers.",
      "Look at how these clients open TLS, and which of our real clients opens it the same way.",
    ],
    whys: {
      show: "OTP sends to premium-rate prefixes far above baseline, on checkout-api's SMS endpoint.",
      signals: "Nine in ten sends go to premium ranges, almost no codes are entered, and the bill is ~$400 a minute: SMS pumping.",
      top: "Carrier NAT leads the list; each pumping address sends a text an hour. Limits and top-N blocks catch real logins first.",
      tell: "One unlisted JA4 carries the sends from 31,000 addresses claiming Marlow/7.3.0 for Android. The real app's traffic sits in its own row, on fingerprints of its own.",
      fix: "Blocks the one TLS client every pumper shares; neither our apps nor customers' browsers present it.",
      rules: "The rule matches the pumping and 0% of checkout; sends and 5xx fall within seconds.",
    },
    resolveNote: "SMS pumping via residential proxies spoofing the Android UA, blocked by JA4",
    lostCheckoutsPerPoint: 280,
    postmortem: {
      question: "How could one block stop pumping that claimed to be our own Android app?",
      options: [
        "The real app signs every request, and the pumpers' signatures failed",
        "The pumpers all came from one carrier's NAT address",
        "Its TLS fingerprint matched neither our app nor any customer browser",
        "OTP sends to premium-rate prefixes are refused by the WAF's own country filter",
      ],
      answerIndex: 2,
      explanation: {
        cause: "An SMS-pumping kit on 31,000 residential proxies, spoofing the Android app's User-Agent over its own TLS stack.",
        why: "Each address sent a text or two an hour from the same networks customers use, so per-IP limits could only lock out real logins. The kit copied the app's User-Agent but not okhttp's ClientHello, so its JA4 was unique to the pumpers.",
        tell: "siem search otp-tls: one unlisted JA4 behind 31,000 addresses with a Marlow/7.3.0 Android User-Agent, separate from the apps' own traffic.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-cart-hold-scalpers",
    seed: "sec-t4-cart-hold-scalpers",
    title: "Sold out, and nobody bought anything",
    severity: "SEV1",
    opensAt: 10 * 3600,
    briefing:
      "The limited Halden runner went live at 10:00 and was 'sold out' within a minute, but almost nothing has been paid for. Scalper bots are holding every pair in carts through POST /cart/items on checkout-api, renewing the holds through residential proxies, and checkout is failing under them.",
    roleBriefing:
      "SOC on-call: siem and waf. Cart adds for the drop SKU are 60× sell-through, from home and phone addresses, each adding a pair every couple of minutes. We rate-limited the last drop and it made no difference. Find what the bots can't change.",
    alert: { id: "SEC-5476", title: "Limited-release SKU held in carts far beyond sell-through", rule: "inventory.cart.hold_without_checkout", severity: "high", openedAt: -30 },
    attack: {
      label: "cart-hold scalping",
      path: "/cart/items",
      requestsPerSecond: 340,
      growthPerSecond: 0.12,
      userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
    },
    ips: 60_000,
    ja4: "t13d4907h1_0d4cb1c9e1a1_29b5a4f1e2d0",
    ja4Label: "unlisted (49 ciphers, h1 only)",
    userAgentShort: "Chrome/120 Mobile (Android)",
    customerPerMinute: 380,
    signals: {
      name: "drop-carts",
      description: "Cart adds and holds for the limited drop against the 7-day baseline",
      heading: "Cart adds · POST /cart/items",
      rows: [
        share("adds for SKU HALDEN-RUN-LTD", 0.97, 0.0),
        share("holds renewed before expiry without a checkout", 0.94, 0.02),
        share("held pairs paid for", 0.01, 0.38),
        tally("distinct carts per source IP (p99)", 2, 2),
      ],
    },
    fingerprints: { name: "drop-tls", description: "Cart adds by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 44%. SEC-5476 (high): limited-release SKU held in carts far beyond sell-through. Assigned to SOC on-call (you)." },
      { at: 20, from: "Aiyana Brooks · Merchandising", text: "The Halden drop shows sold out and we've sold 31 pairs out of 2,400. Social is on fire." },
      { at: 70, from: "Sam Tan · Eng manager", text: "Last drop we rate-limited /cart/items to 10 a minute. Do that again?" },
      { at: 130, from: "Lena Park · SOC lead", text: "We did, and the bots never noticed: none of them came close to 10 a minute. Look at what they share instead." },
      { at: 200, from: "Maya Okonkwo · Support", text: "People who did get a pair can't pay for it. Checkout is erroring." },
      { at: 290, from: "Elena Ruiz · VP Engineering", text: "Release the holds after, but stop the bots first, without blocking real buyers." },
    ],
    hints: [
      "Last drop's limit didn't touch them, and it won't now: no address is busy.",
      "The bots claim to be Chrome on Android. Real Chrome on Android negotiates HTTP/2.",
      "Put the drop traffic side by side with the browsers customers use and see what's left over.",
    ],
    whys: {
      show: "Drop SKU held in carts far beyond sell-through, on checkout-api's cart endpoint.",
      signals: "Nearly every add is the drop SKU, holds renew without checkout, almost none are paid: scalper bots holding stock.",
      top: "Carrier NAT tops the list; each bot adds a pair every couple of minutes. Rate limits and top-N blocks have nothing to grab.",
      tell: "One JA4 with 49 ciphers and HTTP/1.1 only carries the adds from 60,000 addresses claiming Chrome 120 on Android, which offers h2 and 15 ciphers.",
      fix: "Blocks the one TLS client every scalper shares; no customer browser presents it.",
      rules: "The rule matches the scalpers and 0% of checkout; the 5xx drain and holds start expiring.",
    },
    resolveNote: "cart-hold scalpers on the Halden drop via residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 450,
    postmortem: {
      question: "Why did the /cart/items rate limit leave the scalpers untouched again?",
      options: [
        "The bots used a new cart for every add, which resets the limit",
        "No single bot address came close to the per-IP limit",
        "Rate limits only apply after the first checkout attempt in a session",
        "The scalpers went through a CDN whose addresses the WAF trusts and never limits",
      ],
      answerIndex: 1,
      explanation: {
        cause: "60,000 residential proxies each renewed a hold every couple of minutes, all through one HTTP/1.1-only client.",
        why: "A per-IP limit only bites above the limit, and each bot sat far below any busy shopper. The bots claimed Chrome on Android but offered 49 ciphers and no h2; that JA4 matched every scalper and no buyer.",
        tell: "siem search drop-tls: one unlisted JA4 behind 60,000 addresses with a Chrome/120 Android User-Agent.",
      },
    },
  },
  {
    kind: "proxies",
    slug: "sec-t4-mfa-code-guessing",
    seed: "sec-t4-mfa-code-guessing",
    title: "Six digits, forty thousand tries",
    severity: "SEV1",
    opensAt: 19 * 3600 + 35 * 60,
    briefing:
      "Attackers holding stolen passwords are guessing the six-digit sign-in codes on POST /session/verify, checkout-api, from residential proxies. Each code allows five tries per account, so they spread the guesses across thousands of accounts and addresses, and checkout is drowning.",
    roleBriefing:
      "SOC on-call: siem and waf. MFA failures are 35× normal. Each address tries a code or two every few minutes, so the per-IP limits we keep on sign-in don't fire. The pager wants it stopped without locking out the people who really are signing in.",
    alert: { id: "SEC-5489", title: "MFA verification failures far above baseline on POST /session/verify", rule: "auth.mfa.failure_ratio_anomaly", severity: "critical", openedAt: -75 },
    attack: {
      label: "MFA code guessing",
      path: "/session/verify",
      requestsPerSecond: 320,
      growthPerSecond: 0.09,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    },
    ips: 40_000,
    ja4: "t13d1306h2_2e0a2c9f6a71_6cd5f2b7e9a4",
    ja4Label: "unlisted (13 ciphers, 6 ext)",
    userAgentShort: "Safari 17.2 (Mac)",
    customerPerMinute: 160,
    signals: {
      name: "mfa-verifications",
      description: "MFA code checks against the 7-day baseline",
      heading: "MFA verification · POST /session/verify",
      rows: [
        share("code checks that fail", 0.995, 0.06),
        tally("accounts at the 5-try lockout", 380, 2),
        tally("successful verifications from a new device", 14, 3),
        tally("distinct accounts per source IP (p99)", 2, 1),
      ],
    },
    fingerprints: { name: "mfa-tls", description: "MFA checks by TLS client fingerprint (JA4)" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 43%. SEC-5489 (critical): MFA verification failures far above baseline. Assigned to SOC on-call (you)." },
      { at: 30, from: "Dev Raman · Identity team", text: "Fourteen accounts verified from new devices in the last few minutes. That's the guessing working, one in a million at a time." },
      { at: 85, from: "Sam Tan · Eng manager", text: "Block AS7922 for an hour? Comcast is a big chunk of this." },
      { at: 150, from: "Lena Park · SOC lead", text: "Comcast is a quarter of the bots and a big slice of our customers. Find what all of the bots have in common." },
      { at: 220, from: "Maya Okonkwo · Support", text: "Customers locked out after five wrong codes they never typed." },
    ],
    hints: [
      "Blocking a network takes a slice of the bots and a slice of the customers in equal measure.",
      "The requests claim to be desktop Safari. See whether the handshake behind them is Safari's.",
      "Spread-out guessing hides in volume, not in fingerprints.",
    ],
    whys: {
      show: "MFA failures far above baseline on checkout-api's verification endpoint, rated critical.",
      signals: "Almost every check fails, hundreds of accounts hit lockout, and a handful of guesses land: distributed code guessing.",
      top: "Carrier NAT leads the list; each guessing address sends a check every few minutes. A limit or top-N block catches customers.",
      tell: "One JA4 with 13 ciphers and 6 extensions carries the checks from 40,000 addresses claiming Safari 17.2. Safari's own fingerprint sits two rows down.",
      fix: "Blocks the one TLS client every guesser shares; no customer browser presents it.",
      rules: "The rule matches the guessing and 0% of checkout; failures and 5xx fall within seconds.",
    },
    resolveNote: "distributed MFA code guessing via residential proxies, blocked by JA4",
    lostCheckoutsPerPoint: 420,
    postmortem: {
      question: "Why would blocking Comcast's ranges have been the wrong move?",
      options: [
        "Comcast rotates its customers' addresses every few minutes, so the block would expire",
        "Comcast traffic reaches us over IPv6, which the WAF can't block by range",
        "It held a quarter of the bots and many of our customers alike",
        "The guessers had already moved off Comcast to a mobile carrier's NAT before the page",
      ],
      answerIndex: 2,
      explanation: {
        cause: "MFA guessing from 40,000 residential proxies spread evenly over the carriers and ISPs our customers use, all one TLS client.",
        why: "Blocking a residential network stops its share of bots and its share of customers in the same stroke. The bots claimed Safari 17.2 but opened TLS with 13 ciphers and 6 extensions, a JA4 no customer presents, so that block took all of them and nobody else.",
        tell: "siem search mfa-tls: one unlisted JA4 behind 40,000 addresses with a Safari 17.2 User-Agent, beside Safari's real fingerprint.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-headless-chrome-card-testing",
    seed: "sec-t4-headless-chrome-card-testing",
    title: "Card testers in real Chrome",
    severity: "SEV1",
    opensAt: 8 * 3600 + 25 * 60,
    briefing:
      "Card testers are running stolen cards through POST /checkout in real headless Chrome on rented cloud servers. Their TLS looks exactly like our customers' Chrome, they're slow per address, and checkout-api is shedding requests.",
    roleBriefing:
      "SOC on-call: siem and waf. Authorisation declines are 25× normal. The testers drive genuine Chrome, so their fingerprint is the one 31% of customers present, and each server tries a card every twenty seconds. The rate limit and fingerprint block that ended the last wave won't help here.",
    alert: { id: "SEC-5503", title: "Card testing: authorisation declines spike on POST /checkout", rule: "payments.checkout.decline_velocity", severity: "high", openedAt: -60 },
    attack: {
      label: "card testing",
      path: "/checkout",
      requestsPerSecond: 210,
      growthPerSecond: 0.04,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    },
    ranges: [
      { cidr: "44.200.0.0/16", asn: 14618, network: "AMAZON-AES", ips: 2_400 },
      { cidr: "18.204.0.0/16", asn: 16509, network: "AMAZON-02", ips: 1_800 },
    ],
    browser: "Chromium Browser",
    customerPerMinute: 7_200,
    signals: {
      name: "decline-velocity",
      description: "Card authorisation signals on checkout against the 7-day baseline",
      heading: "Card authorisations · POST /checkout",
      rows: [
        share("authorisations under $2.00", 0.88, 0.001),
        share("issuer decline rate", 0.68, 0.023),
        tally("distinct cards per session (p99)", 31, 1),
        share("sessions with no product page view", 0.97, 0.02),
      ],
    },
    networks: { name: "decline-networks", description: "Checkout requests by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 34%. SEC-5503 (high): card testing, authorisation declines spiking. Assigned to SOC on-call (you)." },
      { at: 30, from: "Rafa Moreno · Payments ops", text: "Declines are through the roof and it's all $1 auths. The acquirer will start asking questions within the hour." },
      { at: 85, from: "Sam Tan · Eng manager", text: "Last month we blocked their JA4 and it was over. Same again?" },
      { at: 150, from: "Lena Park · SOC lead", text: "Last month they used a Go client. Check the fingerprint before you block it: if it's Chrome's, that's a third of our customers." },
      { at: 230, from: "Maya Okonkwo · Support", text: "Customers say one checkout in three fails." },
    ],
    hints: [
      "This time the fingerprint is genuine Chrome. Blocking it blocks the customers who use Chrome.",
      "Each tester is slower than hundreds of shoppers, so nothing keyed on volume per address will catch them.",
      "Real customers don't check out from cloud servers. Look at where the traffic comes from, as networks.",
    ],
    whys: {
      show: "Card-testing declines spiking on POST /checkout.",
      signals: "$1 auths, dozens of cards per session, sessions with no browsing: card testing, from something that runs a real browser.",
      top: "Carrier NAT tops the list at ~13 a minute; each tester sends 3. A limit or top-N block would catch shoppers.",
      tell: "Two AWS ranges hold 4,200 addresses, all presenting Chromium's JA4, the same one 31% of customers present. No customer traffic comes from either range.",
      fix: "AMAZON-AES's 2,400 testers in 44.200.0.0/16; the preview shows 0% of checkout customers.",
      rules: "Both range rules match the testers and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "card testing in headless Chrome from two AWS ranges, blocked by range",
    lostCheckoutsPerPoint: 360,
    postmortem: {
      question: "Why wouldn't last month's fingerprint block work against this wave?",
      options: [
        "The testers drove real Chrome, so their JA4 was our customers'",
        "The testers changed their JA4 hash every few minutes to dodge it",
        "JA4 rules only match on the first request of each TLS session",
        "AWS strips TLS fingerprints at its load balancers before the WAF",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Card testers drove genuine headless Chrome from 4,200 addresses in two AWS ranges, about three requests a minute each.",
        why: "A real browser presents the same ClientHello as a customer's, so the JA4 block that stopped a Go client would have stopped 31% of customers. The testers were also too slow for limits or top-N blocks. What no customer shares is the cloud: both ranges carried testers and nobody else.",
        tell: "siem search decline-networks: two Amazon ranges with 4,200 addresses all on Chromium's JA4, and no customer traffic from either.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-safari-farm-stuffing",
    seed: "sec-t4-safari-farm-stuffing",
    title: "Credential stuffing in a Mac mini rack",
    severity: "SEV1",
    opensAt: 5 * 3600 + 45 * 60,
    briefing:
      "A combo list is being replayed against sign-in, POST /session on checkout-api, from a rented fleet of Mac minis driving real Safari through safaridriver. The TLS is genuine Safari, each machine is slow, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. Sign-in failures are 30× normal. The fingerprint is Safari's own, 17% of customers present it, and every address stays under 4 attempts a minute. Rate limits won't fire and a JA4 block would lock out iPhone shoppers.",
    alert: { id: "SEC-5517", title: "Sign-in failures from hosting networks far above baseline", rule: "auth.session.hosting_failure_ratio", severity: "high", openedAt: -120 },
    attack: {
      label: "credential stuffing",
      path: "/session",
      requestsPerSecond: 260,
      growthPerSecond: 0.06,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    },
    ranges: [
      { cidr: "85.17.0.0/16", asn: 60781, network: "LEASEWEB-NL-AMS-01", ips: 3_200 },
      { cidr: "51.38.0.0/16", asn: 16276, network: "OVH", ips: 1_600 },
    ],
    browser: "Safari",
    customerPerMinute: 604,
    signals: {
      name: "signin-failures",
      description: "Sign-ins against the 7-day baseline",
      heading: "Sign-ins · POST /session",
      rows: [
        share("sign-in success ratio", 0.012, 0.976),
        tally("distinct usernames per source IP (p99)", 41, 3),
        share("sign-ins from hosting / VPN ASNs", 0.93, 0.005),
        tally("accounts locked out (failed-attempt limit)", 290, 2),
      ],
    },
    networks: { name: "signin-networks", description: "Sign-ins by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 39%. SEC-5517 (high): sign-in failures from hosting networks. Assigned to SOC on-call (you)." },
      { at: 25, from: "Dev Raman · Identity team", text: "It's a combo list again, but the requests look like Safari down to the handshake. Somebody's paying for real Macs." },
      { at: 80, from: "Sam Tan · Eng manager", text: "Put a 2-a-minute limit on /session. Nobody signs in more than that." },
      { at: 145, from: "Lena Park · SOC lead", text: "Each of those machines does three or four a minute, and carrier NAT does more. A 2-a-minute limit locks out phones." },
      { at: 220, from: "Maya Okonkwo · Support", text: "Customers locked out of accounts they haven't touched in weeks." },
    ],
    hints: [
      "The handshake is genuinely Safari's. Whatever you block has to be something iPhone shoppers don't share.",
      "No customer signs in from a datacenter in Amsterdam.",
      "A per-address limit low enough to catch three attempts a minute catches a phone carrier's NAT first.",
    ],
    whys: {
      show: "Sign-in failures from hosting networks far above baseline, on checkout-api's sign-in.",
      signals: "Success near 1%, dozens of usernames per address, almost all from hosting: stuffing, with real browsers.",
      top: "Carrier NAT tops the list; each Mac sends three or four a minute. A per-IP limit or top-N block catches customers first.",
      tell: "Two hosting ranges, Leaseweb and OVH, hold 4,800 addresses, every one presenting Safari's own JA4, which 17% of customers share. No customer signs in from either.",
      fix: "Leaseweb's 3,200 Macs in 85.17.0.0/16; the preview shows 0% of checkout customers.",
      rules: "Both range rules match the stuffing and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "credential stuffing from a Safari Mac farm on Leaseweb and OVH, blocked by range",
    lostCheckoutsPerPoint: 400,
    postmortem: {
      question: "What could be blocked without locking out iPhone shoppers?",
      options: [
        "Safari's JA4 fingerprint, for the length of the incident only",
        "Every address sending more than two sign-ins a minute",
        "The two hosting ranges the Macs were rented in",
        "Sign-ins whose User-Agent claims macOS 10.15.7 rather than a newer macOS release",
      ],
      answerIndex: 2,
      explanation: {
        cause: "A combo list replayed by real Safari on 4,800 rented Macs in two hosting ranges, three or four attempts a minute each.",
        why: "Genuine Safari makes Safari's ClientHello, so a JA4 block would have taken 17% of customers. Each Mac was slower than carrier NAT, so limits caught phones first. Customers don't sign in from Leaseweb or OVH, and blocking those two ranges stopped every attempt.",
        tell: "siem search signin-networks: Leaseweb and OVH ranges holding 4,800 addresses, all on Safari's JA4, with no customer sign-ins from either.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-firefox-raffle-bots",
    seed: "sec-t4-firefox-raffle-bots",
    title: "Raffle entries from a single droplet range",
    severity: "SEV2",
    opensAt: 12 * 3600 + 5 * 60,
    briefing:
      "The Kestrel jacket raffle opened at noon on POST /raffle/entries, checkout-api, and bots are entering thousands of fake accounts. They drive real Firefox through Playwright from DigitalOcean droplets, slowly, and checkout is failing under them.",
    roleBriefing:
      "SOC on-call: siem and waf. Raffle entries are 30× expected. The bots' TLS is genuine Firefox, which some customers use, and each droplet enters every twenty seconds or so. Limits and top-N blocks catch customers, not the bots.",
    alert: { id: "SEC-5524", title: "Raffle entries from new accounts far above forecast", rule: "growth.raffle.new_account_entry_ratio", severity: "medium", openedAt: -40 },
    attack: {
      label: "raffle entry bots",
      path: "/raffle/entries",
      requestsPerSecond: 180,
      growthPerSecond: 0.05,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
    },
    ranges: [{ cidr: "164.90.128.0/17", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 3_500 }],
    browser: "Mozilla Firefox",
    customerPerMinute: 260,
    signals: {
      name: "raffle-entries",
      description: "Raffle entries against the launch forecast",
      heading: "Raffle entries · POST /raffle/entries",
      rows: [
        share("entries from accounts under 24 h old", 0.96, 0.05),
        share("entries with a shipping address seen on 10+ accounts", 0.81, 0.001),
        share("entries from Linux desktops", 0.98, 0.01),
        tally("distinct accounts per source IP (p99)", 6, 1),
      ],
    },
    networks: { name: "raffle-networks", description: "Raffle entries by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 21%. SEC-5524 (medium): raffle entries from new accounts far above forecast. Assigned to SOC on-call (you)." },
      { at: 35, from: "Aiyana Brooks · Merchandising", text: "40,000 entries for 300 jackets, and most of them ship to the same twelve addresses." },
      { at: 90, from: "Sam Tan · Eng manager", text: "Firefox is barely 3% of our traffic. Just block the Firefox fingerprint for the afternoon?" },
      { at: 160, from: "Lena Park · SOC lead", text: "That 3% is real customers, and an objective on this page. The bots are in one place; find it." },
      { at: 240, from: "Maya Okonkwo · Support", text: "Customers in the noon sale are getting checkout errors." },
    ],
    hints: [
      "The browser is real Firefox. A few percent of our customers would go with it.",
      "Each bot enters a few times a minute, slower than plenty of shoppers.",
      "Look at the networks the entries come from. Real entrants don't live in a datacenter.",
    ],
    whys: {
      show: "Raffle entries from brand-new accounts far above forecast, on checkout-api.",
      signals: "Brand-new accounts, shared shipping addresses, Linux desktops: a bot fleet, in a real browser.",
      top: "Carrier NAT leads at ~13 a minute; each droplet sends about 3. A limit or top-N block catches shoppers.",
      tell: "One DigitalOcean /17 holds 3,500 addresses, all on Firefox's genuine JA4, which 3% of customers share. No customer traffic comes from it.",
      fix: "Blocks every droplet in the range; the preview shows 0% of checkout customers.",
      rules: "The range rule matches the bots and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "raffle bots in Playwright Firefox from DigitalOcean, blocked by range",
    lostCheckoutsPerPoint: 220,
    postmortem: {
      question: "Why was blocking the Firefox fingerprint the wrong call?",
      options: [
        "Playwright changes Firefox's fingerprint on every launch",
        "It was real Firefox's JA4, shared with customers",
        "JA4 blocks only apply to HTTP/2, and the bots spoke HTTP/1.1",
        "Firefox traffic is exempt from the WAF under a rule left by the web team",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Raffle bots drove real Firefox through Playwright from 3,500 DigitalOcean droplets in one /17.",
        why: "A real browser presents its real ClientHello, so the JA4 matched the 3% of customers on Firefox as well as the bots. Each droplet was slower than busy shoppers, so limits and top-N blocks had nothing. The droplets all sat in one hosting range that no customer uses.",
        tell: "siem search raffle-networks: DIGITALOCEAN-ASN with 3,500 addresses in 164.90.128.0/17, all on Firefox's JA4, and no customers.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-card-vaulting-chrome",
    seed: "sec-t4-card-vaulting-chrome",
    title: "Zero-dollar checks from two clouds",
    severity: "SEV2",
    opensAt: 1 * 3600 + 20 * 60,
    briefing:
      "Stolen cards are being validated through the saved-card flow, POST /payment-methods on checkout-api, which runs a $0 authorisation on each. The validators run real Chrome on Hetzner and Vultr servers, a card every twenty seconds each, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. Zero-dollar auths are 40× baseline and mostly declined. The TLS is genuine Chrome and every server is slower than our busiest shoppers. Limits, top-N blocks and the fingerprint all land on customers.",
    alert: { id: "SEC-5538", title: "Zero-dollar card verifications far above baseline on POST /payment-methods", rule: "payments.vault.zero_auth_velocity", severity: "high", openedAt: -180 },
    attack: {
      label: "card validation",
      path: "/payment-methods",
      requestsPerSecond: 200,
      growthPerSecond: 0.04,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    },
    ranges: [
      { cidr: "65.108.0.0/16", asn: 24940, network: "HETZNER-AS", ips: 2_600 },
      { cidr: "45.76.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 1_400 },
    ],
    browser: "Chromium Browser",
    customerPerMinute: 55,
    signals: {
      name: "vault-auths",
      description: "Saved-card verifications against the 7-day baseline",
      heading: "Card verifications · POST /payment-methods",
      rows: [
        share("$0 verifications declined by the issuer", 0.74, 0.03),
        tally("cards added per account (p99)", 18, 1),
        share("accounts adding a card with no order in 90 days", 0.97, 0.21),
        tally("distinct BINs in the last 15 min", 960, 70),
      ],
    },
    networks: { name: "vault-networks", description: "Card verifications by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 23%. SEC-5538 (high): zero-dollar card verifications far above baseline. Assigned to SOC on-call (you)." },
      { at: 40, from: "Rafa Moreno · Payments ops", text: "Visa's monitoring program counts $0 auth declines too. We don't want to be in it." },
      { at: 100, from: "Sam Tan · Eng manager", text: "Rate-limit /payment-methods to 10 a minute per IP, that's generous." },
      { at: 165, from: "Lena Park · SOC lead", text: "Each validator does three a minute. Ten a minute is generous to them too." },
      { at: 245, from: "Maya Okonkwo · Support", text: "Night-shift customers abroad say checkout keeps failing." },
    ],
    hints: [
      "Each validator stays under three requests a minute. Nothing keyed on volume per address will see them.",
      "The fingerprint is Chrome's own. A third of customers present it too.",
      "Nobody saves a card from a rented server. Look at the traffic by network.",
    ],
    whys: {
      show: "Zero-dollar verifications far above baseline, on checkout-api's saved-card flow.",
      signals: "Mostly declined $0 auths, a dozen and more cards per account, hundreds of BINs: card validation.",
      top: "Carrier NAT leads at ~13 a minute; each validator sends about 3. Limits and top-N blocks catch shoppers.",
      tell: "Hetzner and Vultr ranges hold 4,000 addresses, all on Chromium's JA4. Customers share the fingerprint, not the networks.",
      fix: "Hetzner's 2,600 validators in 65.108.0.0/16; the preview shows 0% of checkout customers.",
      rules: "Both range rules match the validators and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "card validation via $0 auths in Chrome from Hetzner and Vultr, blocked by range",
    lostCheckoutsPerPoint: 240,
    postmortem: {
      question: "What did the validators share that no customer did?",
      options: [
        "A JA4 fingerprint that no real browser presents",
        "A request rate far above any customer address",
        "Origin in two hosting ranges",
        "A User-Agent naming an old Chrome on Windows 7, which no customer runs",
      ],
      answerIndex: 2,
      explanation: {
        cause: "Real Chrome on 4,000 Hetzner and Vultr servers ran stolen cards through $0 verifications, three a minute each.",
        why: "Genuine Chrome presents the JA4 a third of customers share, and three a minute is slower than carrier NAT, so fingerprint blocks, limits and top-N blocks all hit customers first. Both ranges carried validators and no customers.",
        tell: "siem search vault-networks: HETZNER-AS and AS-CHOOPA ranges holding 4,000 addresses on Chromium's JA4, with no customer traffic.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-address-validation-abuse",
    seed: "sec-t4-address-validation-abuse",
    title: "Someone else's mailing list on our bill",
    severity: "SEV2",
    opensAt: 14 * 3600 + 15 * 60,
    briefing:
      "Our address validation, POST /addresses/validate on checkout-api, which calls a paid postal lookup per request, is being used to clean someone's mailing list. Selenium drives real Chrome from Google Cloud, a lookup every twenty seconds per VM, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. Address lookups are 30× baseline, almost none from a cart. Each VM is slow and its TLS is genuine Chrome. The per-IP limit on validation never fires and a fingerprint block would hit a third of shoppers.",
    alert: { id: "SEC-5552", title: "Address validation lookups without a cart far above baseline", rule: "checkout.address.validate_without_cart", severity: "medium", openedAt: -240 },
    attack: {
      label: "address validation abuse",
      path: "/addresses/validate",
      requestsPerSecond: 170,
      growthPerSecond: 0.05,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
    ranges: [{ cidr: "34.118.0.0/16", asn: 396982, network: "GOOGLE-CLOUD-PLATFORM", ips: 3_000 }],
    browser: "Chromium Browser",
    customerPerMinute: 120,
    signals: {
      name: "address-lookups",
      description: "Address validation lookups against the 7-day baseline",
      heading: "Address validation · POST /addresses/validate",
      rows: [
        share("lookups with no cart in the session", 0.98, 0.04),
        share("lookups followed by a checkout within 1 h", 0.003, 0.72),
        tally("postal lookup spend / min (USD)", 38, 1),
        tally("distinct addresses per source IP (p99)", 7, 2),
      ],
    },
    networks: { name: "address-networks", description: "Address lookups by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 19%. SEC-5552 (medium): address validation lookups without a cart. Assigned to SOC on-call (you)." },
      { at: 45, from: "Nadia Haddad · Finance", text: "The postal lookup vendor just emailed about our usage. We're 30× our daily average and it's 2pm." },
      { at: 110, from: "Sam Tan · Eng manager", text: "Can we block the top 1,000 addresses on the validate endpoint?" },
      { at: 180, from: "Lena Park · SOC lead", text: "The top 1,000 on checkout-api are phones behind carrier NAT. The VMs are further down the list than that." },
      { at: 260, from: "Maya Okonkwo · Support", text: "Checkout failing for some customers at the address step." },
    ],
    hints: [
      "The browser is a real Chrome. Customers' Chrome looks the same in the handshake.",
      "The busiest addresses on the list are people's phones, not the VMs.",
      "Ask where the lookups come from, network by network.",
    ],
    whys: {
      show: "Address lookups without a cart far above baseline, on checkout-api.",
      signals: "Lookups with no cart and no checkout after, and a postal bill climbing: list cleaning on our dime.",
      top: "Carrier NAT tops the list; each VM sends about 3 a minute, below hundreds of customers. Top-N and limits miss.",
      tell: "One Google Cloud /16 holds 3,000 addresses, all on Chromium's JA4, which customers share. No customer traffic comes from it.",
      fix: "Blocks every VM in the range; the preview shows 0% of checkout customers.",
      rules: "The range rule matches the lookups and 0% of checkout; the 5xx and the bill stop climbing.",
    },
    resolveNote: "address validation abuse with Selenium Chrome on Google Cloud, blocked by range",
    lostCheckoutsPerPoint: 210,
    postmortem: {
      question: "Why would a top-1,000 block on the validate endpoint have failed?",
      options: [
        "The block list refreshes too slowly to keep up with new VMs",
        "Each VM sent less than hundreds of customer addresses",
        "Google Cloud addresses are exempt from IP blocks at our edge",
        "The top-1,000 list only counts requests that carry a session cookie, and the VMs sent none",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Selenium-driven Chrome on 3,000 Google Cloud VMs in one /16, about three lookups a minute each.",
        why: "The top of the list is carrier NAT, one address in front of thousands of phones, so a top-N block catches customers before any VM. The browser was real Chrome, so the fingerprint was customers' too. Only the range was the VMs' alone.",
        tell: "siem search address-networks: GOOGLE-CLOUD-PLATFORM with 3,000 addresses in 34.118.0.0/16 on Chromium's JA4, and no customers.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-return-label-fraud",
    seed: "sec-t4-return-label-fraud",
    title: "Return labels for orders never shipped",
    severity: "SEV1",
    opensAt: 9 * 3600 + 50 * 60,
    briefing:
      "Prepaid return labels are being generated for orders that never shipped, through POST /returns/labels on checkout-api, by bots in real Chrome spread over three cloud providers. Each label is a refund claim waiting to happen, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. Label requests are 35× baseline and keyed to order numbers guessed in sequence. The bots run genuine Chrome across Azure, Oracle Cloud and Linode, each slower than a shopper. Find every range they live in.",
    alert: { id: "SEC-5566", title: "Return label requests for unshipped orders far above baseline", rule: "returns.label.unshipped_order_ratio", severity: "high", openedAt: -100 },
    attack: {
      label: "return label fraud",
      path: "/returns/labels",
      requestsPerSecond: 230,
      growthPerSecond: 0.05,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    },
    ranges: [
      { cidr: "20.42.0.0/16", asn: 8075, network: "MICROSOFT-CORP-MSN-AS-BLOCK", ips: 2_200 },
      { cidr: "129.146.0.0/16", asn: 31898, network: "ORACLE-BMC-31898", ips: 1_300 },
      { cidr: "172.104.0.0/16", asn: 63949, network: "AKAMAI-LINODE-AP", ips: 900 },
    ],
    browser: "Chromium Browser",
    customerPerMinute: 30,
    signals: {
      name: "return-labels",
      description: "Return label requests against the 7-day baseline",
      heading: "Return labels · POST /returns/labels",
      rows: [
        share("labels for orders not yet shipped", 0.94, 0.01),
        share("order numbers requested in sequence (gap ≤ 3)", 0.91, 0.0),
        tally("labels per account (p99)", 22, 1),
        tally("distinct orders per source IP (p99)", 5, 1),
      ],
    },
    networks: { name: "return-networks", description: "Label requests by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 36%. SEC-5566 (high): return label requests for unshipped orders. Assigned to SOC on-call (you)." },
      { at: 30, from: "Grace Lin · Returns ops", text: "We've issued 1,800 labels this morning for orders still in the warehouse. Somebody's walking our order numbers." },
      { at: 90, from: "Sam Tan · Eng manager", text: "Block Azure? It's the biggest one in the alert." },
      { at: 150, from: "Lena Park · SOC lead", text: "Azure is half of it. Block one cloud and the rest keep going. Find all of them." },
      { at: 230, from: "Maya Okonkwo · Support", text: "Customers are getting checkout errors, and two say they got a return label for an order they just placed." },
    ],
    hints: [
      "The handshake is genuine Chrome, so the fingerprint is a customer's.",
      "There's more than one cloud in this. Stopping the biggest leaves the rest running.",
      "No address is busy, and no limit low enough to catch them spares a phone carrier.",
    ],
    whys: {
      show: "Return labels for unshipped orders far above baseline, on checkout-api.",
      signals: "Labels for orders still in the warehouse, order numbers walked in sequence: fraud, in a real browser.",
      top: "Carrier NAT leads; each bot sends about 3 a minute. Limits and top-N blocks catch shoppers.",
      tell: "Three hosting ranges, Azure, Oracle Cloud and Linode, hold 4,400 addresses, all on Chromium's JA4. No customer traffic comes from any of them.",
      fix: "Azure's 2,200 bots in 20.42.0.0/16; the preview shows 0% of checkout customers. Two more ranges to go.",
      rules: "All three range rules match the bots and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "return label fraud in Chrome across Azure, Oracle Cloud and Linode, blocked by range",
    lostCheckoutsPerPoint: 380,
    postmortem: {
      question: "Why would blocking Azure alone not have ended it?",
      options: [
        "The bots ran in three hosting ranges, not one",
        "Azure's addresses rotate faster than the WAF can block them",
        "The WAF can't block ranges owned by a cloud provider we also use for our own services",
        "Azure was only the bots' entry point, and the real traffic came from residential proxies",
      ],
      answerIndex: 0,
      explanation: {
        cause: "Return-label bots in real Chrome spread over Azure, Oracle Cloud and Linode ranges, about three requests a minute per address.",
        why: "Each range held a share of the bots, so one block stopped only its share. The fingerprint was genuine Chrome and the per-address rate was below carrier NAT, so only the three ranges, together, singled the bots out.",
        tell: "siem search return-networks: three hosting ranges with 4,400 addresses on Chromium's JA4, and no customers in any of them.",
      },
    },
  },
  {
    kind: "farm",
    slug: "sec-t4-shipping-quote-scraper",
    seed: "sec-t4-shipping-quote-scraper",
    title: "A competitor reads our shipping rates",
    severity: "SEV2",
    opensAt: 16 * 3600 + 30 * 60,
    briefing:
      "A competitor is scraping shipping and tax quotes from POST /checkout/quote on checkout-api, postcode by postcode, with real Safari on rented Mac servers at M247 and Scaleway. Each machine is slow and the TLS is Safari's own, and checkout is failing under the load.",
    roleBriefing:
      "SOC on-call: siem and waf. Quote requests are 25× baseline with nothing in the cart. The fingerprint is genuine Safari, which 17% of customers present, and each Mac stays under four requests a minute. Find what is the scraper's alone.",
    alert: { id: "SEC-5581", title: "Shipping quote requests with empty carts far above baseline", rule: "checkout.quote.empty_cart_ratio", severity: "medium", openedAt: -210 },
    attack: {
      label: "quote scraping",
      path: "/checkout/quote",
      requestsPerSecond: 200,
      growthPerSecond: 0.05,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    },
    ranges: [
      { cidr: "51.15.0.0/16", asn: 12876, network: "Online S.a.s.", ips: 2_500 },
      { cidr: "185.94.188.0/22", asn: 9009, network: "M247", ips: 1_000 },
    ],
    browser: "Safari",
    customerPerMinute: 330,
    signals: {
      name: "quote-requests",
      description: "Shipping and tax quote requests against the 7-day baseline",
      heading: "Shipping quotes · POST /checkout/quote",
      rows: [
        share("quotes with an empty cart", 0.97, 0.01),
        share("postcodes requested in sorted order", 0.9, 0.0),
        tally("distinct postcodes per source IP (p99)", 12, 1),
        share("quotes followed by a checkout within 1 h", 0.002, 0.58),
      ],
    },
    networks: { name: "quote-networks", description: "Quote requests by origin network, with each network's top JA4" },
    comms: [
      { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 22%. SEC-5581 (medium): shipping quote requests with empty carts. Assigned to SOC on-call (you)." },
      { at: 40, from: "Owen Price · Logistics", text: "Someone is pricing every postcode in the country in alphabetical order. That's a scraper, not a shopper." },
      { at: 100, from: "Sam Tan · Eng manager", text: "Rate-limit /checkout/quote to 5 a minute. A person needs one quote." },
      { at: 170, from: "Lena Park · SOC lead", text: "Each Mac sends three or four a minute. Five a minute lets every one of them through." },
      { at: 250, from: "Maya Okonkwo · Support", text: "Customers say the shipping estimate spins and then checkout fails." },
    ],
    hints: [
      "Each machine sends fewer quotes a minute than any limit you'd dare set.",
      "Safari is Safari: the handshake matches customers' iPhones and Macs.",
      "Shoppers don't ask for quotes from a datacenter. Group the traffic by where it comes from.",
    ],
    whys: {
      show: "Quote requests with empty carts far above baseline, on checkout-api.",
      signals: "Empty carts, postcodes in sorted order, no checkouts after: a scraper in a real browser.",
      top: "Carrier NAT tops the list; each Mac sends three or four a minute. Limits and top-N blocks miss them.",
      tell: "Scaleway and M247 ranges hold 3,500 addresses, all on Safari's genuine JA4, which customers share. No customer traffic comes from either.",
      fix: "Scaleway's 2,500 Macs in 51.15.0.0/16; the preview shows 0% of checkout customers.",
      rules: "Both range rules match the scraper and 0% of checkout; the 5xx drain within seconds.",
    },
    resolveNote: "shipping quote scraping with Safari on Scaleway and M247, blocked by range",
    lostCheckoutsPerPoint: 230,
    postmortem: {
      question: "Why did a 5-a-minute limit on quotes not slow the scraper?",
      options: [
        "The scraper sent its quotes over HTTP/3, which skips the WAF's limits",
        "Each Mac stayed under the limit",
        "Safari requests are counted per session, not per IP, by the WAF",
        "The limit was set on GET, while the scraper sent POST requests to the quote endpoint",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Real Safari on 3,500 rented Macs in Scaleway and M247 ranges, three or four quotes a minute each.",
        why: "A per-IP limit only stops addresses above it, and every Mac stayed below. Genuine Safari meant its JA4 was customers' too. The two hosting ranges carried the scraper and no shoppers.",
        tell: "siem search quote-networks: Scaleway and M247 ranges with 3,500 addresses on Safari's JA4, and no customer traffic.",
      },
    },
  },
];

export const SECURITY_TIER4_INCIDENTS: readonly Scenario[] = ROWS.map(scenarioOf);
