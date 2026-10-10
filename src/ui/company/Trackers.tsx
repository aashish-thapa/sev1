import { formatCents } from "../../domain/economy.ts";
import type { TrackersWire } from "../../storage/company-protocol.ts";

/** What each running cost is called in the trackers. */
const EXPENSE_LABEL: Readonly<Record<string, string>> = {
  payroll: "Payroll",
  "room-upkeep": "Room upkeep",
  "server-upkeep": "Server upkeep",
  contractor: "Contractors",
  pantry: "Pantry",
};

const cost = (cents: number) => (cents > 0 ? `−${formatCents(cents)}` : formatCents(0));

/** Money in, what the company owns, and what it earned and spent over the last 7 and 30 work days. */
export function Trackers({ trackers, itemTitle }: { trackers: TrackersWire; itemTitle: (item: string) => string }) {
  const reasons = Object.keys(EXPENSE_LABEL).filter((reason) => (trackers.last30.expensesByReason[reason] ?? 0) > 0);
  const net = (window: TrackersWire["last7"]) => window.earningsCents - window.expensesCents;
  return (
    <section className="company__panel" aria-labelledby="trackers-title">
      <h2 id="trackers-title" className="admin__heading">
        Trackers
      </h2>
      <dl className="admin__tiles">
        <div className="admin__tile">
          <dt>Invested</dt>
          <dd>{formatCents(trackers.investedCents)}</dd>
        </div>
        <div className="admin__tile">
          <dt>Inventory at cost</dt>
          <dd>{formatCents(trackers.inventoryCents)}</dd>
        </div>
        <div className="admin__tile">
          <dt>Net, last 7 days</dt>
          <dd>{net(trackers.last7) < 0 ? `−${formatCents(-net(trackers.last7))}` : formatCents(net(trackers.last7))}</dd>
        </div>
      </dl>
      <table className="admin__table">
        <thead>
          <tr>
            <th scope="col">Work days</th>
            <th scope="col">Last 7</th>
            <th scope="col">Last 30</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Earnings</th>
            <td className="hq__in">{formatCents(trackers.last7.earningsCents)}</td>
            <td className="hq__in">{formatCents(trackers.last30.earningsCents)}</td>
          </tr>
          {reasons.map((reason) => (
            <tr key={reason}>
              <th scope="row">{EXPENSE_LABEL[reason]}</th>
              <td>{cost(trackers.last7.expensesByReason[reason] ?? 0)}</td>
              <td>{cost(trackers.last30.expensesByReason[reason] ?? 0)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">All running costs</th>
            <td>{cost(trackers.last7.expensesCents)}</td>
            <td>{cost(trackers.last30.expensesCents)}</td>
          </tr>
        </tbody>
      </table>
      {trackers.inventory.length > 0 && (
        <p className="company__note">
          Owns {trackers.inventory.map((entry) => `${entry.count} × ${itemTitle(entry.item)} (${formatCents(entry.costCents)})`).join(", ")}.
        </p>
      )}
    </section>
  );
}
