import { useState } from "react";
import { categoryById } from "../../domain/company/catalog.ts";
import { formatCents } from "../../domain/economy.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import type { Holding, MyProposal, ReceivedOffer } from "../../storage/company-protocol.ts";
import { companyErrorText } from "./errors.ts";
import { percent } from "./percent.ts";

type Props = {
  api: CompanyApi;
  offers: readonly ReceivedOffer[];
  holdings: readonly Holding[];
  /** Your asks to invest, waiting on founders. */
  proposals: readonly MyProposal[];
  walletCents: number;
  /** Spends the accepted offer's amount from the wallet against the server's ref; false if the balance is short. */
  invest: (investRef: string, cents: number) => boolean;
  /** Called after a wallet move, so the page re-reads once it has saved. */
  onMoved: () => void;
  onChanged: () => void;
};

/** Offers to invest in other players' companies, and the stakes you hold. */
export function InvestorPanel({ api, offers, holdings, proposals, walletCents, invest, onMoved, onChanged }: Props) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (offers.length === 0 && holdings.length === 0 && proposals.length === 0) return null;

  const accept = async (offer: ReceivedOffer) => {
    if (offer.amountCents > walletCents) return setNotice(`That stake costs ${formatCents(offer.amountCents)}; your wallet has ${formatCents(walletCents)}.`);
    setBusyId(offer.id);
    setNotice(null);
    const accepted = await api.acceptOffer(offer.id);
    setBusyId(null);
    if (!accepted.ok) return setNotice(companyErrorText(accepted.error, accepted.message));
    if (!invest(accepted.value.investRef, accepted.value.amountCents)) return setNotice("Your wallet doesn’t have that much.");
    setNotice(`Investing ${formatCents(accepted.value.amountCents)} in ${offer.companyName}. It’s yours once your progress saves.`);
    onMoved();
  };

  const decline = async (offer: ReceivedOffer) => {
    setBusyId(offer.id);
    const declined = await api.declineOffer(offer.id);
    setBusyId(null);
    setNotice(declined.ok ? `Declined ${offer.companyName}’s offer.` : companyErrorText(declined.error, declined.message));
    if (declined.ok) onChanged();
  };

  return (
    <section className="company__panel" aria-labelledby="investing-title">
      <h2 id="investing-title" className="admin__heading">
        Your investments
      </h2>
      {offers.length > 0 && (
        <ul className="shop" aria-label="Offers to invest">
          {offers.map((offer) => (
            <li key={offer.id} className="shop__item">
              <span>
                <strong>
                  {percent(offer.equityBps)} of {offer.companyName}
                </strong>
                <span className="admin__dim">
                  {" "}
                  · for {formatCents(offer.amountCents)} · {categoryById(offer.category).title}, {offer.levelTitle} · from {offer.founder} · values it at {formatCents(offer.valuationCents)}
                </span>
              </span>
              <span className="hq__decide">
                <button type="button" className="button button--primary" disabled={busyId !== null} onClick={() => void accept(offer)}>
                  Invest {formatCents(offer.amountCents)}
                </button>
                <button type="button" className="button button--quiet" disabled={busyId !== null} onClick={() => void decline(offer)}>
                  Decline
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {proposals.length > 0 && (
        <ul className="shop" aria-label="Waiting on founders">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="shop__item">
              <span>
                <strong>
                  {percent(proposal.equityBps)} of {proposal.companyName}
                </strong>
                <span className="admin__dim"> · {formatCents(proposal.amountCents)} · waiting on the founder</span>
              </span>
              <button
                type="button"
                className="button button--quiet"
                disabled={busyId !== null}
                onClick={async () => {
                  setBusyId(proposal.id);
                  const withdrawn = await api.withdrawProposal(proposal.id);
                  setBusyId(null);
                  setNotice(withdrawn.ok ? "Proposal withdrawn." : companyErrorText(withdrawn.error, withdrawn.message));
                  if (withdrawn.ok) onChanged();
                }}
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}
      {holdings.length > 0 && (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Your share</th>
              <th scope="col">Put in</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => (
              <tr key={holding.companyId}>
                <th scope="row">{holding.companyName}</th>
                <td>{percent(holding.bps)}</td>
                <td>{formatCents(holding.investedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="company__note" role="status">
        {notice ?? "Dividends arrive every 7th profitable work day."}
      </p>
    </section>
  );
}
