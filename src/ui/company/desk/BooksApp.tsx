import { ROOM_KINDS, SERVER_TIERS } from "../../../domain/company/catalog.ts";
import { formatCents } from "../../../domain/economy.ts";
import type { Company } from "../../../storage/company-protocol.ts";
import { Investors } from "../Investors.tsx";
import { Trackers } from "../Trackers.tsx";
import { useCompanyAction, useDesk, type CompanyDesk } from "./desk.ts";

const REASON_LABEL: Readonly<Record<Company["ledger"][number]["reason"], string>> = {
  seed: "Seed",
  revenue: "Revenue",
  "room-upkeep": "Room upkeep",
  "server-upkeep": "Server upkeep",
  contractor: "Contractor",
  pantry: "Pantry",
  payroll: "Payroll",
  "room-purchase": "Room bought",
  "server-purchase": "Server bought",
  investment: "Investment",
  dividend: "Dividend",
};

const TITLE = new Map<string, string>([...ROOM_KINDS.map((room) => [room.id, room.title] as const), ...SERVER_TIERS.map((tier) => [tier.id, tier.title] as const)]);

/** The money: trackers, owners and investment offers, and every line booked. */
export function BooksApp({ desk }: { desk: CompanyDesk }) {
  const { api, company } = desk;
  const { isFounder } = useDesk(desk);
  const { act, notice, isBusy } = useCompanyAction(desk.refresh);

  return (
    <div className="desk">
      {company.trackers && <Trackers trackers={company.trackers} itemTitle={(item) => (TITLE.get(item) ?? item).toLowerCase()} />}
      {company.capTable && <Investors api={api} capTable={company.capTable} offers={company.investmentOffers} proposals={company.investmentProposals} isFounder={isFounder} isBusy={isBusy} act={act} />}
      <p className="company__note" role="status">
        {notice}
      </p>
      {company.ledger.length === 0 ? (
        <p className="company__note">Nothing booked yet.</p>
      ) : (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">What</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...company.ledger].reverse().map((line, index) => (
              <tr key={`${line.at}-${index}`}>
                <td>{line.workDay}</td>
                <td>
                  {REASON_LABEL[line.reason]}
                  {line.note && <span className="admin__dim"> · {line.note}</span>}
                </td>
                <td className={line.amountCents < 0 ? "hq__out" : "hq__in"}>
                  {line.amountCents < 0 ? "−" : "+"}
                  {formatCents(Math.abs(line.amountCents))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
