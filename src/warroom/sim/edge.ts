import type { Commerce, SiemAlert, WafRule } from "./commerce.ts";

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
    customerShare: HEAD_SHARE * (Math.exp(-(rank - 1) / HEAD_DECAY) - Math.exp(-rank / HEAD_DECAY)),
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

export function wafRuleId(commerce: Commerce): string {
  return `r-${String(commerce.nextWafRuleNumber).padStart(4, "0")}`;
}

/** The SOAR playbook's response to an alert: block its top talkers on the checkout path. */
export function containmentRule(commerce: Commerce, alert: SiemAlert, t: number): WafRule {
  return {
    id: wafRuleId(commerce),
    action: "block",
    expression: `ip.src in $soar_${alert.id.toLowerCase().replace(/-/g, "_")}_top${alert.containTopIps} and http.request.uri.path eq "/checkout"`,
    createdAt: t,
    createdBy: `soar:playbook/auto-contain (${alert.id})`,
    customerShare: topTalkerShare(alert.containTopIps),
  };
}
