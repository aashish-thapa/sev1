import { clientDefects } from "../../sim/client-defects.ts";
import { mixAmplification, mixGiveUp, segmentStats, triggerShare, type SegmentStats } from "../../sim/clients.ts";
import { commerceDemand } from "../../sim/commerce-step.ts";
import { findPlatform, type Commerce } from "../../sim/commerce.ts";
import { blockedShare } from "../../sim/edge.ts";
import { rolloutLabel } from "../../sim/rollout.ts";
import { commerceCommand, count, percent, runEvidence, viewNames, WINDOW_SECONDS } from "../commerce-command.ts";
import { COMPANY_DOMAIN, ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

/** Chrome's console line for any response with an HTTP error status (Blink `FrameConsole::ReportResourceResponseReceived`). */
const CHROME_500 = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";

type WebView = {
  readonly segment: SegmentStats;
  /** Share of web sessions running this release. */
  readonly sessions: number;
  readonly taps: number;
  readonly posts: number;
  /** Share of this release's checkout requests checkout-api answers with a 500 because of a client defect. */
  readonly rejected: number;
  /** Share of the other checkout requests that time out on the way through checkout-api and the gateway. */
  readonly timedOut: number;
  readonly blocked: number;
  readonly giveUp: number;
  /** True when a service worker serves this release from its precache instead of the deployed one. */
  readonly isPrecached: boolean;
};

function webViews(context: ShellContext, commerce: Commerce): readonly WebView[] {
  const { t } = context.cluster;
  const web = findPlatform(commerce, "web");
  const failure = commerce.pulse.checkoutFailureRate;
  // Checkout failures include defect 500s; what's left of them is requests that ran out of time.
  const rejectedOverall = commerceDemand(context.cluster, commerce).rejectedCheckoutShare;
  const timedOut = rejectedOverall < 1 ? Math.max(0, (failure - rejectedOverall) / (1 - rejectedOverall)) : 0;
  const blocked = blockedShare(commerce.wafRules);
  return segmentStats(commerce, t)
    .filter((segment) => segment.platform === "web")
    .map((segment) => {
      const { rejectedShare: rejected } = clientDefects(commerce, segment, t);
      const attemptFailure = rejected + (1 - rejected) * timedOut;
      const taps = commerce.pulse.organicCheckoutsPerSecond * segment.share * WINDOW_SECONDS;
      return {
        segment,
        sessions: web ? segment.share / web.customerShare : 1,
        taps,
        posts: taps * mixAmplification(segment.mix, attemptFailure),
        rejected,
        timedOut,
        blocked,
        giveUp: mixGiveUp(segment.mix, attemptFailure),
        isPrecached: web?.rollout.kind === "service-worker" && segment.version === web.previous?.version,
      };
    });
}

function immediateWeight(segment: SegmentStats): number {
  return segment.mix.find((part) => part.policy === "immediate")?.weight ?? 0;
}

function overview(context: ShellContext, commerce: Commerce): ShellResult {
  const web = findPlatform(commerce, "web");
  const rows = webViews(context, commerce).map(({ segment, sessions, taps, posts, rejected, timedOut, blocked, giveUp }) => [
    segment.version,
    percent(sessions, 0),
    count(taps),
    count(posts),
    taps > 0 ? (posts / taps).toFixed(2) : "—",
    count(posts * (1 - blocked) * rejected),
    count(posts * (1 - blocked) * (1 - rejected) * timedOut),
    count(posts * blocked),
    count(taps * (1 - blocked) * (1 - giveUp)),
  ]);
  return {
    output: [
      ...out(`checkout-web · /checkout · last 5 min`),
      ...out(...table([["RELEASE", "SESSIONS", "PAY TAPS", "POST /checkout", "REQ/TAP", "HTTP 500", "TIMED OUT", "HTTP 403", "ORDERS OK"], ...rows])),
      ...(web ? dim(`Deploy: ${rolloutLabel(web)}`) : []),
      ...dim("Same hour last Saturday: REQ/TAP 1.00 · INP p75 168 ms · JS error rate 0.21%"),
    ],
  };
}

function errors(context: ShellContext, commerce: Commerce): ShellResult {
  const { t } = context.cluster;
  const messages = new Map<string, { count: number; level: string; text: string }>();
  const add = (amount: number, level: string, text: string) => {
    const key = `${level} ${text}`;
    messages.set(key, { count: (messages.get(key)?.count ?? 0) + amount, level, text });
  };
  for (const { segment, taps, posts, rejected, timedOut, blocked } of webViews(context, commerce)) {
    const retrying = immediateWeight(segment);
    const reached = 1 - blocked;
    const late = (1 - rejected) * timedOut;
    const timeout = `${segment.timeoutMs}ms`;
    add(posts * retrying * reached * late, "warn", `[checkout] POST /checkout timed out after ${timeout}, retrying (attempt n/4)`);
    add(taps * retrying * reached * late ** 4, "error", "[checkout] submit failed after 4 attempts: TimeoutError: signal timed out");
    add(taps * (1 - retrying) * reached * late, "error", `[checkout] POST /checkout timed out after ${timeout}; showing "Payment is taking longer than usual"`);
    add(posts * blocked, "error", "[checkout] POST /checkout 403 Forbidden — rendering generic error page");
    add(posts * reached * rejected, "error", CHROME_500);
    for (const defect of segment.defects) {
      const firing = defect.failShare * triggerShare(defect.trigger, commerce, t);
      add((defect.where === "server" ? posts * reached : taps) * firing, "error", defect.message);
    }
  }
  add(1_180 + (t % 97), "error", "ResizeObserver loop completed with undelivered notifications.");
  const rows = [...messages.values()]
    .filter((line) => line.count >= 1)
    .sort((left, right) => right.count - left.count)
    .map((line) => [count(line.count), line.level, line.text]);
  return { output: [...out("Top console messages · /checkout · last 5 min"), ...out(...table([["COUNT", "LEVEL", "MESSAGE"], ...rows]))] };
}

/** One sampled session's network waterfall for the Pay tap, from the release most sessions run. */
function session(context: ShellContext, commerce: Commerce): ShellResult {
  const view = webViews(context, commerce).reduce<WebView | undefined>((most, candidate) => (!most || candidate.sessions > most.sessions ? candidate : most), undefined);
  if (!view) return { output: err("rum: no web sessions in window") };
  const { segment, sessions, rejected, timedOut } = view;
  const isRetrying = immediateWeight(segment) >= 0.5;
  const isRejected = rejected >= 0.5;
  const isFailing = !isRejected && timedOut >= 0.5;
  const attempts = isRetrying && isFailing ? 4 : 1;
  const rows: string[][] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const start = (attempt * (segment.timeoutMs + 2)) / 1000;
    const status = isRejected ? "500" : isFailing ? "(canceled)" : "201";
    const duration = isFailing ? `${segment.timeoutMs}ms` : `${180 + (context.cluster.t % 60)}ms`;
    rows.push([String(attempt + 1), `+${start.toFixed(3)}s`, "POST", "/checkout", status, duration, isRetrying ? "—" : "idempotency-key: 6f1c…e2"]);
  }
  const notes: OutputLine[] = isRetrying
    ? dim(
        `${attempts > 1 ? "Retries fire 2 ms after each client timeout. " : ""}Request bodies are identical (cart c_51d0f2, same card token); no Idempotency-Key header is sent.`,
      )
    : dim(isRejected ? "checkout-api answered 500; the customer sees “Something went wrong”." : isFailing ? "No automatic retry; the customer sees the slow-payment message." : "Order confirmed on the first request.");
  const precache = view.isPrecached
    ? dim(`GET / 200 (ServiceWorker) · app.${segment.version}.js 200 (ServiceWorker) · cache workbox-precache-v2-https://www.${COMPANY_DOMAIN}/`)
    : [];
  return {
    output: [
      ...out(`session s_8f2c41 · Chrome 141 / macOS · release ${segment.version} (${percent(sessions, 0)} of web sessions) · sampled ${Math.max(1, context.cluster.t % 50)}s ago`),
      ...precache,
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
  run([sub = "overview"], context, commerce) {
    const scenarioView = runEvidence(context, "rum", sub);
    if (scenarioView) return scenarioView;
    const handler = SUBCOMMANDS[sub];
    return handler ? handler(context, commerce) : { output: err(`rum: unknown command "${sub}"`, `Commands: ${viewNames(context, "rum", Object.keys(SUBCOMMANDS)).join(", ")}`) };
  },
  complete: (args, _partial, context) => (args.length === 0 ? viewNames(context, "rum", Object.keys(SUBCOMMANDS)) : []),
});
