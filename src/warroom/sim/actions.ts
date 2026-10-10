import { checkoutQuerySeconds, REBUILD_SECONDS } from "./database.ts";
import { holdsPool, isLive, TERMINATION_GRACE_SECONDS, type ClusterState, type Deployment } from "./model.ts";

export type ActionResult =
  | { readonly ok: true; readonly state: ClusterState; readonly output: readonly string[] }
  | { readonly ok: false; readonly output: readonly string[] };

export function findDeployment(state: ClusterState, name: string): Deployment | undefined {
  return state.deployments.find((deployment) => deployment.name === name);
}

function withDeployment(state: ClusterState, name: string, change: (deployment: Deployment) => Deployment): ClusterState {
  return { ...state, deployments: state.deployments.map((deployment) => (deployment.name === name ? change(deployment) : deployment)) };
}

function notFound(kind: string, name: string): ActionResult {
  return { ok: false, output: [`Error from server (NotFound): ${kind} "${name}" not found`] };
}

/** `kubectl rollout undo`: the target template is re-applied as a new, highest revision. */
export function rolloutUndo(state: ClusterState, name: string, toRevision?: number): ActionResult {
  const deployment = findDeployment(state, name);
  if (!deployment) return notFound("deployments.apps", name);
  const ordered = [...deployment.revisions].sort((left, right) => right.number - left.number);
  const target =
    toRevision === undefined
      ? ordered.find((revision) => revision.number !== deployment.revision)
      : deployment.revisions.find((revision) => revision.number === toRevision);
  if (!target) {
    return { ok: false, output: [toRevision === undefined ? `error: no rollout history found for deployment "${name}"` : `error: unable to find specified revision ${toRevision} in history`] };
  }
  const number = (ordered[0]?.number ?? 0) + 1;
  const next = withDeployment(state, name, (current) => ({
    ...current,
    revision: number,
    revisions: [...current.revisions.filter((revision) => revision.number !== target.number), { ...target, number }],
  }));
  return { ok: true, state: next, output: [`deployment.apps/${name} rolled back`] };
}

export function rolloutRestart(state: ClusterState, name: string): ActionResult {
  if (!findDeployment(state, name)) return notFound("deployments.apps", name);
  const next = withDeployment(state, name, (deployment) => ({ ...deployment, generation: deployment.generation + 1 }));
  return { ok: true, state: next, output: [`deployment.apps/${name} restarted`] };
}

export function scale(state: ClusterState, name: string, replicas: number): ActionResult {
  if (!findDeployment(state, name)) return notFound("deployments.apps", name);
  if (!Number.isInteger(replicas) || replicas < 0) {
    return { ok: false, output: ["error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0"] };
  }
  const next = withDeployment(state, name, (deployment) => ({ ...deployment, replicas }));
  return { ok: true, state: next, output: [`deployment.apps/${name} scaled`] };
}

export function deletePod(state: ClusterState, podName: string): ActionResult {
  const owner = state.deployments.find((deployment) => deployment.pods.some((pod) => pod.name === podName && isLive(pod)));
  if (!owner) return notFound("pods", podName);
  const next = withDeployment(state, owner.name, (deployment) => ({
    ...deployment,
    pods: deployment.pods.map((pod) =>
      pod.name === podName ? { ...pod, phase: "Terminating", phaseLeft: TERMINATION_GRACE_SECONDS } : pod,
    ),
  }));
  return { ok: true, state: next, output: [`pod "${podName}" deleted`] };
}

/**
 * `pg_terminate_backend` on idle sessions. Postgres drops them, but leaked
 * connections are still checked out inside the app, so the pool stays starved.
 */
export function terminateIdleSessions(state: ClusterState): ActionResult {
  const idle = idleSessionCount(state);
  const lines = [" pg_terminate_backend ", "----------------------", ...Array.from({ length: Math.min(idle, 3) }, () => " t"), ...(idle > 3 ? [" …"] : []), `(${idle} rows)`];
  return { ok: true, state: { ...state, sessionsTerminated: state.sessionsTerminated + idle }, output: lines };
}

/** Sessions Postgres reports as idle: every pooled connection not running a query right now. */
export function idleSessionCount(state: ClusterState): number {
  const pooled = state.deployments.reduce((sum, deployment) => sum + deployment.pods.filter(holdsPool).length * deployment.poolSize, 0);
  return Math.max(0, pooled - activeSessionCount(state));
}

export function activeSessionCount(state: ClusterState): number {
  const holdSeconds = state.traffic.connectionHoldSeconds + state.traffic.checkoutShare * checkoutQuerySeconds(state.database);
  const pooled = state.deployments.reduce((sum, deployment) => sum + deployment.pods.filter(holdsPool).length * deployment.poolSize, 0);
  return Math.max(1, Math.min(pooled, Math.round(state.traffic.requestsPerSecond * (1 - state.errorRate) * holdSeconds)));
}

/**
 * `REINDEX INDEX [CONCURRENTLY] name` on the hot index. CONCURRENTLY builds alongside live
 * traffic; without it Postgres locks the table against writes until the rebuild finishes.
 */
export function reindex(state: ClusterState, name: string, isConcurrent: boolean): ActionResult {
  const index = state.database.hotIndex;
  if (!index || index.name !== name) return { ok: false, output: [`ERROR:  relation "${name}" does not exist`] };
  if (index.rebuild) return { ok: false, output: ["ERROR:  canceling statement due to lock timeout", `CONTEXT:  REINDEX of "${name}" is already running`] };
  const rebuild = isConcurrent
    ? { secondsLeft: REBUILD_SECONDS.concurrent, isLocking: false }
    : { secondsLeft: REBUILD_SECONDS.locking, isLocking: true };
  return {
    ok: true,
    state: { ...state, database: { ...state.database, hotIndex: { ...index, rebuild } } },
    output: [isConcurrent ? "REINDEX (running concurrently; watch pg_stat_progress_create_index)" : "REINDEX (holding ShareLock on orders until it finishes)"],
  };
}
