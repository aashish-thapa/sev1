import { segmentStats } from "../../sim/clients.ts";
import { resolveAlert } from "../../sim/commerce-actions.ts";
import { isAlertOpen, type AlertDisposition, type Commerce, type SiemAlert } from "../../sim/commerce.ts";
import { DISTINCT_SOURCE_IPS } from "../../sim/edge.ts";
import { applied, commerceCommand, count, percent, runEvidence, stamp, viewNames, WINDOW_SECONDS } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { age, dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

const DISPOSITIONS: Record<AlertDisposition, string> = {
  benign: "benign true positive",
  "false-positive": "false positive",
  "true-positive": "true positive",
};

/** The sale roughly doubles a normal Saturday's checkout traffic. */
const SALE_OVER_BASELINE = 2;

function isDisposition(value: string): value is AlertDisposition {
  return value in DISPOSITIONS;
}

function findAlert(commerce: Commerce, id: string): SiemAlert | undefined {
  return commerce.alerts.find((alert) => alert.id.toLowerCase() === id.toLowerCase());
}

function containmentNote(alert: SiemAlert, context: ShellContext): string | null {
  if (!isAlertOpen(alert) || alert.autoContainAt === null) return null;
  const left = alert.autoContainAt - context.cluster.t;
  return `auto-contain → block top ${alert.containTopIps} source IPs on /checkout at ${stamp(context, alert.autoContainAt)} (in ${age(left)})`;
}

function alerts(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = [...commerce.alerts]
    .sort((left, right) => right.openedAt - left.openedAt)
    .map((alert) => [alert.id, alert.severity, alert.resolution ? `closed (${alert.resolution.disposition})` : "open", stamp(context, alert.openedAt), alert.title]);
  const pending = commerce.alerts.map((alert) => containmentNote(alert, context)).filter((note): note is string => note !== null);
  return { output: [...out(...table([["ID", "SEV", "STATUS", "OPENED", "TITLE"], ...rows])), ...dim(...pending.map((note) => `SOAR: ${note}`))] };
}

function show(id: string, context: ShellContext, commerce: Commerce): ShellResult {
  const alert = findAlert(commerce, id);
  if (!alert) return { output: err(`siem: alert ${id} not found`) };
  const lines = [
    `${alert.id} · ${alert.severity} · ${alert.resolution ? "closed" : "open"} · opened ${stamp(context, alert.openedAt)}`,
    `Title:     ${alert.title}`,
    `Rule:      ${alert.rule}`,
  ];
  if (alert.rule === "edge.checkout.distributed_post_burst") {
    const posts = commerce.pulse.checkoutAttemptsPerSecond * WINDOW_SECONDS;
    const baseline = (commerce.pulse.organicCheckoutsPerSecond / SALE_OVER_BASELINE) * WINDOW_SECONDS;
    lines.push(
      "           POST /checkout > 3× the 7-day baseline for this hour, from > 1,000 distinct source IPs, within 5 min",
      `Observed:  ${count(posts)} POST /checkout in the last 5 min (baseline ${count(baseline)}) from ${count(DISTINCT_SOURCE_IPS)} source IPs`,
      "Searches:  siem search auth-summary | checkout-sessions | client-mix | card-velocity",
    );
  }
  const soar = containmentNote(alert, context);
  if (soar) lines.push(`SOAR:      ${soar}`);
  if (alert.resolution) {
    lines.push(`Resolved:  ${DISPOSITIONS[alert.resolution.disposition]} by ${alert.resolution.by} at ${stamp(context, alert.resolution.at)} — ${alert.resolution.note}`);
  }
  return { output: out(...lines) };
}

function compare(rows: readonly (readonly string[])[]): OutputLine[] {
  return out(...table([["METRIC", "NOW", "7-DAY BASELINE"], ...rows]));
}

const SEARCHES: Record<string, (context: ShellContext, commerce: Commerce) => readonly OutputLine[]> = {
  "auth-summary": (context) => [
    ...out("Logins · last 15 min vs the same hour over the last 7 days"),
    ...compare([
      ["login attempts / min", count(1_190 + (context.cluster.t % 40)), "604"],
      ["login success ratio", "97.8%", "97.6%"],
      ["distinct usernames per source IP (p99)", "3", "3"],
      ["failed logins from top 500 IPs", "0.9%", "1.1%"],
      ["logins from hosting / VPN ASNs", "0.4%", "0.5%"],
    ]),
  ],
  "checkout-sessions": (context, commerce) => {
    const segments = segmentStats(commerce, context.cluster.t);
    const sessions = commerce.pulse.organicCheckoutsPerSecond * WINDOW_SECONDS;
    const failure = commerce.pulse.checkoutFailureRate;
    const repeating = segments.reduce((sum, segment) => sum + segment.share * Math.min(1, segment.amplification - 1) * (failure > 0 ? 1 : 0), 0);
    const gaps = [...new Set(segments.filter((segment) => segment.unsafeWeight > 0).map((segment) => segment.timeoutMs / 1000))].sort((left, right) => left - right);
    return [
      ...out("POST /checkout grouped by session · last 5 min"),
      ...out(
        ...table([
          ["METRIC", "VALUE"],
          ["sessions with a POST /checkout", count(sessions)],
          ["sessions with > 1 POST within 60 s", `${count(sessions * repeating)} (${percent(repeating)})`],
          ["gap between repeated POSTs (p50 / p90)", gaps.length > 0 ? `${gaps[0].toFixed(1)} s / ${(gaps.at(-1) ?? gaps[0]).toFixed(1)} s` : "—"],
          ["repeats with same cart_id and card fingerprint", repeating > 0 ? "99.7%" : "—"],
          ["account age of repeating sessions (median)", "2.6 years"],
          ["repeating sessions with a prior order", "81%"],
        ]),
      ),
    ];
  },
  "client-mix": (context, commerce) => {
    const rows = segmentStats(commerce, context.cluster.t).map((segment) => {
      const sessions = commerce.pulse.organicCheckoutsPerSecond * segment.share * WINDOW_SECONDS;
      return [`${segment.platform} ${segment.version}`, count(sessions * segment.amplification), count(sessions), segment.amplification.toFixed(2)];
    });
    return [
      ...out("POST /checkout by client (User-Agent) · last 5 min"),
      ...out(...table([["CLIENT", "REQUESTS", "SESSIONS", "REQ/SESSION"], ...rows, ["other (curl, headless, unknown)", "41", "38", "1.08"]])),
    ];
  },
  "card-velocity": () => [
    ...out("Card-testing signals · POST /checkout · last 5 min"),
    ...compare([
      ["distinct cards per session (p99)", "1", "1"],
      ["authorisations under $2.00", "0.0%", "0.1%"],
      ["issuer decline rate", "2.4%", "2.3%"],
      ["CVV mismatch rate", "0.3%", "0.3%"],
      ["top BIN share", "3.1%", "3.0%"],
    ]),
  ],
};

function search(name: string | undefined, context: ShellContext, commerce: Commerce): ShellResult {
  const scenarioView = runEvidence(context, "siem", name);
  if (scenarioView) return scenarioView;
  const run = name ? SEARCHES[name] : undefined;
  if (!run) return { output: err(`siem: unknown saved search "${name ?? ""}"`, `Saved searches: ${viewNames(context, "siem", Object.keys(SEARCHES)).join(", ")}`) };
  return { output: run(context, commerce) };
}

function resolve(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const { value: disposition, rest: afterDisposition } = takeFlag(args, "--disposition", "-d");
  const { value: note, rest } = takeFlag(afterDisposition, "--note", "-m");
  const [id] = rest;
  if (!id || !disposition) return { output: err('usage: siem resolve <alert-id> --disposition benign|false-positive|true-positive [--note "why"]') };
  if (!isDisposition(disposition)) return { output: err(`siem: invalid disposition "${disposition}" (benign, false-positive, true-positive)`) };
  const alert = findAlert(commerce, id);
  const result = resolveAlert(context.cluster, alert?.id ?? id, disposition, note ?? "no note", operatorName(context.role));
  return applied("siem", result, (state) => {
    const lines = out(`${alert?.id ?? id} closed as ${DISPOSITIONS[disposition]} by ${operatorName(context.role)}.`);
    if (disposition === "true-positive") {
      const rule = state.commerce?.wafRules.at(-1);
      return [...lines, ...out(`SOAR playbook auto-contain ran: rule ${rule?.id ?? "?"} blocks the top ${alert?.containTopIps ?? 0} source IPs on /checkout.`)];
    }
    const leftover = state.commerce?.wafRules.filter((rule) => alert && rule.createdBy.includes(alert.id)) ?? [];
    return [
      ...lines,
      ...(alert?.autoContainAt !== null ? dim("SOAR auto-containment cancelled.") : []),
      ...leftover.flatMap((rule) => dim(`Containment rule ${rule.id} created by SOAR is still live at the edge (waf rules).`)),
    ];
  });
}

export const siem = commerceCommand({
  name: "siem",
  usage: 'siem alerts | show <id> | search <saved-search> | resolve <id> --disposition benign|false-positive|true-positive [--note "why"]',
  summary: "SIEM alerts, saved searches and triage",
  roles: ["security"],
  refuse: (_args, { role }) => ssoRefusal("siem", "sec-soc", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case undefined:
      case "alerts":
        return alerts(context, commerce);
      case "show":
        return rest[0] ? show(rest[0], context, commerce) : { output: err("usage: siem show <alert-id>") };
      case "search":
        return search(rest[0], context, commerce);
      case "resolve":
      case "close":
        return resolve(rest, context, commerce);
      default:
        return { output: err(`siem: unknown command "${sub}"`, "Commands: alerts, show, search, resolve") };
    }
  },
  complete(args, _partial, context, commerce) {
    if (args.length === 0) return ["alerts", "show", "search", "resolve"];
    if (args.length === 1 && (args[0] === "show" || args[0] === "resolve")) return commerce.alerts.map((alert) => alert.id);
    if (args.length === 1 && args[0] === "search") return viewNames(context, "siem", Object.keys(SEARCHES));
    if (args[0] === "resolve" && args.at(-1) === "--disposition") return Object.keys(DISPOSITIONS);
    if (args[0] === "resolve" && args.length === 2) return ["--disposition"];
    return [];
  },
});
