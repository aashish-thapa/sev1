import { clockAt, type Scenario } from "../../scenario.ts";
import { deletePod, findDeployment, rolloutRestart, rolloutUndo, scale, type ActionResult } from "../../sim/actions.ts";
import { currentTemplateHash, isLive, isServing, revisionOf, type ClusterState, type Deployment, type LogEntry, type Pod } from "../../sim/model.ts";
import { operatorEmail } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { age, dim, err, out, table, type Command, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

type Subcommand = (args: readonly string[], context: ShellContext) => ShellResult;

const NAMESPACE = "default";
const IMAGE_REGISTRY = "registry.internal";

const POD_WORDS = ["po", "pod", "pods"];
const DEPLOY_WORDS = ["deploy", "deployment", "deployments"];
const EVENT_WORDS = ["ev", "event", "events"];
const JOB_WORDS = ["job", "jobs"];

function allPods(cluster: ClusterState): { pod: Pod; deployment: Deployment }[] {
  return cluster.deployments.flatMap((deployment) => deployment.pods.map((pod) => ({ pod, deployment })));
}

function findPod(cluster: ClusterState, name: string) {
  return allPods(cluster).find((entry) => entry.pod.name === name);
}

/** Accepts `deployment/x`, `deploy/x`, or `deployment x`. */
function deploymentTarget(args: readonly string[]): string | undefined {
  const [first, second] = args;
  if (!first) return undefined;
  const slash = first.split("/");
  if (slash.length === 2 && DEPLOY_WORDS.includes(slash[0])) return slash[1];
  if (DEPLOY_WORDS.includes(first)) return second;
  return undefined;
}

function fromAction(result: ActionResult): ShellResult {
  return result.ok ? { output: out(...result.output), cluster: result.state } : { output: err(...result.output) };
}

function podStatus(pod: Pod): { ready: string; status: string } {
  switch (pod.phase) {
    case "Running":
      return { ready: isServing(pod) ? "1/1" : "0/1", status: "Running" };
    case "Starting":
      return { ready: "0/1", status: "Running" };
    case "CrashLoopBackOff":
      return { ready: "0/1", status: "CrashLoopBackOff" };
    case "Terminating":
      return { ready: "1/1", status: "Terminating" };
  }
}

function restartsLabel(pod: Pod, cluster: ClusterState): string {
  return pod.restarts === 0 ? "0" : `${pod.restarts} (${age(Math.min(cluster.t - pod.startedAt, 40))} ago)`;
}

const get: Subcommand = (args, context) => {
  const { cluster } = context;
  const { value: namespace, rest } = takeFlag(args, "-n", "--namespace");
  const [resource, name] = rest.filter((arg) => !arg.startsWith("-"));
  if (!resource) return { output: err("You must specify the type of resource to get. Use \"kubectl api-resources\" for a complete list of supported resources.") };
  if (namespace && namespace !== NAMESPACE) return { output: out(`No resources found in ${namespace} namespace.`) };

  if (POD_WORDS.includes(resource)) {
    const pods = allPods(cluster).filter(({ pod }) => !name || pod.name === name);
    if (name && pods.length === 0) return { output: err(`Error from server (NotFound): pods "${name}" not found`) };
    if (pods.length === 0) return { output: out(`No resources found in ${NAMESPACE} namespace.`) };
    const rows = pods.map(({ pod }) => {
      const status = podStatus(pod);
      return [pod.name, status.ready, status.status, restartsLabel(pod, cluster), age(cluster.t - pod.startedAt)];
    });
    return { output: out(...table([["NAME", "READY", "STATUS", "RESTARTS", "AGE"], ...rows])) };
  }
  if (DEPLOY_WORDS.includes(resource)) {
    const rows = cluster.deployments.map((deployment) => {
      const hash = currentTemplateHash(deployment);
      const live = deployment.pods.filter(isLive);
      const ready = live.filter(isServing).length;
      const upToDate = live.filter((pod) => pod.templateHash === hash).length;
      return [deployment.name, `${ready}/${deployment.replicas}`, String(upToDate), String(ready), "412d"];
    });
    return { output: out(...table([["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"], ...rows])) };
  }
  if (EVENT_WORDS.includes(resource)) return events([], context);
  if (JOB_WORDS.includes(resource)) {
    const jobs = cluster.jobs ?? [];
    if (jobs.length === 0) return { output: out(`No resources found in ${NAMESPACE} namespace.`) };
    const rows = jobs.map((job) => [job.name, job.status, job.status === "Complete" ? "1/1" : "0/1", age(job.durationSeconds), age(cluster.t - job.finishedAt + job.durationSeconds)]);
    return { output: out(...table([["NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE"], ...rows])) };
  }
  return { output: err(`error: the server doesn't have a resource type "${resource}"`) };
};

const events: Subcommand = (_args, { cluster }) => {
  const recent = cluster.events.slice(-14);
  if (recent.length === 0) return { output: out(`No resources found in ${NAMESPACE} namespace.`) };
  const rows = recent.map((event) => [age(cluster.t - event.t), event.type, event.reason, event.object, event.message]);
  return { output: out(...table([["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], ...rows])) };
};

const describe: Subcommand = (args, context) => {
  const { cluster } = context;
  const [resource, nameArg] = args.filter((arg) => !arg.startsWith("-"));
  const [kind, slashName] = (resource ?? "").split("/");
  const name = slashName ?? nameArg;
  if (POD_WORDS.includes(kind) && name) {
    const found = findPod(cluster, name);
    if (!found) return { output: err(`Error from server (NotFound): pods "${name}" not found`) };
    const { pod, deployment } = found;
    const revision = revisionOf(deployment, pod.revision);
    const podEvents = cluster.events.filter((event) => event.object === `pod/${pod.name}`).slice(-6);
    return {
      output: out(
        `Name:             ${pod.name}`,
        `Namespace:        ${NAMESPACE}`,
        `Labels:           app=${deployment.name}`,
        `                  pod-template-hash=${pod.templateHash}`,
        `Status:           ${podStatus(pod).status}`,
        "Containers:",
        `  ${deployment.name}:`,
        `    Image:          ${IMAGE_REGISTRY}/${deployment.name}:${revision.tag}`,
        `    State:          ${pod.phase === "CrashLoopBackOff" ? "Waiting" : "Running"}`,
        ...(pod.phase === "CrashLoopBackOff" ? ["      Reason:       CrashLoopBackOff"] : []),
        ...(pod.lastTermination
          ? ["    Last State:     Terminated", `      Reason:       ${pod.lastTermination.reason}`, `      Exit Code:    ${pod.lastTermination.exitCode}`]
          : []),
        `    Ready:          ${podStatus(pod).ready === "1/1" ? "True" : "False"}`,
        `    Restart Count:  ${pod.restarts}`,
        "    Limits:",
        "      cpu:     1",
        "      memory:  1Gi",
        "    Readiness:      http-get http://:8080/healthz delay=10s timeout=1s period=10s #success=1 #failure=3",
        "    Environment:",
        `      SPRING_DATASOURCE_URL:            jdbc:postgresql://${cluster.database.host}:5432/orders`,
        `      SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE:  ${deployment.poolSize}`,
        "Events:",
        ...(podEvents.length === 0
          ? ["  <none>"]
          : table([
              ["  Type", "Reason", "Age", "From", "Message"],
              ["  ----", "------", "----", "----", "-------"],
              ...podEvents.map((event) => [`  ${event.type}`, event.reason, age(cluster.t - event.t), event.reason === "Scheduled" ? "default-scheduler" : "kubelet", event.message]),
            ])),
      ),
    };
  }
  const deploymentName = deploymentTarget(args);
  if (deploymentName) {
    const deployment = findDeployment(cluster, deploymentName);
    if (!deployment) return { output: err(`Error from server (NotFound): deployments.apps "${deploymentName}" not found`) };
    const revision = revisionOf(deployment, deployment.revision);
    const live = deployment.pods.filter(isLive);
    return {
      output: out(
        `Name:                   ${deployment.name}`,
        `Namespace:              ${NAMESPACE}`,
        `Annotations:            deployment.kubernetes.io/revision: ${deployment.revision}`,
        `                        kubernetes.io/change-cause: ${revision.changeCause}`,
        `Replicas:               ${deployment.replicas} desired | ${live.filter((pod) => pod.templateHash === currentTemplateHash(deployment)).length} updated | ${live.length} total | ${live.filter(isServing).length} available`,
        "StrategyType:           RollingUpdate",
        "RollingUpdateStrategy:  0 max unavailable, 1 max surge",
        "Pod Template:",
        `  Image:  ${IMAGE_REGISTRY}/${deployment.name}:${revision.tag}`,
      ),
    };
  }
  return { output: err(`error: you must specify the type of resource to describe`) };
};

const logs: Subcommand = (args, { cluster, scenario }) => {
  const { value: tail, rest } = takeFlag(args, "--tail");
  const target = rest.find((arg) => !arg.startsWith("-"));
  if (!target) return { output: err("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.") };
  const [kind, jobName] = target.split("/");
  if (jobName !== undefined && JOB_WORDS.includes(kind)) {
    if (!cluster.jobs?.some((job) => job.name === jobName)) return { output: err(`Error from server (NotFound): jobs.batch "${jobName}" not found`) };
    return { output: printLogs(cluster.logs[jobName] ?? [], tail, scenario) };
  }
  const deploymentName = deploymentTarget([target]);
  const podName = deploymentName
    ? findDeployment(cluster, deploymentName)?.pods.find(isServing)?.name
    : target.replace(/^pods?\//, "");
  if (!podName || !findPod(cluster, podName)) {
    return { output: err(`Error from server (NotFound): pods "${podName ?? target}" not found`) };
  }
  return { output: printLogs(cluster.logs[podName] ?? [], tail, scenario) };
};

function printLogs(entries: readonly LogEntry[], tail: string | undefined, scenario: Scenario): readonly OutputLine[] {
  const count = tail === undefined ? 20 : Number(tail);
  if (!Number.isInteger(count)) return err(`error: invalid argument "${tail}" for "--tail" flag`);
  const lines = entries.slice(count < 0 ? 0 : -count || undefined);
  if (lines.length === 0) return dim("(no log lines yet)");
  return lines.map((line, index) => ({
    text: `${clockAt(scenario, line.t, true, index)}  ${line.level.padEnd(5)} ${line.text}`,
    tone: line.level === "ERROR" || line.level === "FATAL" ? "err" : "out",
  }));
}

const top: Subcommand = (args, { cluster }) => {
  const [resource] = args;
  if (!resource || !POD_WORDS.includes(resource)) return { output: err('error: unknown command "top" resource; use "kubectl top pods"') };
  const rows = allPods(cluster)
    .filter(({ pod }) => pod.phase === "Running")
    .map(({ pod, deployment }) => {
      const starved = pod.leaked >= deployment.poolSize;
      const cpu = starved ? 9 + (pod.name.length % 7) : 170 + (pod.name.charCodeAt(pod.name.length - 1) % 60);
      return [pod.name, `${cpu}m`, `${612 + (pod.name.length % 40)}Mi`];
    });
  return { output: out(...table([["NAME", "CPU(cores)", "MEMORY(bytes)"], ...rows])) };
};

const ROLLOUT: Record<string, Subcommand> = {
  history: (args, { cluster }) => {
    const name = deploymentTarget(args);
    const deployment = name ? findDeployment(cluster, name) : undefined;
    if (!name || !deployment) return { output: err(`Error from server (NotFound): deployments.apps "${name ?? ""}" not found`) };
    const rows = [...deployment.revisions].sort((left, right) => left.number - right.number).map((revision) => [String(revision.number), revision.changeCause]);
    return { output: out(`deployment.apps/${deployment.name} `, ...table([["REVISION", "CHANGE-CAUSE"], ...rows]), "") };
  },
  undo: (args, { cluster }) => {
    const { value, rest } = takeFlag(args, "--to-revision");
    const name = deploymentTarget(rest);
    if (!name) return { output: err("error: required resource not specified") };
    return fromAction(rolloutUndo(cluster, name, value === undefined ? undefined : Number(value)));
  },
  restart: (args, { cluster }) => {
    const name = deploymentTarget(args);
    if (!name) return { output: err("error: required resource not specified") };
    return fromAction(rolloutRestart(cluster, name));
  },
  status: (args, { cluster }) => {
    const name = deploymentTarget(args);
    const deployment = name ? findDeployment(cluster, name) : undefined;
    if (!name || !deployment) return { output: err(`Error from server (NotFound): deployments.apps "${name ?? ""}" not found`) };
    const hash = currentTemplateHash(deployment);
    const live = deployment.pods.filter(isLive);
    const updatedReady = live.filter((pod) => pod.templateHash === hash && isServing(pod)).length;
    const done = updatedReady >= deployment.replicas && live.length === deployment.replicas;
    return {
      output: out(
        done
          ? `deployment "${name}" successfully rolled out`
          : `Waiting for deployment "${name}" rollout to finish: ${updatedReady} of ${deployment.replicas} updated replicas are available...`,
      ),
    };
  },
};

const rollout: Subcommand = ([action, ...rest], context) => {
  const handler = action ? ROLLOUT[action] : undefined;
  if (!handler) return { output: err(`error: unknown command "${action ?? ""}" for "kubectl rollout"`, "Available Commands: history, restart, status, undo") };
  return handler(rest, context);
};

const scaleCommand: Subcommand = (args, { cluster }) => {
  const { value, rest } = takeFlag(args, "--replicas");
  const name = deploymentTarget(rest);
  if (!name) return { output: err("error: required resource not specified") };
  if (value === undefined) return { output: err("error: required flag(s) \"replicas\" not set") };
  return fromAction(scale(cluster, name, Number(value)));
};

const deleteCommand: Subcommand = (args, { cluster }) => {
  const [resource, name] = args.filter((arg) => !arg.startsWith("-"));
  const [kind, slashName] = (resource ?? "").split("/");
  const podName = slashName ?? name;
  if (!POD_WORDS.includes(kind) || !podName) return { output: err("error: deleting anything but pods is disabled for the on-call role") };
  return fromAction(deletePod(cluster, podName));
};

const SUBCOMMANDS: Record<string, Subcommand> = {
  get,
  describe,
  logs,
  top,
  rollout,
  scale: scaleCommand,
  delete: deleteCommand,
  events,
};

/** The RBAC verb and resource each subcommand needs, for the Forbidden message a non-operator gets. */
const RBAC: Record<string, { verb: string; resource: string; group: string }> = {
  get: { verb: "list", resource: "pods", group: "" },
  describe: { verb: "get", resource: "pods", group: "" },
  logs: { verb: "get", resource: "pods/log", group: "" },
  top: { verb: "list", resource: "pods", group: "metrics.k8s.io" },
  rollout: { verb: "patch", resource: "deployments", group: "apps" },
  scale: { verb: "patch", resource: "deployments/scale", group: "apps" },
  delete: { verb: "delete", resource: "pods", group: "" },
  events: { verb: "list", resource: "events", group: "" },
};

export const kubectl: Command = {
  name: "kubectl",
  aliases: ["k"],
  roles: ["infrastructure"],
  refuse([sub], { role }) {
    const rule = RBAC[sub ?? ""] ?? RBAC.get;
    const kind = rule.resource.split("/")[0];
    const fullKind = rule.group ? `${kind}.${rule.group}` : kind;
    return err(
      `Error from server (Forbidden): ${fullKind} is forbidden: User "${operatorEmail(role)}" cannot ${rule.verb} resource "${rule.resource}" in API group "${rule.group}" in the namespace "${NAMESPACE}"`,
    );
  },
  usage: "kubectl get pods | logs <pod> | describe pod <pod> | top pods | rollout history|undo|restart|status deployment/<name> | scale deployment/<name> --replicas=N | delete pod <pod>",
  summary: "Inspect and operate the Kubernetes workloads",
  run([sub, ...rest], context) {
    const handler = sub ? SUBCOMMANDS[sub] : undefined;
    if (!handler) {
      return { output: sub ? err(`error: unknown command "${sub}" for "kubectl"`) : out(`kubectl controls the Kubernetes cluster manager.`, ``, `Commands: ${Object.keys(SUBCOMMANDS).join(", ")}`) };
    }
    return handler(rest, context);
  },
  complete(args, _partial, { cluster }) {
    const pods = allPods(cluster).filter(({ pod }) => isLive(pod)).map(({ pod }) => pod.name);
    const deployments = cluster.deployments.map((deployment) => `deployment/${deployment.name}`);
    if (args.length === 0) return Object.keys(SUBCOMMANDS);
    const [sub, second] = args;
    if (sub === "rollout" && args.length === 1) return Object.keys(ROLLOUT);
    if (sub === "rollout" || sub === "scale") return deployments;
    const jobs = (cluster.jobs ?? []).map((job) => `job/${job.name}`);
    if (sub === "get") return args.length === 1 ? ["pods", "deployments", "events", ...(jobs.length > 0 ? ["jobs"] : [])] : [];
    if (sub === "top") return args.length === 1 ? ["pods"] : [];
    if (sub === "logs") return [...pods, ...deployments, ...jobs];
    if (sub === "describe" || sub === "delete") return args.length === 1 ? ["pod", "deployment"] : second === "deployment" ? cluster.deployments.map((d) => d.name) : pods;
    return [];
  },
};
