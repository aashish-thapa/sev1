import { activeSessionCount, idleSessionCount, terminateIdleSessions } from "../../sim/actions.ts";
import { checkoutQuerySeconds } from "../../sim/database.ts";
import { holdsPool, type ClusterState } from "../../sim/model.ts";
import { operatorName } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { sqlTable } from "../sql-table.ts";
import { INDEX_QUERIES } from "./psql-indexes.ts";
import { err, out, type Command, type ShellResult } from "../types.ts";

export type QueryHandler = { matches: (sql: string) => boolean; run: (cluster: ClusterState, sql: string) => ShellResult };

const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, " ").trim();

const QUERIES: readonly QueryHandler[] = [
  ...INDEX_QUERIES,
  {
    matches: (sql) => sql.includes("pg_terminate_backend"),
    run: (cluster) => {
      const result = terminateIdleSessions(cluster);
      return result.ok ? { output: out(...result.output, ""), cluster: result.state } : { output: err(...result.output) };
    },
  },
  {
    matches: (sql) => sql.startsWith("show max_connections"),
    run: (cluster) => ({ output: out(...sqlTable(["max_connections"], [[String(cluster.database.maxConnections)]])) }),
  },
  {
    matches: (sql) => sql.includes("pg_stat_activity") && sql.includes("group by") && sql.includes("application_name"),
    run: (cluster) => ({
      output: out(
        ...sqlTable(
          ["application_name", "count"],
          [
            ...cluster.deployments.map((deployment) => [deployment.name, String(deployment.pods.filter(holdsPool).length * deployment.poolSize)]),
            ["psql", "1"],
          ],
        ),
      ),
    }),
  },
  {
    matches: (sql) => sql.includes("pg_stat_activity") && sql.includes("group by") && sql.includes("state"),
    run: (cluster) => ({
      output: out(
        ...sqlTable(
          ["state", "count"],
          [
            ["active", String(activeSessionCount(cluster) + 1)],
            ["idle", String(idleSessionCount(cluster))],
          ],
        ),
      ),
    }),
  },
  {
    matches: (sql) => sql.includes("pg_stat_activity") && sql.includes("count("),
    run: (cluster) => ({ output: out(...sqlTable(["count"], [[String(activeSessionCount(cluster) + idleSessionCount(cluster) + 1)]])) }),
  },
  {
    matches: (sql) => sql.includes("pg_stat_activity"),
    run: (cluster) => {
      // Leaked sessions read as plain idle with an old state_change — the tell.
      const leaked = cluster.deployments.flatMap((deployment) =>
        deployment.pods.filter((pod) => pod.phase === "Running" && pod.leaked > 0).map((pod) => ({ pod, deployment })),
      );
      const rows: string[][] = [];
      let pid = 48_211;
      for (const { pod, deployment } of leaked) {
        for (let index = 0; index < Math.min(pod.leaked, 3); index += 1) {
          pid += 37;
          const minutes = Math.max(1, Math.floor((cluster.t - pod.startedAt) / 60 / (index + 2)));
          rows.push([String(pid), deployment.name, "idle", `${minutes} min`, "SELECT payment_intent_id FROM orders WHERE id = $1"]);
        }
      }
      // A seq-scanning checkout query reads as many active sessions running the same statement for seconds.
      const index = cluster.database.hotIndex;
      if (index && !index.isValid) {
        const seconds = checkoutQuerySeconds(cluster.database);
        for (const deployment of cluster.deployments) {
          for (let session = 0; session < 6; session += 1) {
            pid += 41;
            rows.push([String(pid), deployment.name, "active", `00:00:0${Math.min(9, seconds * (0.4 + session * 0.12)).toFixed(1)}`, index.query]);
          }
        }
      }
      rows.push(["61377", "psql", "active", "0 min", "SELECT pid, application_name, state, … FROM pg_stat_activity"]);
      return { output: out(...sqlTable(["pid", "application_name", "state", "since_state_change", "query"], rows.slice(0, 10)), "(showing first 10; add GROUP BY to aggregate)") };
    },
  },
];

export const psql: Command = {
  name: "psql",
  roles: ["infrastructure"],
  refuse: (_args, { cluster, role }) =>
    err(
      `psql: error: connection to server at "${cluster.database.host}" (10.0.3.21), port 5432 failed: FATAL:  no pg_hba.conf entry for host "10.40.7.23", user "${operatorName(role)}", database "orders", SSL encryption`,
    ),
  usage: 'psql -c "<sql>"   e.g. psql -c "select state, count(*) from pg_stat_activity group by state"',
  summary: "Query orders-db (read-only role, plus pg_terminate_backend and REINDEX)",
  run(args, { cluster }) {
    const { value: sql } = takeFlag(args, "-c", "--command");
    if (sql === undefined) {
      return { output: err('psql: interactive sessions are disabled on the bastion; use psql -c "<sql>"') };
    }
    const normalized = normalize(sql);
    const handler = QUERIES.find((query) => query.matches(normalized));
    if (handler) return handler.run(cluster, normalized);
    const table = /from\s+([a-z_.]+)/.exec(normalized)?.[1];
    return { output: err(table ? `ERROR:  permission denied for table ${table}` : `ERROR:  syntax error at or near "${sql.split(/\s+/)[0] ?? ""}"`) };
  },
  complete: (args) =>
    args.length === 0
      ? ["-c"]
      : [
          "select state, count(*) from pg_stat_activity group by state",
          "select application_name, count(*) from pg_stat_activity group by application_name",
          "show max_connections",
          "select query, calls, mean_exec_time from pg_stat_statements order by mean_exec_time desc limit 5",
          "\\d orders",
        ],
};
