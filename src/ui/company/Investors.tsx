import { useState, type FormEvent } from "react";
import { checkInvestmentOffer, founderAfter, impliedValuationCents, MAX_OFFER_BPS, MIN_INVESTMENT_CENTS, type OfferProblem } from "../../domain/company/investors.ts";
import { formatCents } from "../../domain/economy.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import type { CapTableWire, InvestmentOffer, InvestmentProposal } from "../../storage/company-protocol.ts";
import type { Act } from "./Hiring.tsx";
import { percent } from "./percent.ts";

const OFFER_PROBLEM: Readonly<Record<OfferProblem, string>> = {
  self_offer: "You can’t invest in yourself.",
  below_minimum_investment: `An investment starts at ${formatCents(MIN_INVESTMENT_CENTS)}.`,
  too_much_equity: `One offer can’t sell more than ${MAX_OFFER_BPS / 100}%.`,
  founder_control: "That would leave you under 51% once your open offers are taken; the founder keeps control.",
};

type Props = {
  api: CompanyApi;
  capTable: CapTableWire;
  offers: readonly InvestmentOffer[];
  /** Players asking to invest; the founder accepts (it becomes an offer to them) or declines. */
  proposals: readonly InvestmentProposal[];
  isFounder: boolean;
  isBusy: boolean;
  act: Act;
};

/** Who owns the company; the founder offers stakes to other players for money into the company. */
export function Investors({ api, capTable, offers, proposals, isFounder, isBusy, act }: Props) {
  return (
    <section className="company__panel" aria-labelledby="investors-title">
      <h2 id="investors-title" className="admin__heading">
        Owners
      </h2>
      <table className="admin__table">
        <thead>
          <tr>
            <th scope="col">Owner</th>
            <th scope="col">Share</th>
            <th scope="col">Put in</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              {capTable.founder} <span className="admin__dim">· founder</span>
            </th>
            <td>{percent(capTable.founderBps)}</td>
            <td className="admin__dim">the seed</td>
          </tr>
          {capTable.holders.map((holder) => (
            <tr key={holder.username}>
              <th scope="row">{holder.username}</th>
              <td>{percent(holder.bps)}</td>
              <td>{formatCents(holder.investedCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="company__note">Every 7th work day, investors are paid their share of the week’s profit. The founder’s share stays in the company.</p>

      {isFounder && (
        <>
          {proposals.length > 0 && (
            <ul className="shop" aria-label="Asking to invest">
              {proposals.map((proposal) => (
                <li key={proposal.id} className="shop__item">
                  <span>
                    <strong>{proposal.investor}</strong>
                    <span className="admin__dim">
                      {" "}
                      wants {percent(proposal.equityBps)} for {formatCents(proposal.amountCents)} · values it at {formatCents(impliedValuationCents(proposal.amountCents, proposal.equityBps))}
                    </span>
                  </span>
                  <span className="hq__decide">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={isBusy}
                      onClick={() => void act(() => api.answerProposal(proposal.id, "accept"), () => `Accepted. ${proposal.investor} can now pay in.`)}
                    >
                      Accept
                    </button>
                    <button type="button" className="button button--quiet" disabled={isBusy} onClick={() => void act(() => api.answerProposal(proposal.id, "decline"), () => `Declined ${proposal.investor}.`)}>
                      Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {offers.length > 0 && (
            <ul className="shop" aria-label="Open offers">
              {offers.map((offer) => (
                <li key={offer.id} className="shop__item">
                  <span>
                    <strong>{offer.investor}</strong>
                    <span className="admin__dim">
                      {" "}
                      · {formatCents(offer.amountCents)} for {percent(offer.equityBps)} · values the company at {formatCents(impliedValuationCents(offer.amountCents, offer.equityBps))}
                    </span>
                  </span>
                  <button type="button" className="button button--quiet" disabled={isBusy} onClick={() => void act(() => api.cancelOffer(offer.id), () => `Withdrew the offer to ${offer.investor}.`)}>
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          )}
          <OfferForm
            capTable={capTable}
            open={offers}
            isBusy={isBusy}
            onOffer={(investor, amountCents, equityBps) =>
              void act(() => api.makeOffer({ investor, amountCents, equityBps }), () => `Offer sent to ${investor}. It shows on their company page.`)
            }
          />
        </>
      )}
    </section>
  );
}

function OfferForm({ capTable, open, isBusy, onOffer }: { capTable: CapTableWire; open: readonly InvestmentOffer[]; isBusy: boolean; onOffer: (investor: string, amountCents: number, equityBps: number) => void }) {
  const [investor, setInvestor] = useState("");
  const [dollars, setDollars] = useState(MIN_INVESTMENT_CENTS / 100);
  const [share, setShare] = useState(10);
  const amountCents = Math.round(dollars * 100);
  const equityBps = Math.round(share * 100);
  const problem = investor.trim() ? checkInvestmentOffer(capTable, { investor: investor.trim(), amountCents, equityBps }, open) : null;
  // As the control check counts it: every open offer taken, then this one.
  const kept = Math.round(founderAfter(capTable.founderBps, [...open, { equityBps }]));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem || !investor.trim()) return;
    onOffer(investor.trim(), amountCents, equityBps);
    setInvestor("");
  };

  return (
    <form className="hq__invite" onSubmit={submit}>
      <label className="home__name">
        <span>Offer a stake to</span>
        <input value={investor} maxLength={24} autoCapitalize="none" spellCheck={false} placeholder="username" onChange={(event) => setInvestor(event.target.value)} />
      </label>
      <label className="home__name">
        <span>For, dollars</span>
        <input type="number" inputMode="numeric" min={MIN_INVESTMENT_CENTS / 100} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      </label>
      <label className="home__name">
        <span>Share, %</span>
        <input type="number" inputMode="decimal" min={0.01} max={MAX_OFFER_BPS / 100} step={0.01} value={share} onChange={(event) => setShare(Number(event.target.value) || 0)} />
      </label>
      <button type="submit" className="button button--ghost" disabled={isBusy || problem !== null || !investor.trim()}>
        Send offer
      </button>
      <p className="company__note">
        {problem
          ? OFFER_PROBLEM[problem]
          : `Values the company at ${formatCents(impliedValuationCents(amountCents, equityBps))}; you’d keep ${percent(kept)}${open.length > 0 ? " if your open offers are taken too" : ""}. The money goes into the company, not to you.`}
      </p>
    </form>
  );
}
