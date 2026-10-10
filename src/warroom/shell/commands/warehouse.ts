import { clockAt } from "../../scenario.ts";
import { visibleOrphans, WAREHOUSE_LAG_SECONDS } from "../../sim/commerce-actions.ts";
import type { Commerce } from "../../sim/commerce.ts";
import { commerceCommand, count } from "../commerce-command.ts";
import { ssoRefusal } from "../identity.ts";
import { sqlTable } from "../sql-table.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

/** Volume already in today's partitions before the sale opened. */
const MORNING_CHARGES = 31_204;
const MORNING_ORDERS = 31_877;

type Saved = {
  readonly description: string;
  readonly sql: string;
  readonly matches: (sql: string) => boolean;
  readonly run: (context: ShellContext, commerce: Commerce) => readonly OutputLine[];
};

const amount = (cents: number) => (cents / 100).toFixed(2);

function dataAsOf(context: ShellContext, scannedGb: number): readonly OutputLine[] {
  const seconds = 1.2 + (context.cluster.t % 17) / 10;
  return dim(`Finished in ${seconds.toFixed(1)} s · scanned ${scannedGb.toFixed(1)} GB · data as of ${clockAt(context.scenario, context.cluster.t - WAREHOUSE_LAG_SECONDS)} (CDC lag ${WAREHOUSE_LAG_SECONDS} s)`);
}

/** The ledger as the warehouse sees it: everything except the last CDC-lag seconds. */
function visibleShare(commerce: Commerce): number {
  const total = commerce.ledger.orphanedCaptures;
  return total > 0 ? visibleOrphans(commerce) / total : 0;
}

function segmentLabel(id: string): string {
  return id.replace("@", " ");
}

const SAVED: Record<string, Saved> = {
  "revenue-vs-orders": {
    description: "Captured charges vs paid orders, per minute since the sale opened",
    sql: "select date_trunc('minute', c.captured_at) as minute, count(*) filter (where o.status = 'paid') as paid_orders, count(*) as captured_charges, sum(c.amount) / 100.0 as captured_usd from payments.charges c join orders.orders o on o.id = c.order_id where c.captured_at >= '10:00' group by 1 order by 1",
    matches: (sql) => sql.includes("revenue") || (sql.includes("date_trunc") && sql.includes("charges")),
    run: (context, commerce) => {
      const { ledger } = commerce;
      const visibleMinute = Math.floor((context.cluster.t - WAREHOUSE_LAG_SECONDS) / 60);
      const rows = ledger.minutes
        .filter((bucket) => bucket.minute <= visibleMinute)
        .map((bucket) => {
          const captured = bucket.paidOrders + bucket.orphanedCaptures;
          return [
            clockAt(context.scenario, bucket.minute * 60).slice(0, 5),
            String(Math.round(bucket.paidOrders)),
            String(Math.round(captured)),
            amount(Math.round(captured) * ledger.averageOrderCents),
            amount(Math.round(bucket.paidOrders) * ledger.averageOrderCents),
          ];
        });
      return [...out(...sqlTable(["minute", "paid_orders", "captured_charges", "captured_usd", "paid_order_usd"], rows)), ...dataAsOf(context, 0.4)];
    },
  },
  "orphaned-captures": {
    description: "Captured charges whose order never reached 'paid', by client and idempotency key",
    sql: "select c.client, c.idempotency_key is not null as has_idempotency_key, count(*) as charges, sum(c.amount) / 100.0 as amount_usd from payments.charges c left join orders.orders o on o.id = c.order_id and o.status = 'paid' where c.status = 'captured' and o.id is null and c.captured_at >= current_date group by 1, 2 order by 3 desc",
    matches: (sql) => sql.includes("left join") || sql.includes("not exists") || sql.includes("orphan") || /status\s*(<>|!=)\s*'paid'/.test(sql),
    run: (context, commerce) => {
      const share = visibleShare(commerce);
      const rows = Object.entries(commerce.ledger.orphanedBySegment)
        .flatMap(([id, split]) => [
          { client: segmentLabel(id), hasKey: "f", charges: Math.round(split.withoutKey * share) },
          { client: segmentLabel(id), hasKey: "t", charges: Math.round(split.withKey * share) },
        ])
        .filter((row) => row.charges > 0)
        .sort((left, right) => right.charges - left.charges)
        .map((row) => [row.client, row.hasKey, String(row.charges), amount(row.charges * commerce.ledger.averageOrderCents)]);
      return [...out(...sqlTable(["client", "has_idempotency_key", "charges", "amount_usd"], rows)), ...dataAsOf(context, 1.9)];
    },
  },
  "multi-charge-carts": {
    description: "Carts captured more than once today (top 10)",
    sql: "select c.cart_id, c.client, count(*) as captures, min(c.captured_at) as first_capture, max(c.captured_at) as last_capture from payments.charges c where c.status = 'captured' and c.captured_at >= current_date group by 1, 2 having count(*) > 1 order by 3 desc, 4 limit 10",
    matches: (sql) => sql.includes("having"),
    run: (context, commerce) => {
      const share = visibleShare(commerce);
      const unsafe = Object.entries(commerce.ledger.orphanedBySegment).filter(([, split]) => split.withoutKey * share >= 1);
      const rows: string[][] = [];
      for (let index = 0; index < 10 && unsafe.length > 0; index += 1) {
        const [id] = unsafe[index % unsafe.length];
        const gap = id.startsWith("web") ? 8 : 10;
        const captures = index < 4 ? 4 : index < 8 ? 3 : 2;
        const saleOpened = (commerce.ledger.minutes[0]?.minute ?? 0) * 60;
        const first = Math.max(saleOpened + 20, context.cluster.t - WAREHOUSE_LAG_SECONDS - 240) + index * 17;
        const cart = `c_${((index + 1) * 2_654_435_761 >>> 8).toString(16).slice(0, 6)}`;
        rows.push([cart, segmentLabel(id), String(captures), clockAt(context.scenario, first), clockAt(context.scenario, first + gap * (captures - 1))]);
      }
      return [...out(...sqlTable(["cart_id", "client", "captures", "first_capture", "last_capture"], rows)), ...dataAsOf(context, 1.9)];
    },
  },
};

function tables(commerce: Commerce): ShellResult {
  const paid = commerce.ledger.paidOrders;
  const orphaned = visibleOrphans(commerce);
  const freshness = `${WAREHOUSE_LAG_SECONDS} s behind`;
  return {
    output: out(
      ...table([
        ["TABLE", "ROWS TODAY", "FRESHNESS", "SOURCE"],
        ["payments.charges", count(MORNING_CHARGES + paid + orphaned), freshness, "CDC from payment-gateway webhooks"],
        ["orders.orders", count(MORNING_ORDERS + paid + orphaned), freshness, "CDC from orders-db"],
        ["analytics.revenue_minutely", count(commerce.ledger.minutes.length + 600), freshness, "dbt incremental, every minute"],
      ]),
    ),
  };
}

function saved(): ShellResult {
  return {
    output: [
      ...out(...table([["NAME", "DESCRIPTION"], ...Object.entries(SAVED).map(([name, query]) => [name, query.description])])),
      ...dim("warehouse run <name> runs one; warehouse show <name> prints its SQL"),
    ],
  };
}

function query(sql: string, context: ShellContext, commerce: Commerce): ShellResult {
  const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();
  const match = Object.values(SAVED).find((candidate) => candidate.matches(normalized));
  if (match) return { output: match.run(context, commerce) };
  const relation = /from\s+([a-z_.]+)/.exec(normalized)?.[1];
  if (!relation) return { output: err(`ERROR:  syntax error at or near "${sql.split(/\s+/)[0] ?? ""}"`) };
  if (!["payments.charges", "orders.orders", "analytics.revenue_minutely"].includes(relation)) {
    return { output: err(`ERROR:  relation "${relation}" does not exist`) };
  }
  return {
    output: err(
      `ERROR:  query rejected by cost guard: full scan of ${relation} (2.1 TB) needs a partition filter on captured_at or created_at`,
      "HINT:  warehouse saved lists vetted queries for incident use",
    ),
  };
}

export const warehouse = commerceCommand({
  name: "warehouse",
  usage: 'warehouse tables | saved | show <name> | run <name> | query "<sql>"',
  summary: "Query payments and orders in the warehouse (read-only)",
  roles: ["data"],
  refuse: (_args, { role }) => ssoRefusal("warehouse", "data-eng", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case undefined:
      case "tables":
        return tables(commerce);
      case "saved":
        return saved();
      case "show": {
        const target = rest[0] ? SAVED[rest[0]] : undefined;
        return target ? { output: out(target.sql) } : { output: err(`warehouse: no saved query "${rest[0] ?? ""}"`) };
      }
      case "run": {
        const target = rest[0] ? SAVED[rest[0]] : undefined;
        return target ? { output: target.run(context, commerce) } : { output: err(`warehouse: no saved query "${rest[0] ?? ""}" (warehouse saved)`) };
      }
      case "query":
        return rest[0] ? query(rest.join(" "), context, commerce) : { output: err('usage: warehouse query "<sql>"') };
      default:
        return { output: err(`warehouse: unknown command "${sub}"`, "Commands: tables, saved, show, run, query") };
    }
  },
  complete(args) {
    if (args.length === 0) return ["tables", "saved", "show", "run", "query"];
    if (args.length === 1 && (args[0] === "run" || args[0] === "show")) return Object.keys(SAVED);
    return [];
  },
});
