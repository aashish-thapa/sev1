import { reindex } from "../../sim/actions.ts";
import { checkoutQuerySeconds, REBUILD_SECONDS } from "../../sim/database.ts";
import type { ClusterState, HotIndex } from "../../sim/model.ts";
import { sqlTable } from "../sql-table.ts";
import { err, out } from "../types.ts";
import type { QueryHandler } from "./psql.ts";

/** Indexes every orders table has; the scenario's hot index is listed after them. */
const STANDING_INDEXES = [
  { name: "orders_pkey", definition: "PRIMARY KEY, btree (id)" },
  { name: "orders_payment_intent_id_key", definition: "UNIQUE CONSTRAINT, btree (payment_intent_id)" },
] as const;

const ORDERS_ROWS_REMOVED = "1404625";

function hotIndexOf(cluster: ClusterState): HotIndex | null {
  return cluster.database.hotIndex ?? null;
}

function describeOrders(cluster: ClusterState): string[] {
  const index = hotIndexOf(cluster);
  return [
    '                         Table "public.orders"',
    "      Column       |           Type           | Nullable",
    "-------------------+--------------------------+----------",
    " id                | uuid                     | not null",
    " customer_id       | uuid                     | not null",
    " status            | text                     | not null",
    " payment_intent_id | text                     |",
    " total_minor       | bigint                   | not null",
    " created_at        | timestamp with time zone | not null",
    "Indexes:",
    ...STANDING_INDEXES.map((standing) => `    "${standing.name}" ${standing.definition}`),
    ...(index ? [`    "${index.name}" ${index.definition}${index.isValid ? "" : " INVALID"}`] : []),
    "",
  ];
}

function explain(cluster: ClusterState): string[] {
  const index = hotIndexOf(cluster);
  if (!index || index.isValid) {
    return [
      "                                        QUERY PLAN",
      "-------------------------------------------------------------------------------------------",
      ` Limit  (cost=0.56..8.61 rows=1 width=72)`,
      `   ->  Index Scan using ${index?.name ?? "orders_pkey"} on orders  (cost=0.56..8.61 rows=1 width=72)`,
      "         Index Cond: ((customer_id = $1) AND (status = 'pending'::text))",
      "",
    ];
  }
  const milliseconds = Math.round(checkoutQuerySeconds(cluster.database) * 1000);
  return [
    "                                        QUERY PLAN",
    "-------------------------------------------------------------------------------------------",
    " Limit  (cost=1000.00..129804.17 rows=1 width=72)",
    "   ->  Gather Merge  (cost=1000.00..129804.17 rows=1 width=72)",
    "         Workers Planned: 2",
    "         ->  Sort  (cost=0.00..128804.15 rows=1 width=72)",
    "               Sort Key: created_at DESC",
    "               ->  Parallel Seq Scan on orders  (cost=0.00..128804.14 rows=1 width=72)",
    "                     Filter: ((customer_id = $1) AND (status = 'pending'::text))",
    `                     Rows Removed by Filter: ${ORDERS_ROWS_REMOVED}`,
    ` Execution Time: ${milliseconds}.214 ms`,
    "",
  ];
}

function statements(cluster: ClusterState): string[] {
  const index = hotIndexOf(cluster);
  const lookupMs = index ? (checkoutQuerySeconds(cluster.database) * 1000 + 0.4).toFixed(1) : "0.4";
  return sqlTable(
    ["query", "calls", "mean_exec_time"],
    [
      [index?.query ?? "SELECT id FROM orders WHERE customer_id = $1 AND status = $2 …", "118204", lookupMs],
      ["INSERT INTO orders (id, customer_id, status, total_minor, created_at) VALUES ($1, …)", "61877", "1.9"],
      ["SELECT payment_intent_id FROM orders WHERE id = $1", "59310", "0.3"],
      ["UPDATE orders SET status = $1 WHERE id = $2", "58842", "0.8"],
    ],
  );
}

function progress(cluster: ClusterState): string[] {
  const rebuild = hotIndexOf(cluster)?.rebuild;
  if (!rebuild) return sqlTable(["index", "phase", "blocks_done", "blocks_total"], []);
  const total = rebuild.isLocking ? REBUILD_SECONDS.locking : REBUILD_SECONDS.concurrent;
  const done = Math.round(((total - rebuild.secondsLeft) / total) * 52_114);
  return sqlTable(
    ["index", "phase", "blocks_done", "blocks_total"],
    [[hotIndexOf(cluster)?.name ?? "", "building index: scanning table", String(done), "52114"]],
  );
}

const REINDEX = /^reindex (?:\([^)]*\) )?index (concurrently )?([a-z_."]+)/;

/** What psql can learn about, and do to, the indexes on `orders`. */
export const INDEX_QUERIES: readonly QueryHandler[] = [
  {
    matches: (sql) => REINDEX.test(sql),
    run: (cluster, sql) => {
      const [, concurrently, name] = REINDEX.exec(sql) ?? [];
      const result = reindex(cluster, (name ?? "").replaceAll('"', "").replace(/^public\./, ""), Boolean(concurrently));
      return result.ok ? { output: out(...result.output, ""), cluster: result.state } : { output: err(...result.output) };
    },
  },
  {
    matches: (sql) => sql.startsWith("create index") || sql.startsWith("create unique index"),
    run: (cluster) => {
      const index = hotIndexOf(cluster);
      return index
        ? { output: err(`ERROR:  relation "${index.name}" already exists`, `HINT:  An index that failed to build stays behind as INVALID; REINDEX it instead.`) }
        : { output: err("ERROR:  permission denied for schema public") };
    },
  },
  {
    matches: (sql) => sql.startsWith("drop index"),
    run: () => ({ output: err("ERROR:  must be owner of index") }),
  },
  { matches: (sql) => /^\\d\+? orders\b/.test(sql), run: (cluster) => ({ output: out(...describeOrders(cluster)) }) },
  {
    matches: (sql) => sql.includes("pg_indexes") || sql.includes("indisvalid"),
    run: (cluster) => {
      const index = hotIndexOf(cluster);
      const rows = [
        ...STANDING_INDEXES.map((standing) => [standing.name, "t"]),
        ...(index ? [[index.name, index.isValid ? "t" : "f"]] : []),
      ];
      return { output: out(...sqlTable(["indexname", "indisvalid"], rows)) };
    },
  },
  { matches: (sql) => sql.startsWith("explain") && sql.includes("orders"), run: (cluster) => ({ output: out(...explain(cluster)) }) },
  { matches: (sql) => sql.includes("pg_stat_statements"), run: (cluster) => ({ output: out(...statements(cluster)) }) },
  { matches: (sql) => sql.includes("pg_stat_progress_create_index"), run: (cluster) => ({ output: out(...progress(cluster)) }) },
];
