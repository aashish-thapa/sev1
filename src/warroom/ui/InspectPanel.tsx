import type { LogEvidenceItem, MetricEvidenceItem } from "../../domain/incident.ts";
import { FactsList } from "../../ui/evidence/FactsList.tsx";
import { LogBlock } from "../../ui/evidence/LogBlock.tsx";
import { MetricSparkline } from "../../ui/evidence/MetricSparkline.tsx";
import { alertLabel, alertRate } from "../incident.ts";
import { clockAt, type Scenario } from "../scenario.ts";
import { revisionOf, type ClusterState, type LogEntry } from "../sim/model.ts";
import type { NodeId } from "../health.ts";

type Props = {
  node: NodeId;
  cluster: ClusterState;
  scenario: Scenario;
  /** Puts a command in the terminal prompt without running it. */
  onSuggest: (command: string) => void;
  onClose: () => void;
};

function metric(label: string, unit: string, points: readonly number[]): MetricEvidenceItem | null {
  return points.length >= 2 ? { type: "metric", label, unit, points: [...points] } : null;
}

function logBlock(label: string, entries: readonly LogEntry[] | undefined, scenario: Scenario): LogEvidenceItem | null {
  const recent = (entries ?? []).slice(-5);
  if (recent.length < 1) return null;
  return {
    type: "log",
    label,
    lines: recent.map((entry, index) => ({ ts: clockAt(scenario, entry.t, true, index), level: entry.level, text: entry.text })),
  };
}

export function InspectPanel({ node, cluster, scenario, onSuggest, onClose }: Props) {
  const view = describeNode(node, cluster, scenario);
  return (
    <section className="inspect" aria-label={`Inspecting ${view.title}`}>
      <header className="inspect__head">
        <h2 className="inspect__title">{view.title}</h2>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </header>
      {view.subtitle && <p className="inspect__subtitle">{view.subtitle}</p>}
      {view.metric && <MetricSparkline metric={view.metric} />}
      {view.facts && <FactsList facts={{ type: "facts", label: "status", items: view.facts }} />}
      {view.log && <LogBlock log={view.log} />}
      {view.suggestions.length > 0 && (
        <div className="inspect__suggest">
          {view.suggestions.map((command) => (
            <button key={command} type="button" className="chip" onClick={() => onSuggest(command)}>
              {command}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

type NodeView = {
  title: string;
  subtitle?: string;
  metric?: MetricEvidenceItem | null;
  facts?: { key: string; value: string }[];
  log?: LogEvidenceItem | null;
  suggestions: string[];
};

function describeNode(node: NodeId, cluster: ClusterState, scenario: Scenario): NodeView {
  switch (node.kind) {
    case "edge":
      return {
        title: "edge-lb",
        subtitle: `${Math.round(cluster.errorRate * 100)}% of ${cluster.traffic.requestsPerSecond} req/s failing with 5xx`,
        metric: metric("checkout 5xx ratio", "%", cluster.series.errorRate.map((rate) => Math.round(rate * 1000) / 10)),
        // 5xx can read 0% while the pager watches something else; show that too.
        facts: scenario.alertMetric ? [{ key: alertLabel(scenario), value: `${Math.round(alertRate(scenario, cluster) * 100)}%` }] : undefined,
        log: logBlock("edge-lb access log", cluster.logs["edge-lb"], scenario),
        suggestions: ["kubectl get pods", "curl -s http://checkout-api:8080/actuator/health"],
      };
    case "database":
      return {
        title: cluster.database.name,
        subtitle: `max_connections ${cluster.database.maxConnections} (${cluster.database.reservedConnections} reserved for superuser)`,
        metric: metric("open connections", "conn", cluster.series.dbConnections),
        log: logBlock("postgres log", cluster.logs[cluster.database.name], scenario),
        suggestions: [
          'psql -c "select state, count(*) from pg_stat_activity group by state"',
          'psql -c "select * from pg_stat_activity"',
          'psql -c "show max_connections"',
        ],
      };
    case "external": {
      const external = scenario.externals.find((candidate) => candidate.id === node.id);
      return {
        title: node.id,
        subtitle: "Third-party dependency — you can’t operate it from here.",
        facts: external ? [...external.facts] : [],
        suggestions: [],
      };
    }
    case "pod": {
      const deployment = cluster.deployments.find((candidate) => candidate.pods.some((pod) => pod.name === node.name));
      const pod = deployment?.pods.find((candidate) => candidate.name === node.name);
      if (!deployment || !pod) return { title: node.name, subtitle: "This pod is gone.", suggestions: ["kubectl get pods"] };
      return {
        title: pod.name,
        subtitle: `${pod.phase} · ${revisionOf(deployment, pod.revision).tag} · restarts ${pod.restarts}`,
        metric: metric("hikaricp_connections_active", "conn", pod.connectionHistory),
        log: logBlock("container log", cluster.logs[pod.name], scenario),
        suggestions: [`kubectl logs ${pod.name} --tail=20`, `kubectl describe pod ${pod.name}`, `kubectl delete pod ${pod.name}`],
      };
    }
  }
}
