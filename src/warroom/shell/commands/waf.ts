import { addWafRule, deleteWafRule } from "../../sim/commerce-actions.ts";
import type { Commerce, WafRule } from "../../sim/commerce.ts";
import {
  attackRequestsPerSecond,
  cidrReach,
  distinctSourceIps,
  parseCidr,
  protectedPaths,
  rateLimitReach,
  sourcesByAsn,
  topReach,
  topRequestShare,
  topSources,
  wafRuleId,
  type SourceKind,
} from "../../sim/edge.ts";
import { applied, commerceCommand, count, percent, stamp, WINDOW_SECONDS } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { dim, err, out, table, type ShellContext, type ShellResult } from "../types.ts";

const PERIOD_SECONDS: Record<string, number> = { "10s": 10, "1m": 60, "10m": 600, "1h": 3600 };
const SOURCE_TYPES: Record<SourceKind, string> = { mobile: "mobile carrier (CGNAT)", residential: "residential ISP", hosting: "hosting / datacenter" };

/** Attack requests a rule stopped over the telemetry window. */
function attackMatched(rule: WafRule, commerce: Commerce, t: number): number {
  return commerce.attack ? (rule.attackShare ?? 0) * attackRequestsPerSecond(commerce.attack, t) * WINDOW_SECONDS : 0;
}

function matchedPerWindow(rule: WafRule, commerce: Commerce, t: number): string {
  if (rule.expression.includes('"/checkout"')) return count(rule.customerShare * commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS + attackMatched(rule, commerce, t));
  // Rules on other paths still see their usual background hits.
  let hash = 0;
  for (const char of rule.id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return count(20 + (hash % 180));
}

function rules(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = commerce.wafRules.map((rule) => [rule.id, rule.action, rule.expression, stamp(context, rule.createdAt), rule.createdBy, matchedPerWindow(rule, commerce, context.cluster.t)]);
  return { output: out(...table([["ID", "ACTION", "EXPRESSION", "CREATED", "BY", "MATCHED/5M"], ...rows])) };
}

/** The request line(s) `waf top` covers: checkout, plus the attacked path when it isn't checkout. */
function pathsLabel(commerce: Commerce): string {
  const path = commerce.attack?.path;
  return !path || path === "/checkout" ? "POST /checkout" : `POST /checkout, POST ${path}`;
}

function topByAsn(context: ShellContext, commerce: Commerce): ShellResult {
  const networks = sourcesByAsn(commerce, context.cluster.t);
  const total = networks.reduce((sum, network) => sum + network.requestsPerMinute, 0);
  const rows = networks.map((network) => [
    `AS${network.asn}`,
    network.network,
    SOURCE_TYPES[network.kind],
    count(network.ips),
    count(network.requestsPerMinute),
    percent(total > 0 ? network.requestsPerMinute / total : 0),
    network.prefixes.join(" "),
  ]);
  return {
    output: [
      ...out(`Top source networks · ${pathsLabel(commerce)} · last 5 min`),
      ...out(...table([["ASN", "NETWORK", "TYPE", "IPS", "REQ/MIN", "SHARE", "PREFIXES"], ...rows])),
      ...dim(`${count(distinctSourceIps(commerce))} distinct source IPs across ${networks.length} networks`),
    ],
  };
}

function top(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const { value: by, rest } = takeFlag(args, "--by");
  if (by === "asn") return topByAsn(context, commerce);
  if (by !== undefined && by !== "ip") return { output: err(`waf: error: cannot rank by "${by}" (ip, asn)`) };
  const limit = Number(rest[0] ?? 15);
  if (!Number.isInteger(limit) || limit < 1) return { output: err("usage: waf top [N] [--by ip|asn]") };
  const { t } = context.cluster;
  const rows = topSources(commerce, t, Math.min(limit, 100)).map((source) => [
    String(source.rank),
    source.ip,
    count(source.requestsPerMinute),
    String(source.asn),
    source.network,
    SOURCE_TYPES[source.kind],
  ]);
  return {
    output: [
      ...out(`Top source IPs · ${pathsLabel(commerce)} · last 5 min`),
      ...out(...table([["RANK", "IP", "REQ/MIN", "ASN", "NETWORK", "TYPE"], ...rows])),
      ...dim(
        `${count(distinctSourceIps(commerce))} distinct source IPs · top 100 carry ${percent(topRequestShare(commerce, t, 100))} of requests · top 500 carry ${percent(topRequestShare(commerce, t, 500))}`,
      ),
    ],
  };
}

function created(context: ShellContext, rule: Omit<WafRule, "id" | "createdAt">, commerce: Commerce): ShellResult {
  const id = wafRuleId(commerce);
  const { attack } = commerce;
  const attackPreview =
    attack && rule.attackShare !== undefined
      ? ` and ${percent(rule.attackShare)} of the ${attack.label} on POST ${attack.path} (${count(rule.attackShare * attackRequestsPerSecond(attack, context.cluster.t) * WINDOW_SECONDS)} requests)`
      : "";
  return applied("waf", addWafRule(context.cluster, rule), () => [
    ...out(`rule ${id} created (${rule.action}): ${rule.expression}`),
    ...dim(
      `Preview against the last 5 min: would have matched ${percent(rule.customerShare)} of POST /checkout (${count(rule.customerShare * commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS)} requests)${attackPreview}. Live at the edge within ~5s.`,
    ),
  ]);
}

function block(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const { value: topCount, rest } = takeFlag(args, "--top");
  const createdBy = operatorName(context.role);
  const paths = protectedPaths(commerce);
  if (topCount !== undefined) {
    const n = Number(topCount);
    if (!Number.isInteger(n) || n < 1) return { output: err("waf: error: --top needs a positive integer") };
    return created(context, { action: "block", expression: `ip.src in $checkout_top${n} and ${paths}`, createdBy, ...topReach(commerce, context.cluster.t, n) }, commerce);
  }
  const target = rest[0];
  const cidr = target ? parseCidr(target) : null;
  if (!target || !cidr) return { output: err("usage: waf block <ip|cidr> | waf block --top N") };
  const expression = cidr.bits === 32 ? `ip.src eq ${target.split("/")[0]} and ${paths}` : `ip.src in {${target}} and ${paths}`;
  return created(context, { action: "block", expression, createdBy, ...cidrReach(commerce, cidr) }, commerce);
}

function rateLimit(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const match = /^(\d+)\/(10s|1m|10m|1h)$/.exec(args[0] ?? "");
  if (!match) return { output: err("usage: waf ratelimit <requests>/<10s|1m|10m|1h>   e.g. waf ratelimit 20/1m") };
  const [, requests, period] = match;
  const perMinute = (Number(requests) * 60) / PERIOD_SECONDS[period];
  return created(
    context,
    {
      action: "rate_limit",
      expression: `${protectedPaths(commerce)} (${requests}/${period} per ip.src)`,
      createdBy: operatorName(context.role),
      ...rateLimitReach(commerce, context.cluster.t, perMinute),
    },
    commerce,
  );
}

function remove(args: readonly string[], context: ShellContext): ShellResult {
  const [id] = args;
  if (!id) return { output: err("usage: waf delete <rule-id>") };
  return applied("waf", deleteWafRule(context.cluster, id), () => out(`rule ${id} deleted`));
}

export const waf = commerceCommand({
  name: "waf",
  usage: "waf rules | top [N] [--by asn] | block <ip|cidr> | block --top N | ratelimit <n>/<period> | delete <rule-id>",
  summary: "Edge WAF: rules, top talkers, blocks and rate limits",
  roles: ["security"],
  refuse: (_args, { role }) => ssoRefusal("waf", "waf-admins", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case undefined:
      case "rules":
        return rules(context, commerce);
      case "top":
        return top(rest, context, commerce);
      case "block":
        return block(rest, context, commerce);
      case "ratelimit":
      case "rate-limit":
        return rateLimit(rest, context, commerce);
      case "delete":
      case "rm":
        return remove(rest, context);
      default:
        return { output: err(`waf: unknown command "${sub}"`, "Commands: rules, top, block, ratelimit, delete") };
    }
  },
  complete(args, _partial, context, commerce) {
    if (args.length === 0) return ["rules", "top", "block", "ratelimit", "delete"];
    if (args.length === 1 && (args[0] === "delete" || args[0] === "rm")) return commerce.wafRules.map((rule) => rule.id);
    if (args.length === 1 && args[0] === "block") return ["--top", ...topSources(commerce, context.cluster.t, 5).map((source) => source.ip)];
    if (args.length === 1 && args[0] === "ratelimit") return ["20/1m", "60/1m", "600/1m"];
    if (args[0] === "top") return args.at(-1) === "--by" ? ["ip", "asn"] : ["--by"];
    return [];
  },
});
