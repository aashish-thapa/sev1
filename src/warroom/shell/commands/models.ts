import type { Commerce, FraudScoring } from "../../sim/commerce.ts";
import { rollbackModel, setMode, setThreshold } from "../../sim/fraud-actions.ts";
import { FEATURE_MAX_AGE_SECONDS, fraudDeclines, isFeatureStale } from "../../sim/fraud.ts";
import { applied, commerceCommand, count, percent, runEvidence, stamp, viewNames, WINDOW_SECONDS } from "../commerce-command.ts";
import { ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { age, dim, err, out, table, type Command, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

const SUBCOMMANDS = ["list", "show", "rollback", "threshold", "mode", "features"];
const MODES: readonly FraudScoring["mode"][] = ["enforce", "fail-open"];

type FraudCommandSpec = Omit<Command, "run" | "complete" | "isAvailable"> & {
  run(args: readonly string[], context: ShellContext, fraud: FraudScoring, commerce: Commerce): ShellResult;
  complete?(args: readonly string[], context: ShellContext, fraud: FraudScoring): readonly string[];
};

/** A tool for the models and pipelines behind checkout; incidents without a fraud scorer don't install it. */
export function fraudCommand(spec: FraudCommandSpec): Command {
  const { run, complete, ...rest } = spec;
  return {
    ...commerceCommand({
      ...rest,
      run: (args, context, commerce) => (commerce.fraud ? run(args, context, commerce.fraud, commerce) : { output: err(`bash: ${spec.name}: command not found`) }),
      complete: (args, _partial, context, commerce) => (commerce.fraud && complete ? complete(args, context, commerce.fraud) : []),
    }),
    isAvailable: (context) => context.cluster.commerce?.fraud !== undefined,
  };
}

/** The last five minutes at today's per-second rates: customers scored and declined, fraud attempts and what got through. */
function window(context: ShellContext, commerce: Commerce) {
  const effect = fraudDeclines(commerce, context.cluster.t);
  const customers = commerce.pulse.organicCheckoutsPerSecond * WINDOW_SECONDS;
  const attempts = (commerce.fraud?.fraudAttemptsPerSecond ?? 0) * WINDOW_SECONDS;
  return {
    customers,
    declined: customers * effect.declinedCheckoutShare,
    share: effect.declinedCheckoutShare,
    attempts,
    approvedFraud: effect.gatewayCallsPerSecond * WINDOW_SECONDS,
  };
}

function unknownModel(name: string | undefined): ShellResult {
  return { output: err(name ? `models: error: model "${name}" not found (models list)` : "usage: models <command> <model>") };
}

function list(context: ShellContext, fraud: FraudScoring, commerce: Commerce): ShellResult {
  const live = window(context, commerce);
  return {
    output: [
      ...out(
        ...table([
          ["MODEL", "SERVING", "MODE", "THRESHOLD", "CUSTOMERS DECLINED (5m)", "ENDPOINT"],
          [fraud.model, fraud.active, fraud.mode, String(fraud.threshold), `${count(live.declined)} (${percent(live.share)})`, "POST /checkout"],
        ]),
      ),
      ...dim("models show <model> for its versions; models features <model> for its inputs"),
    ],
  };
}

function show(context: ShellContext, fraud: FraudScoring, commerce: Commerce): ShellResult {
  const live = window(context, commerce);
  const rows = [...fraud.versions]
    .sort((left, right) => right.deployedAt - left.deployedAt)
    .map((version) => {
      const isServing = version.version === fraud.active;
      return [
        isServing ? `${version.version} *` : version.version,
        stamp(context, version.deployedAt),
        isServing ? `${percent(live.share)} live` : `${percent(version.falseDeclineShare)} while serving`,
        percent(version.catchShare),
        version.note,
      ];
    });
  const decision =
    fraud.mode === "enforce" ? "enforce: a score at or above the threshold is declined (HTTP 402)" : "fail-open: every checkout is approved; scores are logged, never acted on";
  return {
    output: [
      ...out(`${fraud.model} · card-not-present fraud score on POST /checkout, 0 (safe) to 1 (fraud)`),
      ...out(`  serving     ${fraud.active}`, `  mode        ${decision}`, `  threshold   ${fraud.threshold} (tuned to ${fraud.tunedThreshold} on the holdout set)`, ""),
      ...out(...table([["VERSION", "DEPLOYED", "CUSTOMERS DECLINED", "HOLDOUT RECALL", "NOTE"], ...rows])),
      ...dim(
        `Last 5 min: ${count(live.customers)} customer checkouts scored, ${count(live.declined)} declined · ${count(live.attempts)} fraud attempts, ${count(live.approvedFraud)} approved.`,
      ),
    ],
  };
}

function features(context: ShellContext, fraud: FraudScoring): ShellResult {
  const { t } = context.cluster;
  const rows = fraud.features.map((feature) => {
    const status = feature.refresh
      ? `refreshing (${feature.refresh.secondsLeft} s left)`
      : isFeatureStale(feature, t)
        ? "STALE: served as default 0"
        : "fresh";
    return [feature.name, feature.pipeline, stamp(context, feature.lastSuccessAt), age(t - feature.lastSuccessAt), status];
  });
  return {
    output: [
      ...out(...table([["FEATURE", "PIPELINE", "LAST SUCCESS", "AGE", "STATUS"], ...rows])),
      ...dim(`Freshness guard: a feature older than ${age(FEATURE_MAX_AGE_SECONDS)} is served as its default, as for a brand-new customer.`),
    ],
  };
}

function rollback(args: readonly string[], context: ShellContext): ShellResult {
  const { value: to, rest } = takeFlag(args, "--to");
  const [model] = rest;
  if (!model) return { output: err("usage: models rollback <model> [--to <version>]") };
  const from = context.cluster.commerce?.fraud?.active;
  return applied("models", rollbackModel(context.cluster, model, to), (state) => {
    const fraud = state.commerce?.fraud;
    return [
      ...out(`${model}: rolled back ${from} → ${fraud?.active} (100% of scoring traffic)`),
      ...dim(`Threshold ${fraud?.threshold} and mode ${fraud?.mode} are serving config and stay as they were.`),
    ];
  });
}

function threshold(args: readonly string[], context: ShellContext): ShellResult {
  const [model, value] = args;
  if (!model || value === undefined) return { output: err("usage: models threshold <model> <0-1>") };
  const from = context.cluster.commerce?.fraud?.threshold;
  return applied("models", setThreshold(context.cluster, model, Number(value)), (state) => {
    const fraud = state.commerce?.fraud;
    return [...out(`${model}: threshold ${from} → ${fraud?.threshold}`), ...dim(`Tuned to ${fraud?.tunedThreshold}. Scores at or above the threshold are declined.`)];
  });
}

function mode(args: readonly string[], context: ShellContext): ShellResult {
  const [model, value] = args;
  if (!model || !value) return { output: err("usage: models mode <model> enforce|fail-open") };
  const chosen = MODES.find((candidate) => candidate === value);
  if (!chosen) return { output: err(`models: error: unknown mode "${value}"; use enforce or fail-open`) };
  const from = context.cluster.commerce?.fraud?.mode;
  return applied("models", setMode(context.cluster, model, chosen), (state): readonly OutputLine[] => [
    ...out(`${model}: ${from} → ${chosen}`),
    ...dim(chosen === "fail-open" ? "Every checkout is approved without a decision. Scores are still logged." : `Scores at or above ${state.commerce?.fraud?.threshold} are declined again.`),
  ]);
}

export const models = fraudCommand({
  name: "models",
  usage: "models list | show <model> | rollback <model> [--to <v>] | threshold <model> <x> | mode <model> enforce|fail-open | features <model>",
  summary: "Inspect and operate the models serving checkout",
  roles: ["data"],
  refuse: (_args, { role }) => ssoRefusal("models", "ml-platform", role),
  run([sub = "list", ...rest], context, fraud, commerce) {
    const scenarioView = runEvidence(context, "models", sub);
    if (scenarioView) return scenarioView;
    switch (sub) {
      case "list":
      case "ls":
        return list(context, fraud, commerce);
      case "show":
        return rest[0] === fraud.model ? show(context, fraud, commerce) : unknownModel(rest[0]);
      case "features":
        return rest[0] === fraud.model ? features(context, fraud) : unknownModel(rest[0]);
      case "rollback":
        return rollback(rest, context);
      case "threshold":
        return threshold(rest, context);
      case "mode":
        return mode(rest, context);
      default:
        return { output: err(`models: unknown command "${sub}"`, `Commands: ${viewNames(context, "models", SUBCOMMANDS).join(", ")}`) };
    }
  },
  complete(args, context, fraud) {
    if (args.length === 0) return viewNames(context, "models", SUBCOMMANDS);
    if (args.length === 1 && SUBCOMMANDS.slice(1).includes(args[0])) return [fraud.model];
    if (args.length === 2 && args[0] === "mode") return [...MODES];
    if (args[0] === "rollback" && args.at(-1) === "--to") return fraud.versions.map((version) => version.version);
    if (args.length === 2 && args[0] === "rollback") return ["--to"];
    return [];
  },
});
