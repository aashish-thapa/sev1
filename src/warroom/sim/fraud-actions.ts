import type { CommerceResult } from "./commerce-actions.ts";
import type { FraudScoring } from "./commerce.ts";
import type { ClusterState } from "./model.ts";

function withFraud(state: ClusterState, model: string, change: (fraud: FraudScoring) => FraudScoring | string): CommerceResult {
  const fraud = state.commerce?.fraud;
  if (!state.commerce || !fraud) return { ok: false, error: "no models or pipelines serve this incident" };
  if (fraud.model !== model) return { ok: false, error: `model "${model}" not found` };
  const next = change(fraud);
  return typeof next === "string" ? { ok: false, error: next } : { ok: true, state: { ...state, commerce: { ...state.commerce, fraud: next } } };
}

/** Serves `to`, or the version deployed just before the one serving now. */
export function rollbackModel(state: ClusterState, model: string, to?: string): CommerceResult {
  return withFraud(state, model, (fraud) => {
    const byDeploy = [...fraud.versions].sort((left, right) => left.deployedAt - right.deployedAt);
    const serving = byDeploy.findIndex((version) => version.version === fraud.active);
    const target = to === undefined ? byDeploy[serving - 1] : byDeploy.find((version) => version.version === to);
    if (!target) return to === undefined ? `${model} ${fraud.active} is the oldest version; nothing to roll back to` : `version "${to}" not found for ${model}`;
    if (target.version === fraud.active) return `${model} is already serving ${target.version}`;
    return { ...fraud, active: target.version };
  });
}

export function setThreshold(state: ClusterState, model: string, threshold: number): CommerceResult {
  return withFraud(state, model, (fraud) => {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return "threshold must be a number between 0 and 1";
    if (threshold === fraud.threshold) return `${model} threshold is already ${threshold}`;
    return { ...fraud, threshold };
  });
}

export function setMode(state: ClusterState, model: string, mode: FraudScoring["mode"]): CommerceResult {
  return withFraud(state, model, (fraud) => (fraud.mode === mode ? `${model} is already in ${mode} mode` : { ...fraud, mode }));
}

/** A manual DAG run rebuilds and materializes its features in about a minute. */
export const PIPELINE_RUN_SECONDS = 60;

/** Triggers a run of `dag`: every feature it builds refreshes, and goes fresh when the run finishes. */
export function runPipeline(state: ClusterState, dag: string): CommerceResult {
  const model = state.commerce?.fraud?.model ?? "";
  return withFraud(state, model, (fraud) => {
    const built = fraud.features.filter((feature) => feature.pipeline === dag);
    if (built.length === 0) return `DAG "${dag}" not found`;
    if (built.some((feature) => feature.refresh)) return `${dag} already has a run in progress`;
    const refresh = { startedAt: state.t, secondsLeft: PIPELINE_RUN_SECONDS };
    return { ...fraud, features: fraud.features.map((feature) => (feature.pipeline === dag ? { ...feature, refresh } : feature)) };
  });
}
