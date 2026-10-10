import { addWafRule, deleteWafRule } from "../../sim/commerce-actions.ts";
import type { Commerce, WafRule } from "../../sim/commerce.ts";
import { cidrCustomerShare, DISTINCT_SOURCE_IPS, parseCidr, rateLimitCustomerShare, topTalkers, topTalkerShare, wafRuleId } from "../../sim/edge.ts";
import { applied, commerceCommand, count, percent, stamp, WINDOW_SECONDS } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { dim, err, out, table, type ShellContext, type ShellResult } from "../types.ts";

const CHECKOUT_PATH = 'http.request.uri.path eq "/checkout"';
const PERIOD_SECONDS: Record<string, number> = { "10s": 10, "1m": 60, "10m": 600, "1h": 3600 };

function matchedPerWindow(rule: WafRule, commerce: Commerce): string {
  if (rule.expression.includes('"/checkout"')) return count(rule.customerShare * commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS);
  // Rules on other paths still see their usual background hits.
  let hash = 0;
  for (const char of rule.id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return count(20 + (hash % 180));
}

function rules(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = commerce.wafRules.map((rule) => [rule.id, rule.action, rule.expression, stamp(context, rule.createdAt), rule.createdBy, matchedPerWindow(rule, commerce)]);
  return { output: out(...table([["ID", "ACTION", "EXPRESSION", "CREATED", "BY", "MATCHED/5M"], ...rows])) };
}

function top(args: readonly string[], commerce: Commerce): ShellResult {
  const limit = Number(args[0] ?? 15);
  if (!Number.isInteger(limit) || limit < 1) return { output: err("usage: waf top [N]") };
  const perMinute = commerce.pulse.checkoutAttemptsPerSecond * 60;
  const rows = topTalkers(Math.min(limit, 100)).map((talker) => [
    String(talker.rank),
    talker.ip,
    count(perMinute * talker.customerShare),
    String(talker.asn),
    talker.network,
    talker.kind === "mobile" ? "mobile carrier (CGNAT)" : "residential ISP",
  ]);
  return {
    output: [
      ...out("Top source IPs · POST /checkout · last 5 min"),
      ...out(...table([["RANK", "IP", "REQ/MIN", "ASN", "NETWORK", "TYPE"], ...rows])),
      ...dim(`${count(DISTINCT_SOURCE_IPS)} distinct source IPs · top 100 carry ${percent(topTalkerShare(100))} of requests · top 500 carry ${percent(topTalkerShare(500))}`),
    ],
  };
}

function created(context: ShellContext, rule: Omit<WafRule, "id" | "createdAt">, commerce: Commerce): ShellResult {
  const id = wafRuleId(commerce);
  return applied("waf", addWafRule(context.cluster, rule), () => [
    ...out(`rule ${id} created (${rule.action}): ${rule.expression}`),
    ...dim(`Preview against the last 5 min: would have matched ${percent(rule.customerShare)} of POST /checkout (${count(rule.customerShare * commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS)} requests). Live at the edge within ~5s.`),
  ]);
}

function block(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const { value: topCount, rest } = takeFlag(args, "--top");
  const createdBy = operatorName(context.role);
  if (topCount !== undefined) {
    const n = Number(topCount);
    if (!Number.isInteger(n) || n < 1) return { output: err("waf: error: --top needs a positive integer") };
    return created(context, { action: "block", expression: `ip.src in $checkout_top${n} and ${CHECKOUT_PATH}`, createdBy, customerShare: topTalkerShare(n) }, commerce);
  }
  const target = rest[0];
  const cidr = target ? parseCidr(target) : null;
  if (!target || !cidr) return { output: err("usage: waf block <ip|cidr> | waf block --top N") };
  const expression = cidr.bits === 32 ? `ip.src eq ${target.split("/")[0]} and ${CHECKOUT_PATH}` : `ip.src in {${target}} and ${CHECKOUT_PATH}`;
  return created(context, { action: "block", expression, createdBy, customerShare: cidrCustomerShare(cidr) }, commerce);
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
      expression: `${CHECKOUT_PATH} (${requests}/${period} per ip.src)`,
      createdBy: operatorName(context.role),
      customerShare: rateLimitCustomerShare(perMinute, commerce.pulse.checkoutAttemptsPerSecond),
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
  usage: "waf rules | top [N] | block <ip|cidr> | block --top N | ratelimit <n>/<period> | delete <rule-id>",
  summary: "Edge WAF: rules, top talkers, blocks and rate limits",
  roles: ["security"],
  refuse: (_args, { role }) => ssoRefusal("waf", "waf-admins", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case undefined:
      case "rules":
        return rules(context, commerce);
      case "top":
        return top(rest, commerce);
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
  complete(args, _partial, _context, commerce) {
    if (args.length === 0) return ["rules", "top", "block", "ratelimit", "delete"];
    if (args.length === 1 && (args[0] === "delete" || args[0] === "rm")) return commerce.wafRules.map((rule) => rule.id);
    if (args.length === 1 && args[0] === "block") return ["--top", ...topTalkers(5).map((talker) => talker.ip)];
    if (args.length === 1 && args[0] === "ratelimit") return ["20/1m", "60/1m", "600/1m"];
    return [];
  },
});
