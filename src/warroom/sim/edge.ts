import type { Attack, Commerce, SiemAlert, WafRule } from "./commerce.ts";

/**
 * Checkout customers sit behind a long tail of source IPs, but the head is carrier-grade NAT:
 * one mobile-carrier egress address fronts many unrelated phones. Blocking "top talkers"
 * therefore blocks real customers in bulk.
 */
const HEAD_SHARE = 0.46;
const HEAD_DECAY = 260;
export const DISTINCT_SOURCE_IPS = 3_140;

type Network = { readonly asn: number; readonly name: string; readonly kind: "mobile" | "residential"; readonly prefix: readonly [number, number]; readonly span: number };

const NETWORKS: readonly Network[] = [
  { asn: 21928, name: "T-MOBILE-AS21928", kind: "mobile", prefix: [172, 32], span: 32 },
  { asn: 22394, name: "CELLCO (Verizon Wireless)", kind: "mobile", prefix: [174, 192], span: 64 },
  { asn: 20057, name: "ATT-MOBILITY-LLC-AS20057", kind: "mobile", prefix: [107, 77], span: 1 },
  { asn: 7922, name: "COMCAST-7922", kind: "residential", prefix: [73, 0], span: 256 },
];

export type TopTalker = {
  readonly rank: number;
  readonly ip: string;
  readonly asn: number;
  readonly network: string;
  readonly kind: Network["kind"];
  /** Share of checkout customers behind this address. */
  readonly customerShare: number;
};

function scramble(seed: number): number {
  return Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0;
}

/** Share of checkout customers behind the customer address at `rank`. */
function talkerShare(rank: number): number {
  return HEAD_SHARE * (Math.exp(-(rank - 1) / HEAD_DECAY) - Math.exp(-rank / HEAD_DECAY));
}

export function topTalker(rank: number): TopTalker {
  // Carrier NAT dominates the head; residential addresses take over further down.
  const network = rank <= 40 ? NETWORKS[scramble(rank) % 3] : NETWORKS[scramble(rank) % NETWORKS.length];
  const bits = scramble(rank * 7919 + 17);
  const second = network.prefix[1] + (bits % network.span);
  const third = (bits >>> 8) % 256;
  const fourth = 1 + ((bits >>> 16) % 254);
  return {
    rank,
    ip: `${network.prefix[0]}.${second}.${third}.${fourth}`,
    asn: network.asn,
    network: network.name,
    kind: network.kind,
    customerShare: talkerShare(rank),
  };
}

export function topTalkers(count: number): TopTalker[] {
  return Array.from({ length: Math.max(0, Math.min(count, DISTINCT_SOURCE_IPS)) }, (_, index) => topTalker(index + 1));
}

/** Share of checkout customers behind the top `count` source addresses. */
export function topTalkerShare(count: number): number {
  const n = Math.max(0, Math.min(count, DISTINCT_SOURCE_IPS));
  return HEAD_SHARE * (1 - Math.exp(-n / HEAD_DECAY));
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

function numberToIp(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function parseCidr(text: string): { readonly base: number; readonly bits: number } | null {
  const [address, maskText] = text.split("/");
  const base = ipToNumber(address ?? "");
  const bits = maskText === undefined ? 32 : Number(maskText);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

function inCidr(ip: string, cidr: { readonly base: number; readonly bits: number }): boolean {
  const value = ipToNumber(ip);
  if (value === null) return false;
  const size = 2 ** (32 - cidr.bits);
  return Math.floor(value / size) === Math.floor(cidr.base / size);
}

/** Customers caught by blocking a CIDR: whichever ranked talkers fall inside it, plus the long tail it covers. */
export function cidrCustomerShare(cidr: { readonly base: number; readonly bits: number }): number {
  const ranked = topTalkers(DISTINCT_SOURCE_IPS).filter((talker) => inCidr(talker.ip, cidr));
  return Math.min(1, ranked.reduce((sum, talker) => sum + talker.customerShare, 0));
}

/** A per-IP limit stops the excess from every address sending more than `perMinute`. */
export function rateLimitCustomerShare(perMinute: number, checkoutAttemptsPerSecond: number): number {
  const attemptsPerMinute = checkoutAttemptsPerSecond * 60;
  return topTalkers(DISTINCT_SOURCE_IPS).reduce((sum, talker) => {
    const rate = attemptsPerMinute * talker.customerShare;
    return rate > perMinute ? sum + talker.customerShare * (1 - perMinute / rate) : sum;
  }, 0);
}

export function blockedShare(rules: readonly WafRule[]): number {
  return 1 - rules.reduce((open, rule) => open * (1 - rule.customerShare), 1);
}

/**
 * Share of attack traffic the WAF's rules stop between them. Blocks pick out attacker addresses, so
 * their shares add up (blocking two ranges stops both); rate limits thin whatever the blocks let through.
 * ponytail: blocks are taken to cover different attackers; one partial block nested inside another
 * overcounts. Evaluate each rule per attacker pool if a scenario ever needs that.
 */
export function blockedAttackShare(rules: readonly WafRule[]): number {
  const blocked = Math.min(1, rules.reduce((sum, rule) => sum + (rule.action === "block" ? (rule.attackShare ?? 0) : 0), 0));
  const passed = rules.reduce((open, rule) => open * (rule.action === "rate_limit" ? 1 - (rule.attackShare ?? 0) : 1), 1);
  return 1 - (1 - blocked) * passed;
}

/** Requests per second the attack sends at `t`, before the WAF: it keeps growing until something stops it. */
export function attackRequestsPerSecond(attack: Attack, t: number): number {
  return Math.max(0, attack.requestsPerSecond + attack.growthPerSecond * t);
}

export type SourceKind = Network["kind"] | "hosting";

/** Attacker addresses inside one network: a rented hosting range, or one ISP's slice of a residential proxy pool. */
type AttackPool = {
  readonly first: number;
  readonly size: number;
  readonly ips: number;
  readonly asn: number;
  readonly network: string;
  readonly kind: SourceKind;
  readonly prefix: string;
};

function networkPrefix(network: Network): string {
  return `${network.prefix[0]}.${network.prefix[1]}.0.0/${16 - Math.log2(network.span)}`;
}

function attackPools(attack: Attack): readonly AttackPool[] {
  const { sources } = attack;
  if (sources.kind === "ranges") {
    return sources.ranges.flatMap((range) => {
      const cidr = parseCidr(range.cidr);
      if (!cidr) return [];
      const size = 2 ** (32 - cidr.bits);
      return [{ first: Math.floor(cidr.base / size) * size, size, ips: range.ips, asn: range.asn, network: range.network, kind: "hosting" as const, prefix: range.cidr }];
    });
  }
  // Residential proxies rent the same carrier and ISP addresses checkout's customers come from.
  return NETWORKS.map((network, index) => ({
    first: (network.prefix[0] * 256 + network.prefix[1]) * 65_536,
    size: network.span * 65_536,
    ips: Math.floor(sources.ips / NETWORKS.length) + (index < sources.ips % NETWORKS.length ? 1 : 0),
    asn: network.asn,
    network: network.name,
    kind: network.kind,
    prefix: networkPrefix(network),
  }));
}

/** One address calling the protected paths, customer or attacker, as the edge ranks it. */
export type Source = {
  readonly rank: number;
  readonly ip: string;
  readonly asn: number;
  readonly network: string;
  readonly kind: SourceKind;
  readonly requestsPerMinute: number;
};

/**
 * Every attacker address sends the same share of the attack, so the edge's ranking is customers busier
 * than one attacker, then the attackers, then the rest of the customers. Nothing is listed one by one.
 */
type Ranking = {
  readonly pools: readonly AttackPool[];
  readonly attackers: number;
  readonly attackerPerMinute: number;
  readonly checkoutPerMinute: number;
  /** Customer addresses that each send more than one attacker address does. */
  readonly customersAbove: number;
};

function ranking(commerce: Commerce, t: number): Ranking | null {
  const { attack } = commerce;
  if (!attack) return null;
  const pools = attackPools(attack);
  const attackers = pools.reduce((sum, pool) => sum + pool.ips, 0);
  if (attackers === 0) return null;
  const checkoutPerMinute = commerce.pulse.checkoutAttemptsPerSecond * 60;
  const attackerPerMinute = (attackRequestsPerSecond(attack, t) * 60) / attackers;
  let customersAbove = 0;
  while (customersAbove < DISTINCT_SOURCE_IPS && checkoutPerMinute * talkerShare(customersAbove + 1) > attackerPerMinute) customersAbove += 1;
  return { pools, attackers, attackerPerMinute, checkoutPerMinute, customersAbove };
}

function attackerAt(ranked: Ranking, index: number, rank: number): Source {
  let offset = index;
  const pool = ranked.pools.find((candidate) => (offset -= candidate.ips) < 0) ?? ranked.pools[0];
  const bits = scramble(index * 2_654_435_761 + 40_503);
  // Inside a range bigger than a /24, skip the .0 and .255 a real host never has.
  const host = pool.size >= 256 ? (bits % (pool.size / 256)) * 256 + 1 + ((bits >>> 8) % 254) : bits % pool.size;
  return { rank, ip: numberToIp(pool.first + host), asn: pool.asn, network: pool.network, kind: pool.kind, requestsPerMinute: ranked.attackerPerMinute };
}

function customerAt(rank: number, customerRank: number, checkoutPerMinute: number): Source {
  const talker = topTalker(customerRank);
  return { rank, ip: talker.ip, asn: talker.asn, network: talker.network, kind: talker.kind, requestsPerMinute: checkoutPerMinute * talker.customerShare };
}

export function distinctSourceIps(commerce: Commerce): number {
  const { attack } = commerce;
  return DISTINCT_SOURCE_IPS + (attack ? attackPools(attack).reduce((sum, pool) => sum + pool.ips, 0) : 0);
}

/** The busiest `count` addresses on the protected paths, attackers folded in among the customers. */
export function topSources(commerce: Commerce, t: number, count: number): Source[] {
  const ranked = ranking(commerce, t);
  const checkoutPerMinute = commerce.pulse.checkoutAttemptsPerSecond * 60;
  const length = Math.max(0, Math.min(count, distinctSourceIps(commerce)));
  return Array.from({ length }, (_, index) => {
    const rank = index + 1;
    if (!ranked || rank <= ranked.customersAbove) return customerAt(rank, rank, checkoutPerMinute);
    if (rank <= ranked.customersAbove + ranked.attackers) return attackerAt(ranked, rank - ranked.customersAbove - 1, rank);
    return customerAt(rank, rank - ranked.attackers, checkoutPerMinute);
  });
}

/** What a rule stops: its share of checkout customers, and of the attack when there is one. */
export type RuleReach = { readonly customerShare: number; readonly attackShare?: number };

/** Blocking the top `count` addresses of the merged ranking. */
export function topReach(commerce: Commerce, t: number, count: number): RuleReach {
  const ranked = ranking(commerce, t);
  if (!ranked) return { customerShare: topTalkerShare(count) };
  const { customersAbove, attackers } = ranked;
  const attackersTaken = Math.min(attackers, Math.max(0, count - customersAbove));
  const customersTaken = Math.min(count, customersAbove) + Math.max(0, count - customersAbove - attackers);
  return { customerShare: topTalkerShare(customersTaken), attackShare: attackersTaken / attackers };
}

/** Share of `requestsPerMinute` sent by the top `count` addresses. */
export function topRequestShare(commerce: Commerce, t: number, count: number): number {
  const ranked = ranking(commerce, t);
  if (!ranked) return topTalkerShare(count);
  const reach = topReach(commerce, t, count);
  const attackPerMinute = ranked.attackerPerMinute * ranked.attackers;
  const total = ranked.checkoutPerMinute + attackPerMinute;
  return total > 0 ? (ranked.checkoutPerMinute * reach.customerShare + attackPerMinute * (reach.attackShare ?? 0)) / total : 0;
}

/** Attacker addresses inside a CIDR, spread evenly over each pool they come from. */
function cidrAttackShare(attack: Attack, cidr: { readonly base: number; readonly bits: number }): number {
  const pools = attackPools(attack);
  const attackers = pools.reduce((sum, pool) => sum + pool.ips, 0);
  const size = 2 ** (32 - cidr.bits);
  const first = Math.floor(cidr.base / size) * size;
  const caught = pools.reduce((sum, pool) => {
    const overlap = Math.max(0, Math.min(first + size, pool.first + pool.size) - Math.max(first, pool.first));
    return sum + (pool.ips * overlap) / pool.size;
  }, 0);
  return attackers > 0 ? caught / attackers : 0;
}

export function cidrReach(commerce: Commerce, cidr: { readonly base: number; readonly bits: number }): RuleReach {
  const { attack } = commerce;
  return { customerShare: cidrCustomerShare(cidr), ...(attack ? { attackShare: cidrAttackShare(attack, cidr) } : {}) };
}

/**
 * A per-IP limit passes `perMinute` from each attacker address and stops the rest. The share is
 * taken when the rule is made: an attack that keeps growing per address slips a little more past it.
 */
export function rateLimitReach(commerce: Commerce, t: number, perMinute: number): RuleReach {
  const customerShare = rateLimitCustomerShare(perMinute, commerce.pulse.checkoutAttemptsPerSecond);
  if (!commerce.attack) return { customerShare };
  const perAddress = ranking(commerce, t)?.attackerPerMinute ?? 0;
  return { customerShare, attackShare: perAddress > 0 ? Math.max(0, 1 - perMinute / perAddress) : 0 };
}

/**
 * TLS client fingerprints of the browsers checkout's customers use, and the share of customers behind each.
 * Strings are FoxIO's (JA4 README and ja4plus-mapping.csv). The apps' own fingerprints aren't published
 * there, so they're left out: blocking a fingerprint not listed here turns no customer away.
 */
export const BROWSER_JA4: readonly { readonly ja4: string; readonly client: string; readonly customerShare: number }[] = [
  { ja4: "t13d1517h2_8daaf6152771_cb7bf5808d99", client: "Chromium Browser", customerShare: 0.31 },
  { ja4: "t13d2014h2_a09f3c656075_14788d8d241b", client: "Safari", customerShare: 0.17 },
  { ja4: "t13d1715h2_5b57614c22b0_7121afd63204", client: "Mozilla Firefox", customerShare: 0.03 },
];

/** JA4's a_b_c shape: protocol, TLS version, SNI, cipher and extension counts, ALPN; then two 12-hex hashes. */
const JA4_PATTERN = /^[tqd](?:1[0-3]|s[23]|d[1-3]|00)[di]\d{4}[0-9A-Za-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;

export function isJa4(text: string): boolean {
  return JA4_PATTERN.test(text);
}

export function ja4Reach(commerce: Commerce, ja4: string): RuleReach {
  const customerShare = BROWSER_JA4.find((entry) => entry.ja4 === ja4)?.customerShare ?? 0;
  const { attack } = commerce;
  return { customerShare, ...(attack ? { attackShare: attack.ja4 === ja4 ? 1 : 0 } : {}) };
}

/** Requests from one network, customers and attackers together. */
export type AsnTalkers = {
  readonly asn: number;
  readonly network: string;
  readonly kind: SourceKind;
  readonly ips: number;
  readonly requestsPerMinute: number;
  readonly prefixes: readonly string[];
};

/** The ranked addresses and the attack, totalled per origin network, busiest first. */
export function sourcesByAsn(commerce: Commerce, t: number): AsnTalkers[] {
  const rows = new Map<number, AsnTalkers>();
  const add = (row: AsnTalkers) => {
    const previous = rows.get(row.asn);
    rows.set(
      row.asn,
      previous
        ? { ...previous, ips: previous.ips + row.ips, requestsPerMinute: previous.requestsPerMinute + row.requestsPerMinute, prefixes: [...new Set([...previous.prefixes, ...row.prefixes])] }
        : row,
    );
  };
  const checkoutPerMinute = commerce.pulse.checkoutAttemptsPerSecond * 60;
  for (const talker of topTalkers(DISTINCT_SOURCE_IPS)) {
    const network = NETWORKS.find((candidate) => candidate.asn === talker.asn);
    add({ asn: talker.asn, network: talker.network, kind: talker.kind, ips: 1, requestsPerMinute: checkoutPerMinute * talker.customerShare, prefixes: network ? [networkPrefix(network)] : [] });
  }
  const ranked = ranking(commerce, t);
  for (const pool of ranked?.pools ?? []) {
    add({ asn: pool.asn, network: pool.network, kind: pool.kind, ips: pool.ips, requestsPerMinute: pool.ips * (ranked?.attackerPerMinute ?? 0), prefixes: [pool.prefix] });
  }
  return [...rows.values()].sort((left, right) => right.requestsPerMinute - left.requestsPerMinute);
}

/** The paths the WAF's rules guard: checkout, and whatever else the attack hits on checkout-api. */
export function protectedPaths(commerce: Commerce): string {
  const path = commerce.attack?.path;
  return !path || path === "/checkout" ? 'http.request.uri.path eq "/checkout"' : `http.request.uri.path in {"/checkout" "${path}"}`;
}

export function wafRuleId(commerce: Commerce): string {
  return `r-${String(commerce.nextWafRuleNumber).padStart(4, "0")}`;
}

/** The SOAR playbook's response to an alert: block its top talkers on the checkout path. */
export function containmentRule(commerce: Commerce, alert: SiemAlert, t: number): WafRule {
  return {
    id: wafRuleId(commerce),
    action: "block",
    expression: `ip.src in $soar_${alert.id.toLowerCase().replace(/-/g, "_")}_top${alert.containTopIps} and ${protectedPaths(commerce)}`,
    createdAt: t,
    createdBy: `soar:playbook/auto-contain (${alert.id})`,
    ...topReach(commerce, t, alert.containTopIps),
  };
}
