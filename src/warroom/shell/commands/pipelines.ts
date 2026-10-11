import type { FraudFeature, FraudScoring } from "../../sim/commerce.ts";
import { PIPELINE_RUN_SECONDS, runPipeline } from "../../sim/fraud-actions.ts";
import { isFeatureStale } from "../../sim/fraud.ts";
import { applied, stamp } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";
import { fraudCommand } from "./models.ts";

/** The day every incident happens on; Airflow stamps full datetimes, in UTC like the incident clock. */
const INCIDENT_DAY_MS = Date.UTC(2026, 9, 10);
const WORKER_HOST = "airflow-worker-0.airflow-worker.data.svc.cluster.local";

export type AirflowLevel = "INFO" | "WARNING" | "ERROR";

function instant(opensAtSecondOfDay: number, t: number): Date {
  return new Date(INCIDENT_DAY_MS + (opensAtSecondOfDay + t) * 1000 + ((((t * 337) % 1000) + 1000) % 1000));
}

/** Airflow 2.10's default task log line, `[%(asctime)s] {%(filename)s:%(lineno)d} %(levelname)s - %(message)s`, with its timezone-aware asctime. */
export function airflowLine(opensAtSecondOfDay: number, t: number, origin: string, level: AirflowLevel, message: string): string {
  return `[${instant(opensAtSecondOfDay, t).toISOString().replace("Z", "+0000")}] {${origin}} ${level} - ${message}`;
}

/** `strftime("%Y%m%dT%H%M%S")`, as Airflow prints execution, start and end dates when it marks a task. */
export function airflowCompact(opensAtSecondOfDay: number, t: number): string {
  return instant(opensAtSecondOfDay, t).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "");
}

/** A manual run's id, `manual__` and its logical date in ISO 8601 with microseconds. */
function manualRunId(opensAtSecondOfDay: number, t: number): string {
  const at = instant(opensAtSecondOfDay, t);
  const micros = String(at.getUTCMilliseconds() * 1000 + ((t * 71) % 1000)).padStart(6, "0");
  return `manual__${at.toISOString().slice(0, 19)}.${micros}+00:00`;
}

export function taskId(feature: FraudFeature): string {
  return `build_${feature.name}`;
}

type RunState = "running" | "failed" | "success";

function built(fraud: FraudScoring, dag: string): readonly FraudFeature[] {
  return fraud.features.filter((feature) => feature.pipeline === dag);
}

function dags(fraud: FraudScoring): readonly string[] {
  return [...new Set(fraud.features.map((feature) => feature.pipeline))];
}

function runState(features: readonly FraudFeature[], t: number): RunState {
  if (features.some((feature) => feature.refresh)) return "running";
  return features.some((feature) => isFeatureStale(feature, t)) ? "failed" : "success";
}

/**
 * When the run someone triggered during this incident started, if there was one. Incident time is
 * negative before the page, so a success at or after 0 came from a run started here.
 */
function manualRunStart(features: readonly FraudFeature[]): number | null {
  const running = features.find((feature) => feature.refresh);
  if (running?.refresh) return running.refresh.startedAt;
  const finished = Math.max(...features.map((feature) => feature.lastSuccessAt));
  return finished >= 0 ? finished - PIPELINE_RUN_SECONDS : null;
}

function list(context: ShellContext, fraud: FraudScoring): ShellResult {
  const rows = dags(fraud).map((dag) => {
    const features = built(fraud, dag);
    const lastSuccess = Math.max(...features.map((feature) => feature.lastSuccessAt));
    return [dag, features.map((feature) => feature.name).join(", "), stamp(context, lastSuccess), runState(features, context.cluster.t)];
  });
  return { output: [...out(...table([["DAG", "FEATURES", "LAST SUCCESS", "STATE"], ...rows])), ...dim("Airflow 2.10.5 · pipelines logs <dag> prints its latest run")] };
}

/** One task's log in a run started at `start`, as far as it has got by now. */
function taskLog(context: ShellContext, dag: string, feature: FraudFeature, runId: string, start: number, index: number): string[] {
  const opens = context.scenario.opensAtSecondOfDay;
  const line = (t: number, origin: string, message: string) => airflowLine(opens, t, origin, "INFO", message);
  const lines = [
    line(start + 2, "taskinstance.py:2867", "Starting attempt 1 of 3"),
    line(start + 2, "standard_task_runner.py:72", `Started process ${41_000 + ((start * 13 + index * 97) % 9000)} to run task`),
    line(start + 3, "task_command.py:467", `Running <TaskInstance: ${dag}.${taskId(feature)} ${runId} [running]> on host ${WORKER_HOST}`),
  ];
  if (feature.refresh) return lines;
  const end = feature.lastSuccessAt;
  return [
    ...lines,
    line(
      end,
      "taskinstance.py:353",
      `Marking task as SUCCESS. dag_id=${dag}, task_id=${taskId(feature)}, run_id=${runId}, execution_date=${airflowCompact(opens, start)}, start_date=${airflowCompact(opens, start + 2)}, end_date=${airflowCompact(opens, end)}`,
    ),
    line(end, "local_task_job_runner.py:266", "Task exited with return code 0"),
  ];
}

function logs(dag: string | undefined, context: ShellContext, fraud: FraudScoring): ShellResult {
  if (!dag) return { output: err("usage: pipelines logs <dag>") };
  const features = built(fraud, dag);
  if (features.length === 0) return { output: err(`pipelines: error: DAG "${dag}" not found (pipelines list)`) };
  const state = runState(features, context.cluster.t);
  const start = manualRunStart(features);
  if (start !== null) {
    const runId = manualRunId(context.scenario.opensAtSecondOfDay, start);
    return {
      output: [
        ...dim(`${dag} · ${runId} · ${state} · triggered at ${stamp(context, start)}`),
        ...features.flatMap((feature, index) => [...dim(`--- ${taskId(feature)} ---`), ...out(...taskLog(context, dag, feature, runId, start, index))]),
      ],
    };
  }
  if (state === "success") return { output: dim(`${dag}: last scheduled run succeeded; no failed tasks.`) };
  const kept = context.cluster.logs[dag] ?? [];
  if (kept.length === 0) return { output: dim(`${dag}: no task logs kept for its last run.`) };
  return {
    output: [
      ...dim(`${dag} · last scheduled run failed · log of its failed task, traceback trimmed to the frame that raised`),
      ...kept.flatMap((entry): OutputLine[] => (entry.level === "ERROR" ? err(...entry.text.split("\n")) : out(...entry.text.split("\n")))),
    ],
  };
}

function run(dag: string | undefined, context: ShellContext): ShellResult {
  if (!dag) return { output: err("usage: pipelines run <dag>") };
  return applied("pipelines", runPipeline(context.cluster, dag), (state) => {
    const tasks = state.commerce?.fraud?.features.filter((feature) => feature.pipeline === dag) ?? [];
    return [
      ...out(`Triggered ${dag}: ${manualRunId(context.scenario.opensAtSecondOfDay, state.t)} by ${operatorName(context.role)} (${tasks.length} task${tasks.length === 1 ? "" : "s"}).`),
      ...dim(`Its tasks rebuild and materialize ${tasks.map((feature) => feature.name).join(", ")}: about ${PIPELINE_RUN_SECONDS} s.`),
    ];
  });
}

export const pipelines = fraudCommand({
  name: "pipelines",
  usage: "pipelines list | logs <dag> | run <dag>",
  summary: "Airflow DAGs that build the model features",
  roles: ["data"],
  refuse: (_args, { role }) => ssoRefusal("pipelines", "data-eng", role),
  run([sub = "list", dag], context, fraud) {
    switch (sub) {
      case "list":
      case "ls":
        return list(context, fraud);
      case "logs":
        return logs(dag, context, fraud);
      case "run":
      case "trigger":
        return run(dag, context);
      default:
        return { output: err(`pipelines: unknown command "${sub}"`, "Commands: list, logs, run") };
    }
  },
  complete(args, _context, fraud) {
    if (args.length === 0) return ["list", "logs", "run"];
    if (args.length === 1 && (args[0] === "logs" || args[0] === "run")) return [...dags(fraud)];
    return [];
  },
});
