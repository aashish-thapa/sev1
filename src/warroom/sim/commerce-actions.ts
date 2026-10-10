import {
  configValue,
  findConfig,
  findFlag,
  findPlatform,
  isAlertOpen,
  isFlagOn,
  type AlertDisposition,
  type Commerce,
  type RefundBatch,
  type WafRule,
} from "./commerce.ts";
import { containmentRule, wafRuleId } from "./edge.ts";
import type { ClusterState } from "./model.ts";

export type CommerceResult = { readonly ok: true; readonly state: ClusterState } | { readonly ok: false; readonly error: string };

/** The warehouse reads payments through CDC; the newest captures are not queryable yet. */
export const WAREHOUSE_LAG_SECONDS = 45;

function withCommerce(state: ClusterState, change: (commerce: Commerce) => Commerce | string): CommerceResult {
  if (!state.commerce) return { ok: false, error: "no commerce services in this incident" };
  const next = change(state.commerce);
  return typeof next === "string" ? { ok: false, error: next } : { ok: true, state: { ...state, commerce: next } };
}

export function setFlag(state: ClusterState, key: string, enabled: boolean, by: string, note: string): CommerceResult {
  return withCommerce(state, (commerce) => {
    const flag = findFlag(commerce, key);
    if (!flag) return `flag "${key}" not found`;
    if (isFlagOn(flag) === enabled) return `flag "${key}" is already ${enabled ? "on" : "off"}`;
    const change = { at: state.t, by, from: !enabled, to: enabled, note };
    return { ...commerce, flags: commerce.flags.map((candidate) => (candidate.key === key ? { ...candidate, history: [...candidate.history, change] as const } : candidate)) };
  });
}

export function setRemoteConfig(state: ClusterState, key: string, value: string, by: string, note: string): CommerceResult {
  return withCommerce(state, (commerce) => {
    const entry = findConfig(commerce, key);
    if (!entry) return `key "${key}" not found`;
    if (entry.allowed && !entry.allowed.includes(value)) return `invalid value "${value}" for ${key}; allowed: ${entry.allowed.join(", ")}`;
    const current = configValue(entry);
    if (current === value) return `${key} is already "${value}"`;
    const change = { at: state.t, by, from: current, to: value, note };
    return {
      ...commerce,
      remoteConfig: commerce.remoteConfig.map((candidate) => (candidate.key === key ? { ...candidate, history: [...candidate.history, change] as const } : candidate)),
    };
  });
}

/** Pausing a phased release only stops automatic updates; installed apps keep the build they have. */
export function setReleasePaused(state: ClusterState, platformId: string, version: string, isPaused: boolean): CommerceResult {
  return withCommerce(state, (commerce) => {
    const platform = findPlatform(commerce, platformId);
    if (!platform) return `unknown platform "${platformId}"`;
    if (platform.current.version !== version) return `${platformId} ${version} is not the release in progress`;
    const { rollout } = platform;
    if (rollout.kind !== "phased") return `${platformId} ${version} is not in a phased release`;
    if (rollout.isPaused === isPaused) return `phased release of ${platformId} ${version} is already ${isPaused ? "paused" : "active"}`;
    return {
      ...commerce,
      platforms: commerce.platforms.map((candidate) => (candidate.id === platform.id ? { ...candidate, rollout: { ...rollout, isPaused } } : candidate)),
    };
  });
}

export function addWafRule(state: ClusterState, rule: Omit<WafRule, "id" | "createdAt">): CommerceResult {
  return withCommerce(state, (commerce) => ({
    ...commerce,
    wafRules: [...commerce.wafRules, { ...rule, id: wafRuleId(commerce), createdAt: state.t }],
    nextWafRuleNumber: commerce.nextWafRuleNumber + 1,
  }));
}

export function deleteWafRule(state: ClusterState, id: string): CommerceResult {
  return withCommerce(state, (commerce) => {
    if (!commerce.wafRules.some((rule) => rule.id === id)) return `rule ${id} not found`;
    return { ...commerce, wafRules: commerce.wafRules.filter((rule) => rule.id !== id) };
  });
}

/** A true-positive disposition runs the containment playbook right away instead of waiting for the timer. */
export function resolveAlert(state: ClusterState, id: string, disposition: AlertDisposition, note: string, by: string): CommerceResult {
  return withCommerce(state, (commerce) => {
    const alert = commerce.alerts.find((candidate) => candidate.id === id);
    if (!alert) return `alert ${id} not found`;
    if (!isAlertOpen(alert)) return `alert ${id} is already closed`;
    const resolved = { ...alert, autoContainAt: null, resolution: { disposition, at: state.t, by, note } };
    const alerts = commerce.alerts.map((candidate) => (candidate.id === id ? resolved : candidate));
    if (disposition !== "true-positive") return { ...commerce, alerts };
    return {
      ...commerce,
      alerts,
      wafRules: [...commerce.wafRules, containmentRule(commerce, alert, state.t)],
      nextWafRuleNumber: commerce.nextWafRuleNumber + 1,
    };
  });
}

/** Orphaned captures the warehouse can see right now. */
export function visibleOrphans(commerce: Commerce): number {
  const history = commerce.ledger.orphanHistory;
  return Math.floor(history.at(-1 - WAREHOUSE_LAG_SECONDS) ?? history[0] ?? 0);
}

export function pendingRefunds(commerce: Commerce): number {
  return Math.max(0, visibleOrphans(commerce) - commerce.ledger.refundedCaptures);
}

/** Queues refunds for every visible orphaned capture not already in a batch; refunds are keyed by charge id. */
export function submitRefunds(state: ClusterState, by: string): CommerceResult {
  return withCommerce(state, (commerce) => {
    const captures = pendingRefunds(commerce);
    if (captures === 0) return "nothing to refund: every orphaned capture visible in the warehouse is already in a batch";
    const { ledger } = commerce;
    const batch: RefundBatch = {
      id: `rb_${String(ledger.refundBatches.length + 1).padStart(3, "0")}`,
      at: state.t,
      by,
      captures,
      amountCents: captures * ledger.averageOrderCents,
    };
    return {
      ...commerce,
      ledger: { ...ledger, refundedCaptures: ledger.refundedCaptures + captures, refundBatches: [...ledger.refundBatches, batch] },
    };
  });
}
