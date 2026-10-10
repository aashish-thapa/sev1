import { clockAt } from "../../scenario.ts";
import { pendingRefunds, submitRefunds, visibleOrphans, WAREHOUSE_LAG_SECONDS } from "../../sim/commerce-actions.ts";
import type { Commerce } from "../../sim/commerce.ts";
import { applied, commerceCommand, count, dollars, stamp } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

/** Orphaned captures per second over the last visible minute. */
function accrualPerSecond(commerce: Commerce): number {
  const history = commerce.ledger.orphanHistory;
  const end = history.at(-1 - WAREHOUSE_LAG_SECONDS);
  const start = history.at(-1 - WAREHOUSE_LAG_SECONDS - 30);
  return end !== undefined && start !== undefined ? (end - start) / 30 : 0;
}

function accrualWarning(commerce: Commerce): readonly OutputLine[] {
  const perMinute = accrualPerSecond(commerce) * 60;
  if (perMinute >= 30) return err(`Still accruing: about ${count(perMinute)} new orphaned captures a minute. A batch now will be incomplete until the retries stop.`);
  if (perMinute >= 1) return dim(`Trickling in: about ${count(perMinute)} new orphaned captures a minute. A later batch picks them up.`);
  return dim("No new orphaned captures in the last visible minute.");
}

function preview(context: ShellContext, commerce: Commerce): ShellResult {
  const { ledger } = commerce;
  const visible = visibleOrphans(commerce);
  const pending = pendingRefunds(commerce);
  return {
    output: [
      ...out(`Orphaned captures (charge captured, order never paid) as of ${clockAt(context.scenario, context.cluster.t - WAREHOUSE_LAG_SECONDS)}`),
      ...out(
        ...table([
          ["", "CHARGES", "AMOUNT"],
          ["visible in warehouse", count(visible), dollars(visible * ledger.averageOrderCents)],
          ["already in a refund batch", count(ledger.refundedCaptures), dollars(ledger.refundedCaptures * ledger.averageOrderCents)],
          ["would be refunded now", count(pending), dollars(pending * ledger.averageOrderCents)],
        ]),
      ),
      ...accrualWarning(commerce),
    ],
  };
}

function submit(context: ShellContext, commerce: Commerce): ShellResult {
  const result = submitRefunds(context.cluster, operatorName(context.role));
  return applied("reconcile", result, (state) => {
    const batch = state.commerce?.ledger.refundBatches.at(-1);
    if (!batch) return [];
    return [
      ...out(`Refund batch ${batch.id} queued: ${count(batch.captures)} refunds, ${dollars(batch.amountCents)}.`),
      ...dim("Payments Ops executes it through the payment-gateway Refunds API, keyed by charge id, so re-running never refunds a charge twice."),
      ...accrualWarning(commerce),
    ];
  });
}

function status(context: ShellContext, commerce: Commerce): ShellResult {
  const { ledger } = commerce;
  if (ledger.refundBatches.length === 0) return { output: dim("No refund batches yet. reconcile preview shows what one would contain.") };
  const rows = ledger.refundBatches.map((batch) => [batch.id, stamp(context, batch.at), batch.by, count(batch.captures), dollars(batch.amountCents), "queued"]);
  return {
    output: [
      ...out(...table([["BATCH", "CREATED", "BY", "REFUNDS", "AMOUNT", "STATE"], ...rows])),
      ...dim(`${count(ledger.refundedCaptures)} of ${count(visibleOrphans(commerce))} visible orphaned captures covered.`),
    ],
  };
}

const SUBCOMMANDS: Record<string, (context: ShellContext, commerce: Commerce) => ShellResult> = { preview, submit, status };

export const reconcile = commerceCommand({
  name: "reconcile",
  usage: "reconcile preview | submit | status",
  summary: "Build refund batches for orphaned charges",
  roles: ["data"],
  refuse: (_args, { role }) => ssoRefusal("reconcile", "payments-recon", role),
  run([sub], context, commerce) {
    const handler = SUBCOMMANDS[sub ?? "preview"];
    return handler ? handler(context, commerce) : { output: err(`reconcile: unknown command "${sub}"`, "Commands: preview, submit, status") };
  },
  complete: (args) => (args.length === 0 ? Object.keys(SUBCOMMANDS) : []),
});
