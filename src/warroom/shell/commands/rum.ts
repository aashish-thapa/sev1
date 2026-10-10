import { segmentStats, type SegmentStats } from "../../sim/clients.ts";
import type { Commerce } from "../../sim/commerce.ts";
import { blockedShare } from "../../sim/edge.ts";
import { commerceCommand, count, WINDOW_SECONDS } from "../commerce-command.ts";
import { ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

type WebView = { readonly segment: SegmentStats; readonly taps: number; readonly posts: number; readonly failure: number; readonly blocked: number };

function webViews(context: ShellContext, commerce: Commerce): readonly WebView[] {
  const failure = commerce.pulse.checkoutFailureRate;
  const blocked = blockedShare(commerce.wafRules);
  return segmentStats(commerce, context.cluster.t)
    .filter((segment) => segment.platform === "web")
    .map((segment) => {
      const taps = commerce.pulse.organicCheckoutsPerSecond * segment.share * WINDOW_SECONDS;
      return { segment, taps, posts: taps * segment.amplification, failure, blocked };
    });
}

function immediateWeight(segment: SegmentStats): number {
  return segment.mix.find((part) => part.policy === "immediate")?.weight ?? 0;
}

function overview(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = webViews(context, commerce).map(({ segment, taps, posts, failure, blocked }) => [
    segment.version,
    count(taps),
    count(posts),
    segment.amplification.toFixed(2),
    count(posts * (1 - blocked) * failure),
    count(posts * blocked),
    count(taps * (1 - blocked) * (1 - segment.giveUp)),
  ]);
  return {
    output: [
      ...out(`checkout-web · /checkout · last 5 min · 100% of sessions`),
      ...out(...table([["RELEASE", "PAY TAPS", "POST /checkout", "REQ/TAP", "TIMED OUT", "HTTP 403", "ORDERS OK"], ...rows])),
      ...dim("Same hour last Saturday: REQ/TAP 1.00 · INP p75 168 ms · JS error rate 0.21%"),
    ],
  };
}

function errors(context: ShellContext, commerce: Commerce): ShellResult {
  const lines: { readonly count: number; readonly level: string; readonly text: string }[] = [];
  for (const { segment, taps, posts, failure, blocked } of webViews(context, commerce)) {
    const retrying = immediateWeight(segment);
    const reached = 1 - blocked;
    const timeout = `${segment.timeoutMs}ms`;
    lines.push(
      { count: posts * retrying * reached * failure, level: "warn", text: `[checkout] POST /checkout timed out after ${timeout}, retrying (attempt n/4)` },
      { count: taps * retrying * reached * failure ** 4, level: "error", text: "[checkout] submit failed after 4 attempts: TimeoutError: signal timed out" },
      { count: taps * (1 - retrying) * reached * failure, level: "error", text: `[checkout] POST /checkout timed out after ${timeout}; showing "Payment is taking longer than usual"` },
      { count: posts * blocked, level: "error", text: "[checkout] POST /checkout 403 Forbidden — rendering generic error page" },
      { count: 1_180 + (context.cluster.t % 97), level: "error", text: "ResizeObserver loop completed with undelivered notifications." },
    );
  }
  const rows = lines
    .filter((line) => line.count >= 1)
    .sort((left, right) => right.count - left.count)
    .map((line) => [count(line.count), line.level, line.text]);
  return { output: [...out("Top console messages · /checkout · last 5 min"), ...out(...table([["COUNT", "LEVEL", "MESSAGE"], ...rows]))] };
}

/** One sampled session's network waterfall for the Pay tap. */
function session(context: ShellContext, commerce: Commerce): ShellResult {
  const view = webViews(context, commerce)[0];
  if (!view) return { output: err("rum: no web sessions in window") };
  const { segment, failure } = view;
  const isRetrying = immediateWeight(segment) >= 0.5;
  const isFailing = failure >= 0.5;
  const attempts = isRetrying && isFailing ? 4 : 1;
  const rows: string[][] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const start = (attempt * (segment.timeoutMs + 2)) / 1000;
    const status = isFailing ? "(canceled)" : "201";
    const duration = isFailing ? `${segment.timeoutMs}ms` : `${180 + (context.cluster.t % 60)}ms`;
    rows.push([String(attempt + 1), `+${start.toFixed(3)}s`, "POST", "/checkout", status, duration, isRetrying ? "—" : "idempotency-key: 6f1c…e2"]);
  }
  const notes: OutputLine[] = isRetrying
    ? dim(
        `${attempts > 1 ? "Retries fire 2 ms after each client timeout. " : ""}Request bodies are identical (cart c_51d0f2, same card token); no Idempotency-Key header is sent.`,
      )
    : dim(isFailing ? "No automatic retry; the customer sees the slow-payment message." : "Order confirmed on the first request.");
  return {
    output: [
      ...out(`session s_8f2c41 · Chrome 141 / macOS · release ${segment.version} · sampled ${Math.max(1, context.cluster.t % 50)}s ago`),
      ...out(...table([["#", "START", "METHOD", "URL", "STATUS", "DURATION", "IDEMPOTENCY-KEY"], ...rows])),
      ...notes,
    ],
  };
}

const SUBCOMMANDS: Record<string, (context: ShellContext, commerce: Commerce) => ShellResult> = { overview, errors, session };

export const rum = commerceCommand({
  name: "rum",
  usage: "rum overview | errors | session",
  summary: "Real-user monitoring for checkout-web (last 5 min)",
  roles: ["frontend"],
  refuse: (_args, { role }) => ssoRefusal("rum", "eng-web", role),
  run([sub], context, commerce) {
    const handler = SUBCOMMANDS[sub ?? "overview"];
    return handler ? handler(context, commerce) : { output: err(`rum: unknown command "${sub}"`, `Commands: ${Object.keys(SUBCOMMANDS).join(", ")}`) };
  },
  complete: (args) => (args.length === 0 ? Object.keys(SUBCOMMANDS) : []),
});
