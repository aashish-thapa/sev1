import type { CommsMessage, Evidence, ExternalService, Objective, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { count } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { Attack, SiemAlert } from "../sim/commerce.ts";
import { BROWSER_JA4 } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT } from "./checkout-cluster.ts";
import { checkoutCommerce } from "./checkout-commerce.ts";
import { alertClosedAs, attackAtEdge, attackedCluster, isAttackStopped, noCustomersBlocked } from "./edge-attack.ts";

/** FoxIO ja4plus-mapping.csv: Python. */
const PYTHON_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
/** FoxIO ja4plus-mapping.csv: GoLang, no ALPN. */
const GO_JA4 = "t13d190900_9dc949149365_97f8aa674fd9";
const SAFARI_JA4 = BROWSER_JA4.find((entry) => entry.client === "Safari")?.ja4 ?? "";
const CHROME_120_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROME_128_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const HEADLESS_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

type AlertSpec = Pick<SiemAlert, "id" | "title" | "rule" | "severity" | "openedAt">;

/** One incident's story and numbers; the builder turns it into a Scenario. */
type Row = {
  readonly id: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAtSecondOfDay: number;
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly attack: Attack;
  /** The real alert: closed true-positive once the attack is contained. */
  readonly alert: AlertSpec;
  /** A second alert the evidence shows is harmless: closed benign. */
  readonly benignAlert?: AlertSpec;
  /** Share of the attack the WAF must stop for the root cause to count as fixed. */
  readonly stoppedShare: number;
  readonly evidence: readonly Evidence[];
  readonly suggestions: readonly string[];
  readonly lostCheckoutsPerPoint: number;
  readonly externals?: readonly ExternalService[];
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  readonly solution: readonly SolutionStep[];
  readonly postmortem: Postmortem;
};

const asAlert = (spec: AlertSpec): SiemAlert => ({ ...spec, autoContainAt: null, containTopIps: 0, resolution: null });

/** Attack requests a minute at the edge, and how many of them the WAF lets through. */
function edge(state: ClusterState): { readonly perMinute: number; readonly past: number } {
  if (!state.commerce) return { perMinute: 0, past: 0 };
  const { perMinute, passed } = attackAtEdge(state.commerce, state.t);
  return { perMinute, past: perMinute * passed };
}

function siem(name: string, description: string, run: (state: ClusterState) => readonly string[]): Evidence {
  return { tool: "siem", name, description, run };
}

function incident(row: Row): Scenario {
  const alerts = [asAlert(row.alert), ...(row.benignAlert ? [asAlert(row.benignAlert)] : [])];
  return {
    id: row.id,
    tier: 2,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: ["security"],
    roleBriefings: { security: row.roleBriefing },
    opensAtSecondOfDay: row.opensAtSecondOfDay,
    seed: row.id,
    initialState: () => attackedCluster(row.id, checkoutCommerce({ attack: row.attack, alerts })),
    isRootCauseFixed: (state) => isAttackStopped(state, row.stoppedShare),
    objectives: (state) => {
      const { commerce } = state;
      if (!commerce) return [];
      const objectives: Objective[] = [noCustomersBlocked(commerce), alertClosedAs(commerce, row.alert.id, "true-positive")];
      if (row.benignAlert) objectives.push(alertClosedAs(commerce, row.benignAlert.id, "benign"));
      return objectives;
    },
    evidence: row.evidence,
    suggestions: { security: row.suggestions },
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: row.externals ?? [],
    comms: row.comms,
    hints: row.hints,
    solution: { security: row.solution },
    postmortem: row.postmortem,
  };
}

// ── 1. Gift-card balance enumeration from one hosting /16; the store kiosks look guilty ──────────

const giftCards: Row = {
  id: "sec-t2-gift-card-enumeration",
  title: "Somebody is guessing gift cards",
  severity: "SEV2",
  opensAtSecondOfDay: 11 * 3600 + 5 * 60,
  briefing:
    "Gift-card balance checks are running at forty times normal and checkout-api is shedding requests. POST /gift-cards/balance lives on the checkout pods. Two things hit that endpoint from cloud addresses today: the in-store kiosks, and something else.",
  roleBriefing:
    "SOC on-call: siem and waf. Something is hammering the gift-card balance endpoint on checkout-api. Retail ops' kiosks also call it from the cloud. Work out which caller is the attack, stop it without turning customers away, and close SEC-6101 correctly.",
  attack: {
    label: "gift-card enumeration",
    path: "/gift-cards/balance",
    requestsPerSecond: 160,
    growthPerSecond: 0.12,
    sources: { kind: "ranges", ranges: [{ cidr: "45.77.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 600 }] },
    ja4: GO_JA4,
    userAgent: "Go-http-client/1.1",
  },
  alert: {
    id: "SEC-6101",
    title: "Gift-card balance lookups: not-found ratio far above baseline",
    rule: "payments.giftcard.balance_enumeration",
    severity: "high",
    openedAt: -150,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("giftcard-lookups", "Gift-card balance lookups by source network", (state) => {
      const { past } = edge(state);
      return [
        "POST /gift-cards/balance by ClientASN · last 15 min",
        ...table([
          ["ClientASN", "NETWORK", "ClientIP (distinct)", "LOOKUPS/MIN", "CARD NOT FOUND", "ClientRequestUserAgent"],
          ["20473", "AS-CHOOPA (Vultr)", "600", count(past), "99.6%", "Go-http-client/1.1"],
          ["16509", "AMAZON-02", "38", "41", "1.8%", "MarlowKiosk/3.2 (store-pos; eu-west-1)"],
          ["21928", "T-MOBILE-AS21928", "212", "17", "4.1%", "Marlow/7.3.0 (com.marlow.shop; …)"],
        ]),
        "Card numbers tried from AS20473 are sequential within each 16-digit block: 6036 8100 0041 xxxx.",
      ];
    }),
  ],
  suggestions: ["siem alerts", "siem show SEC-6101", "siem search giftcard-lookups", "waf top --by asn", "waf top"],
  lostCheckoutsPerPoint: 120,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 15%. SEC-6101 (high) open on POST /gift-cards/balance. Assigned to SOC on-call (you)." },
    { at: 25, from: "Omar Haddad · Payments", text: "Balance lookups are 40× normal and almost none of them find a card. Somebody is walking the card number space." },
    { at: 70, from: "Rita Gomes · Retail ops", text: "Heads up, our store kiosks run in AWS and call the balance endpoint. We pushed a kiosk update this morning." },
    { at: 120, from: "Sam Tan · Eng manager", text: "Kiosk update this morning, gift-card storm this morning. Can we just block the kiosks' AWS range and see?" },
    { at: 200, from: "Lena Park · SOC lead", text: "Who misses on every lookup? A kiosk scans cards that exist." },
    { at: 280, from: "Elena Ruiz · VP Engineering", text: "Checkout is still shedding. What are we waiting for?" },
  ],
  hints: [
    "Two callers reach the balance endpoint from the cloud. Only one of them is guessing.",
    "Compare how often each network's lookups actually find a card.",
    "Stop the guessing network as a whole: its addresses are spread across one rented range.",
  ],
  solution: [
    { command: "siem show SEC-6101", why: "Balance lookups with a not-found ratio far above baseline, on checkout-api's pods." },
    { command: "siem search giftcard-lookups", why: "600 Vultr addresses miss 99.6% of the time on sequential card numbers; the kiosks in AWS find their cards." },
    { command: "waf top --by asn", why: "AS20473 sends most of the traffic from 45.77.0.0/16; no customer lives there." },
    { command: "waf block 45.77.0.0/16", why: "Blocks the whole enumeration range; the preview shows 0% of checkout customers." },
    {
      command: 'siem resolve SEC-6101 --disposition true-positive --contained-by r-0003 --note "gift-card enumeration from Vultr 45.77.0.0/16, blocked"',
      why: "It is a real attack, contained by the range block (r-0003, the rule you just made).",
    },
    { command: "waf rules", why: "The block is matching the enumeration and no checkout; the 5xx drain within seconds." },
  ],
  postmortem: {
    question: "Which caller was taking checkout down?",
    options: [
      "The store kiosks after this morning's kiosk update in AWS",
      "Vultr addresses guessing sequential gift-card numbers",
      "Customers checking balances after the sale email went out",
      "The payment gateway slowing gift-card redemptions at checkout",
    ],
    answerIndex: 1,
    explanation: {
      cause: "600 Vultr addresses enumerated gift-card numbers on an endpoint checkout-api serves.",
      why: "The guesses missed 99.6% of the time and walked card numbers in order, while the kiosks' lookups found real cards. The enumeration filled the checkout pods past capacity; blocking its one /16 freed them and touched no customer.",
      tell: "siem search giftcard-lookups: AS20473 at 99.6% not-found on sequential numbers, the AWS kiosks at 1.8%.",
    },
  },
};

// ── 2. SMS pumping on phone verification; the growth team's campaign takes the blame ───────────

const smsPumping: Row = {
  id: "sec-t2-sms-pumping",
  title: "The SMS bill is on fire",
  severity: "SEV2",
  opensAtSecondOfDay: 16 * 3600 + 30 * 60,
  briefing:
    "Phone-verification texts are going out at thirty times normal, mostly to premium-rate numbers abroad, and checkout-api is shedding requests. POST /account/phone/verify runs on the checkout pods. Growth also launched an SMS campaign this afternoon.",
  roleBriefing:
    "SOC on-call: siem and waf. Verification texts are exploding and checkout is failing. Growth's SMS campaign went out an hour ago. Decide whether this is the campaign or an attack, stop whatever is filling the pods, and close SEC-6214 with the disposition the evidence supports.",
  attack: {
    label: "SMS pumping",
    path: "/account/phone/verify",
    requestsPerSecond: 150,
    growthPerSecond: 0.15,
    sources: { kind: "ranges", ranges: [{ cidr: "161.97.0.0/16", asn: 51167, network: "CONTABO", ips: 240 }] },
    ja4: PYTHON_JA4,
    userAgent: "python-httpx/0.27.2",
  },
  alert: {
    id: "SEC-6214",
    title: "Verification SMS volume to high-cost destinations far above baseline",
    rule: "identity.sms.verify_destination_anomaly",
    severity: "high",
    openedAt: -200,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("sms-destinations", "Verification texts by destination country and source network", (state) => {
      const { past } = edge(state);
      return [
        "POST /account/phone/verify · last 15 min",
        ...table([
          ["DESTINATION", "TEXTS/MIN", "COST/TEXT", "DELIVERY RECEIPTS", "TOP ClientASN"],
          ["+44 (UK, premium ranges)", count(past * 0.46), "$0.31", "0.2%", "51167 CONTABO"],
          ["+371 (Latvia)", count(past * 0.31), "$0.27", "0.4%", "51167 CONTABO"],
          ["+1 (US/CA)", "48", "$0.008", "96.1%", "21928 T-MOBILE-AS21928"],
        ]),
        "",
        "Growth campaign 'autumn-sms-2' (outbound only, sent from the marketing platform, never via /account/phone/verify): 41,200 texts to +1 opt-ins, finished 15:52.",
      ];
    }),
  ],
  suggestions: ["siem alerts", "siem show SEC-6214", "siem search sms-destinations", "waf top --by asn"],
  lostCheckoutsPerPoint: 105,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 13%. SEC-6214 (high): verification SMS to high-cost destinations. Assigned to SOC on-call (you)." },
    { at: 30, from: "Lena Ortiz · Growth", text: "Our autumn SMS campaign went out at 15:30. Sorry if that's the spike, it should be over by now." },
    { at: 75, from: "Sam Tan · Eng manager", text: "Sounds like the campaign. Close the alert as benign and let's watch checkout." },
    { at: 130, from: "Omar Haddad · Payments", text: "Twilio spend alert just fired: $2,100 in the last hour, mostly to UK and Latvian numbers." },
    { at: 210, from: "Lena Park · SOC lead", text: "Check which endpoint the texts come from. A campaign doesn't send verification codes." },
    { at: 290, from: "Elena Ruiz · VP Engineering", text: "We're paying for every one of those texts. Stop it." },
  ],
  hints: [
    "A marketing send and a verification code leave through different doors. Which door is busy?",
    "Look at where the texts are going, and whether anyone receives them.",
    "Whoever is requesting the codes rents servers in one place.",
  ],
  solution: [
    { command: "siem show SEC-6214", why: "Verification texts to premium destinations far above baseline." },
    { command: "siem search sms-destinations", why: "Premium UK and Latvian numbers with no delivery receipts, all requested from Contabo; the campaign never touches this endpoint." },
    { command: "waf top --by asn", why: "AS51167 CONTABO, 161.97.0.0/16, sends almost all of it." },
    { command: "waf block 161.97.0.0/16", why: "Stops the pumping at its source; 0% of checkout customers behind it." },
    {
      command: 'siem resolve SEC-6214 --disposition true-positive --contained-by r-0003 --note "SMS pumping to premium numbers from Contabo, blocked"',
      why: "A real toll-fraud attack, not the campaign.",
    },
    { command: "waf rules", why: "The block matches the pumping; the pods drain and the 5xx stop." },
  ],
  postmortem: {
    question: "What was sending the verification texts?",
    options: [
      "Growth's autumn SMS campaign retrying failed sends",
      "Customers re-requesting codes during the campaign",
      "SMS pumping to premium numbers, requested from Contabo",
      "Twilio redelivering a backlog of queued verification codes",
    ],
    answerIndex: 2,
    explanation: {
      cause: "Toll fraud: Contabo servers requested verification codes to premium numbers.",
      why: "The campaign went out from the marketing platform and never called /account/phone/verify. The pumping did, at ~150 requests a second, filling checkout-api's pods and earning the attacker a cut of each premium text. Blocking its range stopped both the cost and the 5xx.",
      tell: "siem search sms-destinations: premium +44 and +371 numbers with almost no delivery receipts, all from AS51167.",
    },
  },
};

// ── 3. Promo-code brute force posing as the Android app; the carrier gets blamed ──────────────

const promoBrute: Row = {
  id: "sec-t2-promo-code-brute-force",
  title: "Ten thousand wrong promo codes",
  severity: "SEV2",
  opensAtSecondOfDay: 9 * 3600 + 45 * 60,
  briefing:
    "POST /cart/promo is taking a flood of invalid codes and checkout-api is shedding requests. Support says Android users are hitting errors, and the flood's User-Agent mentions okhttp, the Android app's HTTP library.",
  roleBriefing:
    "SOC on-call: siem and waf. Someone or something is trying promo codes by the thousand. It looks like Android traffic at first glance. Find out whether it is, stop it without blocking real app users, and close SEC-6330.",
  attack: {
    label: "promo-code brute force",
    path: "/cart/promo",
    requestsPerSecond: 170,
    growthPerSecond: 0.14,
    sources: { kind: "ranges", ranges: [{ cidr: "89.238.128.0/18", asn: 9009, network: "M247", ips: 350 }] },
    ja4: PYTHON_JA4,
    userAgent: "okhttp/4.12.0",
  },
  alert: {
    id: "SEC-6330",
    title: "Promo code validation failures far above baseline",
    rule: "commerce.promo.invalid_code_burst",
    severity: "medium",
    openedAt: -110,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("promo-attempts", "Promo-code attempts by client and network", (state) => {
      const { past } = edge(state);
      return [
        "POST /cart/promo by ClientRequestUserAgent · last 15 min",
        ...table([
          ["ClientRequestUserAgent", "ClientASN", "ATTEMPTS/MIN", "VALID", "CARTS WITH ITEMS"],
          ["okhttp/4.12.0", "9009 M247", count(past), "0.01%", "0%"],
          ["Marlow/7.2.4 (Android 15; Pixel 8) okhttp/4.12.0", "21928, 22394, 20057", "9", "71%", "100%"],
          ["Marlow/7.3.0 (com.marlow.shop; …) Alamofire/5.10.2", "21928, 22394, 7922", "22", "69%", "100%"],
        ]),
        "The bare okhttp/4.12.0 requests carry no Marlow app token and try codes in dictionary order: AUTUMN10, AUTUMN11, AUTUMN12…",
      ];
    }),
  ],
  suggestions: ["siem show SEC-6330", "siem search promo-attempts", "waf top --by asn", "waf top"],
  lostCheckoutsPerPoint: 110,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 17%. SEC-6330 (medium): promo validation failures. Assigned to SOC on-call (you)." },
    { at: 30, from: "Maya Okonkwo · Support", text: "Android customers say applying a promo code spins and fails." },
    { at: 80, from: "Sam Tan · Eng manager", text: "The bad traffic says okhttp, that's Android. Most of our Android users are on T-Mobile, can we block their range for a bit?" },
    { at: 150, from: "Jonah Reyes · Mobile lead", text: "Our app never sends a bare okhttp User-Agent. Every request starts with Marlow/ and carries the app token." },
    { at: 230, from: "Lena Park · SOC lead", text: "A library name in a User-Agent is cheap. Where do the requests come from?" },
  ],
  hints: [
    "A User-Agent naming an HTTP library tells you what was used, not who used it.",
    "Real app traffic says who it is in full. Compare the two kinds of okhttp requests.",
    "Phone carriers carry customers. Rented servers don't.",
  ],
  solution: [
    { command: "siem search promo-attempts", why: "Bare okhttp/4.12.0 from M247 tries dictionary codes with empty carts; the real Android app identifies itself and finds valid codes." },
    { command: "waf top --by asn", why: "AS9009 M247, 89.238.128.0/18, a VPN and hosting network, sends most of the requests; the carriers send customers." },
    { command: "waf block 89.238.128.0/18", why: "Blocks the brute force range; no checkout customer behind it." },
    {
      command: 'siem resolve SEC-6330 --disposition true-positive --contained-by r-0003 --note "promo brute force from M247 spoofing okhttp, blocked"',
      why: "A real brute-force attempt, contained by the range block.",
    },
    { command: "waf rules", why: "The block matches the brute force and 0% of checkout; the 5xx clear." },
  ],
  postmortem: {
    question: "Who was brute-forcing promo codes?",
    options: [
      "Android 7.2.4 retrying promo requests on T-Mobile's network",
      "A script on M247 servers with a bare okhttp User-Agent",
      "iOS 7.3.0 users sharing a leaked AUTUMN10 promo code",
      "The growth team's promo service validating codes in bulk",
    ],
    answerIndex: 1,
    explanation: {
      cause: "A script on M247 servers tried dictionary promo codes behind a bare okhttp User-Agent.",
      why: "The real app always sends a Marlow/ User-Agent and app token; the flood sent neither, from hosting addresses, with empty carts. Blocking T-Mobile would have locked out customers and left the script running. Blocking M247's range stopped it cleanly.",
      tell: "siem search promo-attempts: bare okhttp/4.12.0 from AS9009, 0.01% valid, no items in the cart.",
    },
  },
};

// ── 4. A sign-up farm across two AWS ranges; the alert names only one of them ──────────────────

const signupFarm: Row = {
  id: "sec-t2-signup-farm",
  title: "Five hundred new accounts a second",
  severity: "SEV2",
  opensAtSecondOfDay: 13 * 3600 + 10 * 60,
  briefing:
    "Account sign-ups are running at a hundred times normal, every new account claims the first-order discount, and checkout-api is shedding requests. POST /account is served by the checkout pods.",
  roleBriefing:
    "SOC on-call: siem and waf. A sign-up farm is creating accounts for the welcome discount. SEC-6408 points at one AWS range, but check how many there are before you call it contained. Close the alert once the farm is stopped.",
  attack: {
    label: "sign-up farm",
    path: "/account",
    requestsPerSecond: 200,
    growthPerSecond: 0.15,
    sources: {
      kind: "ranges",
      ranges: [
        { cidr: "3.208.0.0/12", asn: 16509, network: "AMAZON-02", ips: 380 },
        { cidr: "44.192.0.0/11", asn: 16509, network: "AMAZON-02", ips: 180 },
      ],
    },
    ja4: PYTHON_JA4,
    userAgent: HEADLESS_CHROME,
  },
  alert: {
    id: "SEC-6408",
    title: "Account creation burst from 44.192.0.0/11",
    rule: "identity.signup.velocity_by_prefix",
    severity: "high",
    openedAt: -95,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("signup-sources", "New accounts by source prefix", (state) => {
      const { past } = edge(state);
      return [
        "POST /account · last 15 min, by source prefix",
        ...table([
          ["PREFIX", "ClientASN", "ClientIP (distinct)", "SIGN-UPS/MIN", "EMAIL DOMAIN (top)", "CLAIMED WELCOME10"],
          ["3.208.0.0/12", "16509 AMAZON-02", "380", count((past * 380) / 560), "mailinator-style throwaways", "100%"],
          ["44.192.0.0/11", "16509 AMAZON-02", "180", count((past * 180) / 560), "mailinator-style throwaways", "100%"],
          ["(customer networks)", "21928, 22394, 7922 …", "1,904", "31", "gmail.com, icloud.com", "62%"],
        ]),
        `${HEADLESS_CHROME} on every farm sign-up. The alert rule keys on one prefix at a time and only fired for the second.`,
      ];
    }),
  ],
  suggestions: ["siem show SEC-6408", "siem search signup-sources", "waf top --by asn", "waf rules"],
  lostCheckoutsPerPoint: 170,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 22%. SEC-6408 (high): account creation burst from 44.192.0.0/11. Assigned to SOC on-call (you)." },
    { at: 30, from: "Kai Brooks · Growth", text: "WELCOME10 redemptions are through the roof. Every new account claims it within seconds." },
    { at: 90, from: "Sam Tan · Eng manager", text: "The alert gives us the range. Block it and we're done, right?" },
    { at: 160, from: "Lena Park · SOC lead", text: "The rule fires per prefix. If the farm sits in more than one, the alert only told you about the one that tripped it." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout is still failing for customers. Where are we?" },
  ],
  hints: [
    "The alert tells you where it noticed the farm, not everywhere the farm lives.",
    "Group the sign-ups by network and look at every prefix that network uses.",
    "Contained means the 5xx are gone, not that one rule exists.",
  ],
  solution: [
    { command: "siem show SEC-6408", why: "A burst of sign-ups from 44.192.0.0/11, on checkout-api's pods." },
    { command: "siem search signup-sources", why: "Two AWS prefixes run the same headless farm; 3.208.0.0/12 is the bigger one and the alert never named it." },
    { command: "waf top --by asn", why: "AS16509 lists both prefixes; together they carry nearly all the traffic." },
    { command: "waf block 3.208.0.0/12", why: "Blocks the larger half of the farm; no customers there." },
    { command: "waf block 44.192.0.0/11", why: "Blocks the rest; between the two rules the farm is fully stopped." },
    {
      command: 'siem resolve SEC-6408 --disposition true-positive --contained-by r-0004 --note "sign-up farm across two AWS prefixes, both blocked"',
      why: "A real abuse campaign, contained by the two range blocks.",
    },
    { command: "waf rules", why: "Both rules match the farm and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Why did blocking the range in the alert not stop the farm?",
    options: [
      "The farm moved to residential proxies once it was blocked",
      "The farm also ran from a second, larger AWS prefix",
      "The WAF took several minutes to push the new rule to the edge",
      "Customers retried sign-ups that the block had turned away",
    ],
    answerIndex: 1,
    explanation: {
      cause: "The sign-up farm ran from two AWS prefixes; the alert named only one.",
      why: "The detection rule counts sign-ups per prefix and fired for 44.192.0.0/11 first. Two thirds of the farm sat in 3.208.0.0/12, so blocking the named range alone left the pods overloaded. Blocking both prefixes stopped every farm sign-up and no customer.",
      tell: "siem search signup-sources and waf top --by asn: AS16509 with two prefixes running the same headless client.",
    },
  },
};

// ── 5. A scraper spoofing Googlebot from Linode; blocking Google does nothing ───────────────────

const fakeGooglebot: Row = {
  id: "sec-t2-fake-googlebot",
  title: "Googlebot isn't Google",
  severity: "SEV2",
  opensAtSecondOfDay: 3 * 3600 + 25 * 60,
  briefing:
    "Stock-availability lookups are flooding checkout-api in the middle of the night and the pods are shedding requests. Every flooding request says it is Googlebot. GET /inventory/availability is served by the checkout pods.",
  roleBriefing:
    "SOC on-call: siem and waf. Something calling itself Googlebot is hammering stock availability. SEO will be furious if real Googlebot is blocked. Find out who it really is, stop it, and close SEC-6522.",
  attack: {
    label: "stock scraper",
    path: "/inventory/availability",
    requestsPerSecond: 150,
    growthPerSecond: 0.1,
    sources: { kind: "ranges", ranges: [{ cidr: "172.104.0.0/15", asn: 63949, network: "AKAMAI-LINODE-AP", ips: 30 }] },
    ja4: GO_JA4,
    userAgent: GOOGLEBOT,
  },
  alert: {
    id: "SEC-6522",
    title: "Crawler request rate far above baseline on /inventory/availability",
    rule: "edge.crawler.rate_anomaly",
    severity: "medium",
    openedAt: -80,
  },
  stoppedShare: 0.85,
  evidence: [
    siem("crawler-verify", "Requests claiming to be Googlebot, with reverse DNS", (state) => {
      const { past } = edge(state);
      return [
        "User-Agent contains Googlebot · last 15 min · forward-confirmed reverse DNS",
        ...table([
          ["ClientASN", "ClientIP (distinct)", "REQ/MIN", "REQ/MIN PER IP", "REVERSE DNS (sample)", "FCrDNS"],
          ["63949 AKAMAI-LINODE-AP", "30", count(past), count(past / 30), "li1688-21.members.linode.com", "fail"],
          ["15169 GOOGLE", "14", "38", "3", "crawl-66-249-66-1.googlebot.com", "pass"],
        ]),
        "Google publishes Googlebot's ranges; none of the Linode addresses are in them.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-6522", "siem search crawler-verify", "waf top", "waf top --by asn"],
  lostCheckoutsPerPoint: 85,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 13%. SEC-6522 (medium): crawler rate anomaly. Assigned to SOC on-call (you)." },
    { at: 40, from: "Sam Tan · Eng manager", text: "It's Googlebot. Block Google's crawler range for an hour, SEO can live with it." },
    { at: 100, from: "Nadia Petrov · SEO", text: "Please don't block Googlebot. Real Googlebot crawls us a few times a minute, never like this." },
    { at: 170, from: "Lena Park · SOC lead", text: "Anyone can type Googlebot in a header. Reverse DNS is harder to fake." },
    { at: 260, from: "Maya Okonkwo · Support", text: "Night-shift customers in Asia say checkout errors on the first try." },
  ],
  hints: [
    "A crawler's name is a claim. Some crawlers can be verified.",
    "Real Googlebot resolves back to Google. Check where these requests really come from.",
    "Thirty addresses each sending hundreds a minute is a shape a per-address cap handles well.",
  ],
  solution: [
    { command: "siem search crawler-verify", why: "The flood comes from 30 Linode addresses that fail forward-confirmed reverse DNS; real Googlebot sends 38 a minute." },
    { command: "waf top", why: "Thirty Linode addresses at ~300 requests a minute each, far above the busiest customer at about 13." },
    { command: "waf ratelimit 30/1m", why: "Caps every address at 30 a minute: stops ~90% of the scraper, leaves customers and real Googlebot alone." },
    {
      command: 'siem resolve SEC-6522 --disposition true-positive --contained-by r-0003 --note "scraper spoofing Googlebot from Linode, rate limited"',
      why: "A real scraper, contained by the rate limit.",
    },
    { command: "waf rules", why: "The limit matches the scraper and none of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Who was flooding stock availability?",
    options: [
      "Googlebot recrawling after a sitemap change overnight",
      "A scraper on Linode with a forged Googlebot User-Agent",
      "Customers in Asia refreshing product pages during the night",
      "Our own CDN revalidating cached stock pages every second",
    ],
    answerIndex: 1,
    explanation: {
      cause: "A stock scraper on 30 Linode servers forged Googlebot's User-Agent.",
      why: "Forward-confirmed reverse DNS failed for every Linode address and none sat in Google's published ranges; real Googlebot crawled at its usual few requests a minute. Blocking Google would have stopped nothing. A 30-a-minute cap per address cut the scraper by ~90% and no customer came near it.",
      tell: "siem search crawler-verify: 30 Linode addresses claiming Googlebot, FCrDNS fail, ~300 requests a minute each.",
    },
  },
};

// ── 6. Address autocomplete resold as an API; the iOS release looks guilty ─────────────────────

const addressProxy: Row = {
  id: "sec-t2-address-api-resale",
  title: "Our autocomplete has new customers",
  severity: "SEV3",
  opensAtSecondOfDay: 10 * 3600 + 20 * 60,
  briefing:
    "POST /address/suggest, checkout's address autocomplete, is taking ten times its normal traffic and checkout-api is shedding requests. iOS 7.3.0 shipped a new address field this week. The paid geocoding bill has doubled.",
  roleBriefing:
    "SOC on-call: siem and waf. Address autocomplete traffic has exploded. The iOS team shipped autocomplete changes this week. Work out who is calling it, cut them down to size without breaking autocomplete for customers, and close SEC-6611.",
  attack: {
    label: "autocomplete resale",
    path: "/address/suggest",
    requestsPerSecond: 140,
    growthPerSecond: 0.1,
    sources: { kind: "ranges", ranges: [{ cidr: "51.38.0.0/16", asn: 16276, network: "OVH", ips: 12 }] },
    ja4: GO_JA4,
    userAgent: "axios/1.7.7",
  },
  alert: {
    id: "SEC-6611",
    title: "Geocoding spend on /address/suggest far above forecast",
    rule: "finops.geocoding.spend_anomaly",
    severity: "medium",
    openedAt: -300,
  },
  stoppedShare: 0.85,
  evidence: [
    siem("autocomplete-callers", "Address autocomplete by client", (state) => {
      const { past } = edge(state);
      return [
        "POST /address/suggest by client · last 15 min",
        ...table([
          ["CLIENT", "ClientIP (distinct)", "REQ/MIN", "REQ/MIN PER IP (p99)", "FOLLOWED BY A CHECKOUT"],
          ["axios/1.7.7 (AS16276 OVH)", "12", count(past), count(past / 12), "0%"],
          ["Marlow/7.3.0 (com.marlow.shop; …) Alamofire/5.10.2", "1,130", "212", "9", "64%"],
          ["Chrome / Safari / Firefox (web)", "1,610", "260", "8", "58%"],
        ]),
        "The axios callers send full street addresses from 14 countries we don't ship to; nobody follows up with a cart.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-6611", "siem search autocomplete-callers", "waf top", "waf ratelimit 600/1m"],
  lostCheckoutsPerPoint: 75,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV3 triggered — checkout-api 5xx at 11%. SEC-6611 (medium): geocoding spend anomaly. Assigned to SOC on-call (you)." },
    { at: 35, from: "Lucas Moreau · iOS lead", text: "7.3.0 does call suggest on every keystroke now. Could be us?" },
    { at: 90, from: "Sam Tan · Eng manager", text: "Put a limit on it big enough for fast typists, like 600 a minute, and move on." },
    { at: 160, from: "Lena Park · SOC lead", text: "A customer types one address. Look at what the busiest callers send per address before you size anything." },
    { at: 250, from: "Omar Haddad · Payments", text: "Geocoding invoice is tracking at $9k for the day. Normal is $400." },
  ],
  hints: [
    "Compare what one customer device sends with what the busiest callers send.",
    "Keystroke-by-keystroke typing is a few requests a second at most, and only for a few seconds.",
    "A cap sized for a person is far below a reseller and far above a shopper.",
  ],
  solution: [
    { command: "siem search autocomplete-callers", why: "Twelve OVH addresses running axios send ~700 a minute each and never check out; the iOS app peaks at 9 a minute per device." },
    { command: "waf top", why: "The twelve OVH addresses top the list by a wide margin." },
    { command: "waf ratelimit 60/1m", why: "60 a minute per address is more than any typist and cuts the reseller by ~90%." },
    {
      command: 'siem resolve SEC-6611 --disposition true-positive --contained-by r-0003 --note "autocomplete resold via OVH, rate limited"',
      why: "Real abuse of a paid API through our endpoint.",
    },
    { command: "waf rules", why: "The limit matches the reseller and none of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Why would a 600-a-minute limit have stopped almost nothing?",
    options: [
      "It applied only to POST /checkout, not to /address/suggest",
      "Each OVH address sent about 700 a minute, barely over 600",
      "The iOS app would have hit it first and retried harder",
      "The geocoding provider throttles us before the WAF does",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Twelve OVH servers resold our address autocomplete, ~700 requests a minute each.",
      why: "The iOS release peaks at 9 requests a minute per device, so it wasn't the cause. A limit sized for imaginary fast typists sat just under the reseller's rate and stopped almost nothing; 60 a minute stopped ~90% and no customer came near it.",
      tell: "siem search autocomplete-callers: 12 axios addresses on AS16276 at ~700 a minute each, 0% followed by a checkout.",
    },
  },
};

// ── 7. One-time-code brute force while the SMS provider is degraded ────────────────────────────

const otpBrute: Row = {
  id: "sec-t2-otp-brute-force",
  title: "Guessing six digits at a time",
  severity: "SEV2",
  opensAtSecondOfDay: 19 * 3600 + 15 * 60,
  briefing:
    "Failed one-time-code checks on POST /session/otp are at fifty times normal and checkout-api is shedding requests. The SMS provider has posted a delivery delay on its status page, so customers are retrying codes too.",
  roleBriefing:
    "SOC on-call: siem and waf. One-time-code failures are spiking while the SMS provider is degraded. Decide whether it's customers retrying slow codes or someone guessing them, stop what is filling the pods, and close SEC-6704 correctly.",
  attack: {
    label: "OTP brute force",
    path: "/session/otp",
    requestsPerSecond: 140,
    growthPerSecond: 0.12,
    sources: { kind: "ranges", ranges: [{ cidr: "64.227.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 20 }] },
    ja4: PYTHON_JA4,
    userAgent: "python-requests/2.31.0",
  },
  alert: {
    id: "SEC-6704",
    title: "One-time-code verification failures far above baseline",
    rule: "identity.mfa.otp_failure_burst",
    severity: "high",
    openedAt: -70,
  },
  stoppedShare: 0.85,
  externals: [
    {
      id: "sms-provider",
      status: "degraded",
      facts: [
        { key: "status page", value: "Delayed SMS delivery to some US carriers" },
        { key: "median delivery", value: "48 s (normally 4 s)" },
      ],
    },
  ],
  evidence: [
    siem("otp-failures", "One-time-code checks by source address", (state) => {
      const { past } = edge(state);
      return [
        "POST /session/otp · last 15 min",
        ...table([
          ["SOURCE", "ClientIP (distinct)", "CHECKS/MIN", "CHECKS PER SESSION (p99)", "SUCCESS"],
          ["AS14061 DIGITALOCEAN-ASN 64.227.0.0/16", "20", count(past), "1,000+", "0.0%"],
          ["customer networks (mobile, residential)", "2,310", "96", "3", "91%"],
        ]),
        "DigitalOcean sessions walk codes 000000, 000001, 000002… against 6 accounts each; customers re-enter the same code twice, then a new one.",
      ];
    }),
  ],
  suggestions: ["siem alerts", "siem show SEC-6704", "siem search otp-failures", "waf top"],
  lostCheckoutsPerPoint: 75,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 11%. SEC-6704 (high): OTP verification failures. Assigned to SOC on-call (you)." },
    { at: 30, from: "Dev Raman · Identity team", text: "The SMS provider is delayed: codes arrive in 40-50 s. People are definitely retrying." },
    { at: 85, from: "Sam Tan · Eng manager", text: "So it's the provider. Mark the alert a false positive and let Identity deal with the vendor." },
    { at: 150, from: "Lena Park · SOC lead", text: "A slow code makes a customer retry twice, not a thousand times. Look at checks per session." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "If someone is in customers' accounts I want to know now." },
  ],
  hints: [
    "Slow codes make people retry a little. What does a session that guesses look like?",
    "Count checks per session, and where the busiest sessions come from.",
    "A customer checks a code a few times a minute at most.",
  ],
  solution: [
    { command: "siem search otp-failures", why: "Twenty DigitalOcean addresses walk codes in order, 1,000+ checks a session, 0% success; customers average three." },
    { command: "waf top", why: "Twenty hosting addresses at ~400 checks a minute each; the busiest customer address sends about 13." },
    { command: "waf ratelimit 20/1m", why: "Caps each address at 20 a minute: stops ~95% of the guessing and no customer comes near it." },
    {
      command: 'siem resolve SEC-6704 --disposition true-positive --contained-by r-0003 --note "OTP brute force from DigitalOcean, rate limited"',
      why: "A real brute-force attack that happened to coincide with the provider delay.",
    },
    { command: "waf rules", why: "The limit matches the guessing; the 5xx drain." },
  ],
  postmortem: {
    question: "What drove the one-time-code failures?",
    options: [
      "Customers retrying codes while the SMS provider was delayed",
      "Twenty DigitalOcean hosts walking every six-digit code",
      "The SMS provider sending codes that had already expired",
      "A clock skew on checkout-api rejecting valid one-time codes",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Twenty DigitalOcean hosts brute-forced one-time codes against a handful of accounts.",
      why: "The provider delay was real but made customers retry two or three times. The guessing sessions checked over a thousand codes each, in order, at ~400 a minute per address, and filled checkout-api's pods. A 20-a-minute cap stopped ~95% of it.",
      tell: "siem search otp-failures: sequential codes, 1,000+ checks per session, 0% success, all from AS14061.",
    },
  },
};

// ── 8. Cart hoarding bots behind residential proxies; two odd fingerprints, one guilty ─────────

const cartHoarding: Row = {
  id: "sec-t2-cart-hoarding",
  title: "Bots are holding the stock",
  severity: "SEV1",
  opensAtSecondOfDay: 12 * 3600,
  briefing:
    "The limited-edition drop went live at noon. POST /cart/items is taking six times the expected adds and checkout-api is shedding requests. The adds come from tens of thousands of home addresses, each adding a few items a minute.",
  roleBriefing:
    "SOC on-call: siem and waf. Inventory bots are hoarding the drop through residential proxies. Two non-browser TLS fingerprints show up on the endpoint today. Find the one doing the hoarding, stop it without blocking shoppers, and close SEC-6803.",
  attack: {
    label: "cart hoarding",
    path: "/cart/items",
    requestsPerSecond: 190,
    growthPerSecond: 0.12,
    sources: { kind: "residential-proxies", ips: 25_000 },
    ja4: GO_JA4,
    userAgent: CHROME_128_WINDOWS,
  },
  alert: {
    id: "SEC-6803",
    title: "Add-to-cart rate during drop far above forecast",
    rule: "commerce.cart.drop_velocity",
    severity: "critical",
    openedAt: -45,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("cart-fingerprints", "Add-to-cart requests by TLS fingerprint (JA4)", (state) => {
      const { past } = edge(state);
      return [
        "POST /cart/items by JA4 · last 15 min (fingerprint names: FoxIO JA4 database)",
        ...table([
          ["JA4", "KNOWN AS", "TOP USER-AGENT", "ADDS/MIN PAST WAF", "ClientIP (distinct)", "CARTS CHECKED OUT"],
          [GO_JA4, "GoLang", "Chrome/128.0.0.0 (Windows)", count(past), "25,000", "0.0%"],
          [PYTHON_JA4, "Python", "python-requests/2.31.0 (StockSync partner feed)", "6", "3", "—"],
          ...BROWSER_JA4.map((entry) => [entry.ja4, entry.client, entry.client, count(820 * entry.customerShare), count(3140 * entry.customerShare), "41%"]),
        ]),
        "The Python client is StockSync, the wholesale partner's catalogue feed: 3 addresses, 6 requests a minute, says what it is.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-6803", "siem search cart-fingerprints", "waf top", "waf top --by asn", `waf block --ja4 ${PYTHON_JA4}`],
  lostCheckoutsPerPoint: 160,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV1 triggered — checkout-api 5xx at 20%. SEC-6803 (critical): add-to-cart rate during drop. Assigned to SOC on-call (you)." },
    { at: 25, from: "Priya Shah · Checkout web", text: "The drop sold out in carts in 40 seconds, but almost nothing is checking out." },
    { at: 70, from: "Sam Tan · Eng manager", text: "There's a python-requests client on the cart endpoint. Bots are Python. Block that fingerprint." },
    { at: 130, from: "Lena Park · SOC lead", text: "The one that lies about being Chrome is more interesting than the one that tells you its name." },
    { at: 220, from: "Maya Okonkwo · Support", text: "Customers are furious: the drop shows sold out but nobody they know got one." },
  ],
  hints: [
    "Per address the bots are slower than shoppers. Look for what they share instead.",
    "One unusual client announces itself honestly. The other claims to be a browser.",
    "A browser's TLS handshake matches its User-Agent. Find the one that doesn't.",
  ],
  solution: [
    { command: "siem show SEC-6803", why: "Add-to-cart far above forecast during the drop, on checkout-api." },
    { command: "siem search cart-fingerprints", why: "A Go TLS client claiming Chrome 128 makes nearly all the adds from 25,000 addresses and never checks out; the Python client is the partner feed at 6 a minute." },
    { command: "waf top", why: "No address stands out: every proxy sends less than the busiest shoppers, so IP rules won't work." },
    { command: `waf block --ja4 ${GO_JA4}`, why: "Blocks the hoarding client's fingerprint; no customer browser presents it." },
    {
      command: 'siem resolve SEC-6803 --disposition true-positive --contained-by r-0003 --note "cart hoarding via residential proxies, blocked by JA4"',
      why: "A real bot attack, contained by the fingerprint block.",
    },
    { command: "waf rules", why: "The JA4 rule matches the hoarding and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "What singled out the hoarding bots?",
    options: [
      "A python-requests client adding items from three addresses",
      "A Go TLS fingerprint claiming to be Chrome 128 on Windows",
      "Thousands of carts from one residential ISP's address range",
      "Each proxy address adding far more items than any shopper did",
    ],
    answerIndex: 1,
    explanation: {
      cause: "Hoarding bots shared one Go TLS fingerprint behind 25,000 residential proxies.",
      why: "The proxies were slower per address than shoppers, so IP rules had nothing to grab. The bots claimed Chrome 128 but opened TLS like Go, and never checked out. The Python client was the partner feed at 6 a minute; blocking it would have stopped nothing.",
      tell: "siem search cart-fingerprints: one GoLang JA4 with a Chrome/128 User-Agent, 25,000 addresses, 0% checked out.",
    },
  },
};

// ── 9. Loyalty points cashed out from six hosting networks; blocking the biggest isn't enough ──

const LOYALTY_RANGES = [
  { cidr: "138.68.0.0/16", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 250 },
  { cidr: "149.28.0.0/16", asn: 20473, network: "AS-CHOOPA", ips: 180 },
  { cidr: "139.162.0.0/16", asn: 63949, network: "AKAMAI-LINODE-AP", ips: 150 },
  { cidr: "54.36.0.0/16", asn: 16276, network: "OVH", ips: 120 },
  { cidr: "95.216.0.0/16", asn: 24940, network: "HETZNER-AS", ips: 100 },
  { cidr: "62.171.128.0/17", asn: 51167, network: "CONTABO", ips: 80 },
] as const;
const LOYALTY_IPS = LOYALTY_RANGES.reduce((sum, range) => sum + range.ips, 0);

const loyaltyDrain: Row = {
  id: "sec-t2-loyalty-points-drain",
  title: "Points vanishing from six clouds",
  severity: "SEV2",
  opensAtSecondOfDay: 20 * 3600 + 50 * 60,
  briefing:
    "Loyalty redemptions on POST /loyalty/redeem are at twenty-five times normal, points are being cashed into gift cards on accounts whose owners are asleep, and checkout-api is shedding requests. The traffic comes from six different hosting networks.",
  roleBriefing:
    "SOC on-call: siem and waf. Someone with a list of taken-over accounts is draining loyalty points from many hosting networks at once. Find what all of them have in common, stop it without touching shoppers, and close SEC-6912.",
  attack: {
    label: "loyalty cash-out",
    path: "/loyalty/redeem",
    requestsPerSecond: 160,
    growthPerSecond: 0.13,
    sources: { kind: "ranges", ranges: LOYALTY_RANGES },
    ja4: PYTHON_JA4,
    userAgent: CHROME_120_WINDOWS,
  },
  alert: {
    id: "SEC-6912",
    title: "Loyalty redemptions to new gift cards far above baseline",
    rule: "loyalty.redeem.cashout_velocity",
    severity: "high",
    openedAt: -130,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("redeem-sources", "Redemptions by network and TLS fingerprint", (state) => {
      const { past } = edge(state);
      return [
        "POST /loyalty/redeem by ClientASN · last 15 min",
        ...table([
          ["ClientASN", "NETWORK", "PREFIX", "ClientIP (distinct)", "REDEEMS/MIN", "JA4"],
          ...LOYALTY_RANGES.map((range) => [String(range.asn), range.network, range.cidr, String(range.ips), count((past * range.ips) / LOYALTY_IPS), PYTHON_JA4]),
          ["(customer networks)", "T-Mobile, Verizon, AT&T, Comcast", "—", "88", "4", "browsers, Marlow apps"],
        ]),
        `Every hosting request: User-Agent Chrome/120.0.0.0 (Windows), JA4 ${PYTHON_JA4} (FoxIO: Python). No two networks carry more than 28% of it.`,
      ];
    }),
  ],
  suggestions: ["siem show SEC-6912", "siem search redeem-sources", "waf top --by asn", "waf block 138.68.0.0/16"],
  lostCheckoutsPerPoint: 120,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 15%. SEC-6912 (high): loyalty cash-out velocity. Assigned to SOC on-call (you)." },
    { at: 35, from: "Kai Brooks · Loyalty", text: "Points are being turned into e-gift cards and emailed to addresses that aren't the account owners'." },
    { at: 90, from: "Sam Tan · Eng manager", text: "DigitalOcean is the biggest. Block it and see." },
    { at: 160, from: "Lena Park · SOC lead", text: "Six networks means six blocks, and a seventh tomorrow. Find what doesn't change when they move." },
    { at: 250, from: "Elena Ruiz · VP Engineering", text: "Members are losing points while we watch. Contain it." },
  ],
  hints: [
    "Blocking one network stops one network's share. How many are there?",
    "The addresses change from cloud to cloud. Look for what every request has in common.",
    "The User-Agent says Chrome. Does the handshake agree?",
  ],
  solution: [
    { command: "siem show SEC-6912", why: "Loyalty points cashed into new gift cards far above baseline." },
    { command: "waf top --by asn", why: "Six hosting networks, none with more than 28% of the traffic; range blocks would take six rules and still leave the next cloud." },
    { command: "siem search redeem-sources", why: `Every hosting request presents JA4 ${PYTHON_JA4} (Python) while claiming Chrome 120.` },
    { command: `waf block --ja4 ${PYTHON_JA4}`, why: "One rule stops the cash-out from every network; no customer browser presents that fingerprint." },
    {
      command: 'siem resolve SEC-6912 --disposition true-positive --contained-by r-0003 --note "loyalty cash-out from six clouds, blocked by JA4"',
      why: "A real account-takeover cash-out, contained by the fingerprint block.",
    },
    { command: "waf rules", why: "The JA4 rule matches the cash-out and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Why didn't blocking DigitalOcean contain the cash-out?",
    options: [
      "DigitalOcean carried only 28%; five other clouds kept going",
      "The WAF rule only applied to POST /checkout, not to redeem",
      "The attackers switched to residential proxies within seconds",
      "Members redeeming points in a panic replaced the blocked load",
    ],
    answerIndex: 0,
    explanation: {
      cause: "One Python client cashed out loyalty points from six hosting networks at once.",
      why: "The traffic was spread over six clouds, none above 28%, so blocking the biggest left most of it running and the pods still overloaded. Every request shared one TLS fingerprint behind a Chrome 120 User-Agent; a single JA4 block stopped all six and no customer.",
      tell: "siem search redeem-sources: six ASNs, one JA4 that FoxIO names Python, every request claiming Chrome 120.",
    },
  },
};

// ── 10. A search scraper pretending to be iPhone Safari; blocking Safari blocks customers ─────

const searchScraper: Row = {
  id: "sec-t2-search-scraper-safari",
  title: "A million iPhones searching",
  severity: "SEV2",
  opensAtSecondOfDay: 8 * 3600 + 35 * 60,
  briefing:
    "POST /search is running at eight times normal and checkout-api is shedding requests. Nearly every extra request says it is Safari on an iPhone, and they come from home and mobile addresses across the country.",
  roleBriefing:
    "SOC on-call: siem and waf. A scraper is pulling the whole catalogue through search via residential proxies, claiming to be iPhone Safari. Real iPhone customers also use Safari. Stop the scraper without blocking them, and close SEC-7015.",
  attack: {
    label: "search scraping",
    path: "/search",
    requestsPerSecond: 170,
    growthPerSecond: 0.11,
    sources: { kind: "residential-proxies", ips: 18_000 },
    ja4: PYTHON_JA4,
    userAgent: IPHONE_SAFARI,
  },
  alert: {
    id: "SEC-7015",
    title: "Search requests per session far above baseline",
    rule: "edge.search.scrape_pattern",
    severity: "medium",
    openedAt: -60,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("search-clients", "Search requests by claimed browser and TLS fingerprint", (state) => {
      const { past } = edge(state);
      return [
        "POST /search where User-Agent contains 'iPhone' · last 15 min, by JA4 (names: FoxIO JA4 database)",
        ...table([
          ["JA4", "KNOWN AS", "SEARCHES/MIN", "ClientIP (distinct)", "QUERIES PER SESSION (p50)", "ADDED TO CART"],
          [SAFARI_JA4, "Safari", "180", "534", "4", "22%"],
          [PYTHON_JA4, "Python", count(past), "18,000", "2,400 (catalogue in SKU order)", "0%"],
        ]),
        "Both groups send the same Version/17.5 Mobile Safari User-Agent. Only one opens TLS like Safari does.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-7015", "siem search search-clients", "waf top", `waf block --ja4 ${SAFARI_JA4}`],
  lostCheckoutsPerPoint: 130,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 17%. SEC-7015 (medium): search scrape pattern. Assigned to SOC on-call (you)." },
    { at: 30, from: "Hana Ito · Search", text: "Somebody is paging through the whole catalogue in SKU order. Two thousand queries a session." },
    { at: 80, from: "Sam Tan · Eng manager", text: "It's all iPhone Safari. Block the Safari fingerprint for an hour, iPhone people can use the app." },
    { at: 150, from: "Lena Park · SOC lead", text: "Seventeen percent of our customers are on Safari. Find the fingerprint that only the scraper has." },
    { at: 240, from: "Maya Okonkwo · Support", text: "Customers say search and checkout both feel broken this morning." },
  ],
  hints: [
    "The scraper copies a real browser's User-Agent. It can't copy everything.",
    "Two groups claim the same browser. Compare how each one opens its connection.",
    "Whatever you block, check how many real customers sit behind it first.",
  ],
  solution: [
    { command: "siem show SEC-7015", why: "Search requests per session far above baseline, on checkout-api's pods." },
    { command: "siem search search-clients", why: `Real Safari presents ${SAFARI_JA4}; the scraper claims Safari but presents a Python handshake from 18,000 proxies.` },
    { command: "waf top", why: "No address stands out: the proxies are quieter than the busiest customers." },
    { command: `waf block --ja4 ${PYTHON_JA4}`, why: "Blocks only the scraper's handshake; the preview shows 0% of checkout customers." },
    {
      command: 'siem resolve SEC-7015 --disposition true-positive --contained-by r-0003 --note "catalogue scraper spoofing iPhone Safari, blocked by JA4"',
      why: "A real scraper, contained by the fingerprint block.",
    },
    { command: "waf rules", why: "The JA4 rule matches the scraper and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Why not block the Safari fingerprint?",
    options: [
      "Real iPhone and Mac customers present it; the scraper did not",
      "The WAF can't match TLS fingerprints on the search endpoint",
      "Safari's fingerprint changes every release, so it wouldn't hold",
      "The scraper rotated User-Agents faster than the WAF could follow",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A catalogue scraper behind residential proxies faked iPhone Safari's User-Agent.",
      why: "Blocking Safari's JA4 would have turned away ~17% of customers and none of the scraper, whose TLS handshake was Python's. The scraper's own fingerprint was shared by all 18,000 proxies and by no browser, so blocking it stopped the scraping cleanly.",
      tell: "siem search search-clients: the same Safari User-Agent under two JA4s; the Python one carries 2,400 queries a session.",
    },
  },
};

// ── 11. Shipping webhooks replayed from one server; "block the top 50" is the tempting shortcut ─

const WEBHOOK_IP = "49.12.87.143";

const webhookReplay: Row = {
  id: "sec-t2-webhook-replay",
  title: "The parcels that never move",
  severity: "SEV2",
  opensAtSecondOfDay: 6 * 3600 + 40 * 60,
  briefing:
    "POST /webhooks/shipping, where the carrier tells us parcels moved, is taking thousands of requests a minute and checkout-api is shedding requests. Most fail signature checks. The carrier says its own webhook volume is normal.",
  roleBriefing:
    "SOC on-call: siem and waf. Something is replaying shipping webhooks at checkout-api. The carrier's own servers send a steady trickle. Separate the replay from the carrier and from customers, stop it precisely, and close SEC-7120.",
  attack: {
    label: "webhook replay",
    path: "/webhooks/shipping",
    requestsPerSecond: 130,
    growthPerSecond: 0.2,
    sources: { kind: "ranges", ranges: [{ cidr: `${WEBHOOK_IP}/32`, asn: 24940, network: "HETZNER-AS", ips: 1 }] },
    ja4: GO_JA4,
    userAgent: "Apache-HttpClient/4.5.14 (Java/17.0.12)",
  },
  alert: {
    id: "SEC-7120",
    title: "Webhook signature failures on /webhooks/shipping",
    rule: "integrations.webhook.signature_failures",
    severity: "medium",
    openedAt: -240,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("webhook-signatures", "Shipping webhooks by sender and signature result", (state) => {
      const { past } = edge(state);
      return [
        "POST /webhooks/shipping · last 15 min",
        ...table([
          ["ClientIP", "ClientASN", "REQ/MIN", "SIGNATURE", "ClientRequestUserAgent"],
          [WEBHOOK_IP, "24940 HETZNER-AS", count(past), "invalid: timestamp outside 300 s tolerance", "Apache-HttpClient/4.5.14 (Java/17.0.12)"],
          ["34.86.12.0/24 (ShipStream egress)", "396982 GOOGLE-CLOUD-PLATFORM", "22", "valid", "ShipStream-Webhooks/2.4"],
        ]),
        "The Hetzner sender replays the same 40 captured ShipStream payloads from last Tuesday, unchanged, in a loop.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-7120", "siem search webhook-signatures", "waf top", "waf block --top 50"],
  lostCheckoutsPerPoint: 65,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 9%. SEC-7120 (medium): webhook signature failures. Assigned to SOC on-call (you)." },
    { at: 40, from: "Tom Becker · Fulfilment", text: "ShipStream says they're sending their usual volume from their usual range. It isn't them." },
    { at: 100, from: "Sam Tan · Eng manager", text: "Just block the top 50 addresses on checkout, whatever's in there." },
    { at: 170, from: "Lena Park · SOC lead", text: "The top 50 on checkout are mostly phone carriers. One address at thousands a minute is all you need." },
    { at: 260, from: "Elena Ruiz · VP Engineering", text: "Checkout errors are climbing again. Status?" },
  ],
  hints: [
    "The carrier's real webhooks are signed and steady. Something else isn't.",
    "Find who sends the requests that fail signature checks.",
    "A list of the busiest addresses includes customers behind phone carriers. Block exactly what's guilty.",
  ],
  solution: [
    { command: "siem search webhook-signatures", why: `One Hetzner address, ${WEBHOOK_IP}, replays stale ShipStream payloads; the real carrier sends 22 a minute, all valid.` },
    { command: "waf top 5", why: `${WEBHOOK_IP} sends thousands of requests a minute; the next addresses are carrier NAT customers at about 13.` },
    { command: `waf block ${WEBHOOK_IP}`, why: "Blocks the one replaying address; 0% of checkout customers behind it." },
    {
      command: 'siem resolve SEC-7120 --disposition true-positive --contained-by r-0003 --note "webhook replay from one Hetzner host, blocked"',
      why: "A real replay attack, contained by the single-address block.",
    },
    { command: "waf rules", why: "The block matches the replay; the pods drain and the 5xx stop." },
  ],
  postmortem: {
    question: "What was filling checkout-api with webhooks?",
    options: [
      "ShipStream retrying deliveries after our endpoint timed out",
      "One Hetzner host replaying captured ShipStream payloads",
      "Customers' tracking pages polling for shipment updates",
      "A ShipStream key rotation that broke every signature check",
    ],
    answerIndex: 1,
    explanation: {
      cause: "A single Hetzner host replayed captured ShipStream webhooks in a loop.",
      why: "The payloads were a week old, so every signature failed the 300 s timestamp check, but each one still cost checkout-api a request. Blocking the top 50 would have cut off ~8% of customers behind carrier NAT; blocking the one address stopped the replay alone.",
      tell: `siem search webhook-signatures: ${WEBHOOK_IP} at thousands a minute, every signature outside tolerance; ShipStream's range valid at 22.`,
    },
  },
};

// ── 12. GraphQL query flood from one Alibaba host; a CGNAT address takes the blame ─────────────

const GRAPHQL_IP = "47.89.200.17";

const graphqlFlood: Row = {
  id: "sec-t2-graphql-depth-flood",
  title: "Nested queries all the way down",
  severity: "SEV2",
  opensAtSecondOfDay: 15 * 3600 + 5 * 60,
  briefing:
    "POST /graphql is answering deeply nested queries thousands of times a minute and checkout-api is shedding requests. A teammate has already spotted a busy T-Mobile address sending failing queries.",
  roleBriefing:
    "SOC on-call: siem and waf. Something is sending pathological GraphQL queries to checkout-api. The obvious suspect is a busy phone-carrier address. Check who really sends the expensive queries, stop it without blocking customers, and close SEC-7233.",
  attack: {
    label: "GraphQL query flood",
    path: "/graphql",
    requestsPerSecond: 125,
    growthPerSecond: 0.2,
    sources: { kind: "ranges", ranges: [{ cidr: `${GRAPHQL_IP}/32`, asn: 45102, network: "ALIBABA-CN-NET", ips: 1 }] },
    ja4: PYTHON_JA4,
    userAgent: "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  },
  alert: {
    id: "SEC-7233",
    title: "GraphQL query cost far above baseline",
    rule: "api.graphql.query_cost_anomaly",
    severity: "high",
    openedAt: -85,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("graphql-cost", "GraphQL requests by source, with query depth and errors", (state) => {
      const { past } = edge(state);
      return [
        "POST /graphql · last 15 min, top senders by total query cost",
        ...table([
          ["ClientIP", "ClientASN", "REQ/MIN", "QUERY DEPTH (p99)", "ERRORS", "ClientRequestUserAgent"],
          [GRAPHQL_IP, "45102 ALIBABA-CN-NET", count(past), "14", "0.2%", "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)"],
          ["172.5x.x.x (carrier NAT)", "21928 T-MOBILE-AS21928", "13", "3", "38%", "Marlow/7.3.0 (com.marlow.shop; …)"],
        ]),
        "The T-Mobile address is one carrier NAT egress: hundreds of phones, each retrying a cart query that times out while the pods are full.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-7233", "siem search graphql-cost", "waf top 5", "waf top --by asn"],
  lostCheckoutsPerPoint: 60,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 8% and rising. SEC-7233 (high): GraphQL query cost. Assigned to SOC on-call (you)." },
    { at: 30, from: "Sam Tan · Eng manager", text: "The T-Mobile address second in waf top has a 38% error rate. That's our bad actor, block it." },
    { at: 90, from: "Priya Shah · Checkout web", text: "Someone is asking for products → reviews → author → orders → products, fourteen levels deep." },
    { at: 160, from: "Lena Park · SOC lead", text: "A carrier address with errors is usually customers suffering, not causing. Who sends the deep queries?" },
    { at: 250, from: "Elena Ruiz · VP Engineering", text: "Checkout keeps getting worse. What's the plan?" },
  ],
  hints: [
    "Errors show who is suffering. Cost shows who is causing it.",
    "One phone-carrier address can stand for hundreds of people.",
    "Rank the senders by how expensive their queries are, not by how many fail.",
  ],
  solution: [
    { command: "siem search graphql-cost", why: `${GRAPHQL_IP} on Alibaba sends depth-14 queries thousands of times a minute; the T-Mobile address is customers timing out.` },
    { command: "waf top 5", why: `${GRAPHQL_IP} at thousands a minute; the carrier NAT address behind it sends about 13.` },
    { command: `waf block ${GRAPHQL_IP}`, why: "Blocks the one address sending the expensive queries; 0% of checkout customers behind it." },
    {
      command: 'siem resolve SEC-7233 --disposition true-positive --contained-by r-0003 --note "GraphQL depth flood from one Alibaba host, blocked"',
      why: "A real resource-exhaustion attack, contained by the single-address block.",
    },
    { command: "waf rules", why: "The block matches the flood; the pods drain and the carrier address's errors vanish." },
  ],
  postmortem: {
    question: "Why was the T-Mobile address the wrong one to block?",
    options: [
      "Carrier NAT: hundreds of customers suffering, not attacking",
      "T-Mobile addresses rotate too quickly for an IP block to hold",
      "The WAF never blocks mobile carrier addresses on POST /graphql",
      "It was the Marlow iOS app's own health-check that kept failing",
    ],
    answerIndex: 0,
    explanation: {
      cause: "One Alibaba host sent 14-deep GraphQL queries until checkout-api's pods were full.",
      why: "The carrier address showed errors because the customers behind it were timing out, not because it was attacking. Blocking it would have locked those customers out and left the flood running. Ranking by query cost pointed straight at the Alibaba address.",
      tell: `siem search graphql-cost: ${GRAPHQL_IP} at depth 14 and thousands a minute; the T-Mobile address at 13 a minute with 38% errors.`,
    },
  },
};

// ── 13. Two alerts, one fire: a sale surge alert and a real price scraper ──────────────────────

const twoAlerts: Row = {
  id: "sec-t2-two-alerts-one-fire",
  title: "Two alerts, one fire",
  severity: "SEV2",
  opensAtSecondOfDay: 18 * 3600 + 5 * 60,
  briefing:
    "Checkout-api is shedding requests half an hour after the evening sale email. Two SIEM alerts are open: a residential traffic surge, and scraping on GET /catalog/prices, which the checkout pods serve.",
  roleBriefing:
    "SOC on-call: siem and waf. Two alerts, SEC-7301 and SEC-7302. One is the sale doing what sales do; the other is filling the pods. Contain the real one without blocking shoppers, and close both with the right dispositions.",
  attack: {
    label: "price scraping",
    path: "/catalog/prices",
    requestsPerSecond: 165,
    growthPerSecond: 0.12,
    sources: { kind: "ranges", ranges: [{ cidr: "51.15.0.0/16", asn: 12876, network: "Online SAS", ips: 200 }] },
    ja4: GO_JA4,
    userAgent: "Scrapy/2.11.2 (+https://scrapy.org)",
  },
  alert: {
    id: "SEC-7302",
    title: "Catalogue price scraping from hosting ASN",
    rule: "edge.catalog.scrape_from_hosting",
    severity: "medium",
    openedAt: -600,
  },
  benignAlert: {
    id: "SEC-7301",
    title: "Possible DDoS: request surge from residential ISPs",
    rule: "edge.volume.residential_surge",
    severity: "high",
    openedAt: -1500,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("surge-breakdown", "Traffic since the sale email, by network type and outcome", (state) => {
      const { past } = edge(state);
      return [
        "All paths · last 15 min vs the same hour last week",
        ...table([
          ["SOURCE", "REQ/MIN NOW", "REQ/MIN LAST WEEK", "ORDERS/MIN", "TOP PATH"],
          ["residential + mobile (Comcast, T-Mobile, Verizon, AT&T)", "21,400", "10,900", "1,180", "/checkout, /product"],
          ["AS12876 Online SAS (Scaleway) 51.15.0.0/16", count(past), "0", "0", "/catalog/prices"],
        ]),
        "The residential surge tracks the 17:30 sale email click curve and orders doubled with it. Scaleway sends Scrapy/2.11.2 and never orders.",
      ];
    }),
  ],
  suggestions: ["siem alerts", "siem show SEC-7301", "siem show SEC-7302", "siem search surge-breakdown", "waf top --by asn"],
  lostCheckoutsPerPoint: 125,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 16%. Open: SEC-7301 (high) residential surge, SEC-7302 (medium) price scraping. Assigned to SOC on-call (you)." },
    { at: 30, from: "Lena Ortiz · Growth", text: "Sale email went out at 17:30. Traffic should be about double tonight." },
    { at: 80, from: "Sam Tan · Eng manager", text: "SEC-7301 is high severity and says DDoS from Comcast. Block Comcast until it calms down?" },
    { at: 150, from: "Lena Park · SOC lead", text: "Severity is the rule's opinion. Which traffic is buying things, and which isn't?" },
    { at: 240, from: "Maya Okonkwo · Support", text: "Sale shoppers can't pay. This is the worst night for it." },
  ],
  hints: [
    "One alert describes customers doing exactly what the email asked them to.",
    "Line each traffic source up against the orders it produces.",
    "Close each alert with what it turned out to be, not with what it was afraid of.",
  ],
  solution: [
    { command: "siem alerts", why: "Two open alerts: a high-severity residential surge and a medium-severity scraper." },
    { command: "siem search surge-breakdown", why: "The residential surge follows the sale email and orders doubled with it; Scaleway sends Scrapy and orders nothing." },
    { command: "waf top --by asn", why: "AS12876, 51.15.0.0/16, is the only network with no customers in it." },
    { command: "waf block 51.15.0.0/16", why: "Blocks the scraper's range; 0% of checkout customers behind it." },
    {
      command: 'siem resolve SEC-7302 --disposition true-positive --contained-by r-0003 --note "Scrapy price scraper on Scaleway, blocked"',
      why: "The scraper is the real attack, contained by the range block.",
    },
    { command: 'siem resolve SEC-7301 --disposition benign --note "sale email traffic, orders doubled with it"', why: "The rule fired correctly on real activity that is expected: a benign true positive." },
    { command: "waf rules", why: "The block matches the scraper and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Which open alert was the cause of the 5xx?",
    options: [
      "SEC-7302: the Scaleway price scraper on /catalog/prices",
      "SEC-7301: a DDoS from residential ISPs during the sale",
      "Both: the scraper and the surge each overloaded the pods",
      "Neither: the sale sent more shoppers than the pods can hold",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A Scrapy price scraper on Scaleway filled checkout-api's pods during the sale.",
      why: "The residential surge was the sale email's shoppers, ordering in proportion; the pods had room for them. The scraper added ~165 requests a second with no orders, which pushed the pods over. Blocking Comcast would have cut off shoppers and left the scraper running.",
      tell: "siem search surge-breakdown: residential traffic doubled with orders; Scaleway sent Scrapy/2.11.2 and ordered nothing.",
    },
  },
};

// ── 14. Referral fraud from a big Azure range; a per-address limit can't see it ───────────────

const referralFarm: Row = {
  id: "sec-t2-referral-farm-azure",
  title: "Everyone is referring everyone",
  severity: "SEV2",
  opensAtSecondOfDay: 22 * 3600 + 15 * 60,
  briefing:
    "Referral claims on POST /referrals/claim are at fifty times normal, each one minting a $15 credit, and checkout-api is shedding requests. The claims come from over a thousand addresses, each claiming a few times a minute.",
  roleBriefing:
    "SOC on-call: siem and waf. A referral farm is minting store credit. Gmail's image proxy also fetches referral links when emails are opened, and it runs from Google's cloud. Work out which traffic is the farm, stop it, and close SEC-7409.",
  attack: {
    label: "referral farm",
    path: "/referrals/claim",
    requestsPerSecond: 170,
    growthPerSecond: 0.12,
    sources: { kind: "ranges", ranges: [{ cidr: "20.42.0.0/15", asn: 8075, network: "MICROSOFT-CORP-MSN-AS-BLOCK", ips: 1100 }] },
    ja4: PYTHON_JA4,
    userAgent: CHROME_120_WINDOWS,
  },
  alert: {
    id: "SEC-7409",
    title: "Referral credits minted far above baseline",
    rule: "growth.referral.claim_velocity",
    severity: "high",
    openedAt: -140,
  },
  stoppedShare: 0.99,
  evidence: [
    siem("referral-claims", "Referral claims by source network and outcome", (state) => {
      const { past } = edge(state);
      return [
        "POST /referrals/claim · last 15 min",
        ...table([
          ["ClientASN", "ClientIP (distinct)", "CLAIMS/MIN", "PER IP/MIN", "NEW ACCOUNT < 1 h", "ClientRequestUserAgent"],
          ["8075 MICROSOFT-CORP-MSN-AS-BLOCK (20.42.0.0/15)", "1,100", count(past), count(past / 1100), "100%", "Chrome/120.0.0.0 (Windows)"],
          ["15169 GOOGLE (66.102.0.0/20)", "61", "14", "0", "—", "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"],
          ["customer networks", "540", "19", "0", "4%", "browsers, Marlow apps"],
        ]),
        "Gmail's image proxy only GETs the referral banner image; it never POSTs a claim. Every Azure claim credits a referrer among 40 accounts.",
      ];
    }),
  ],
  suggestions: ["siem show SEC-7409", "siem search referral-claims", "waf top --by asn", "waf ratelimit 20/1m"],
  lostCheckoutsPerPoint: 110,
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 17%. SEC-7409 (high): referral credit velocity. Assigned to SOC on-call (you)." },
    { at: 30, from: "Kai Brooks · Growth", text: "Forty accounts have earned $60k in referral credit tonight. That is not organic." },
    { at: 85, from: "Sam Tan · Eng manager", text: "Rate limit it, same as the login storm last month. 20 a minute worked then." },
    { at: 150, from: "Lena Park · SOC lead", text: "Check what each address sends before you reach for a per-address limit." },
    { at: 230, from: "Dev Raman · Identity team", text: "Someone mentioned the Gmail proxy. It only fetches images, it can't claim anything." },
  ],
  hints: [
    "Over a thousand addresses, each quieter than a busy shopper. What does that do to a per-address cap?",
    "Two cloud networks touch the referral flow. Only one of them makes claims.",
    "The farm sits in one rented block. Look at where the claims come from as a whole.",
  ],
  solution: [
    { command: "siem search referral-claims", why: "1,100 Azure addresses claim ~9 a minute each for new accounts; Gmail's image proxy never claims anything." },
    { command: "waf top --by asn", why: "AS8075, 20.42.0.0/15, carries most of the traffic; no customer lives there." },
    { command: "waf block 20.42.0.0/15", why: "Stops the whole farm; the preview shows 0% of checkout customers." },
    {
      command: 'siem resolve SEC-7409 --disposition true-positive --contained-by r-0003 --note "referral farm on Azure 20.42.0.0/15, blocked"',
      why: "Real referral fraud, contained by the range block.",
    },
    { command: "waf rules", why: "The block matches the farm and 0% of checkout; the 5xx drain." },
  ],
  postmortem: {
    question: "Why would a 20-a-minute limit per address have done nothing?",
    options: [
      "Each Azure address sent only about 9 claims a minute",
      "Gmail's image proxy would have used up the limit first",
      "The WAF only rate limits POST /checkout and POST /session",
      "Rate limits take ten minutes to propagate across the edge",
    ],
    answerIndex: 0,
    explanation: {
      cause: "A referral farm on 1,100 Azure addresses minted credit at ~9 claims a minute each.",
      why: "Spread that thin, no address came near a 20-a-minute cap, so the limit stopped nothing. Gmail's proxy only fetched images. Every claim came from one Azure /15 with no customers in it, so a range block stopped the farm cleanly.",
      tell: "siem search referral-claims: 1,100 Azure addresses, ~9 claims a minute each, all for accounts under an hour old.",
    },
  },
};

export const SECURITY_TIER2_INCIDENTS: readonly Scenario[] = [
  giftCards,
  smsPumping,
  promoBrute,
  signupFarm,
  fakeGooglebot,
  addressProxy,
  otpBrute,
  cartHoarding,
  loyaltyDrain,
  searchScraper,
  webhookReplay,
  graphqlFlood,
  twoAlerts,
  referralFarm,
].map(incident);
