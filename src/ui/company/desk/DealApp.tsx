import { useState } from "react";
import { impliedValuationCents, MAX_OFFER_BPS, MIN_INVESTMENT_CENTS } from "../../../domain/company/investors.ts";
import { formatCents } from "../../../domain/economy.ts";
import type { CompanyApi, CompanyOutcome } from "../../../storage/company-api.ts";
import type { DealWire } from "../../../storage/company-protocol.ts";
import { companyErrorText } from "../errors.ts";
import { percent } from "../percent.ts";

type Props = { api: CompanyApi; deals: readonly DealWire[]; username: string | null; onChanged: () => void };

/** The term sheet on the meeting table: change it, agree to it, or walk away. It closes when both agree. */
export function DealApp({ api, deals, username, onChanged }: Props) {
  return (
    <div className="desk">
      {deals.map((deal) => (
        <TermSheet key={deal.id} api={api} deal={deal} username={username} onChanged={onChanged} />
      ))}
    </div>
  );
}

function TermSheet({ api, deal, username, onChanged }: { api: CompanyApi; deal: DealWire; username: string | null; onChanged: () => void }) {
  const party = deal.founder === username ? "founder" : "investor";
  const [dollars, setDollars] = useState(deal.terms.amountCents / 100);
  const [share, setShare] = useState(deal.terms.equityBps / 100);
  const [isBusy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLeaving, setLeaving] = useState(false);
  const draft = { amountCents: Math.round(dollars * 100), equityBps: Math.round(share * 100) };
  const isEdited = draft.amountCents !== deal.terms.amountCents || draft.equityBps !== deal.terms.equityBps;
  const isValid = draft.amountCents >= MIN_INVESTMENT_CENTS && draft.equityBps >= 1 && draft.equityBps <= MAX_OFFER_BPS;
  const haveAgreed = deal.agreed.includes(party);

  const run = async (work: () => Promise<CompanyOutcome<unknown>>, done: string) => {
    setBusy(true);
    setNotice(null);
    const outcome = await work();
    setBusy(false);
    setNotice(outcome.ok ? done : companyErrorText(outcome.error, outcome.message));
    onChanged();
  };

  if (deal.stage === "agreed") {
    return (
      <article className="deal" data-stage="agreed">
        <p className="deal__title">
          ✓ {percent(deal.terms.equityBps)} of {deal.companyName} for {formatCents(deal.terms.amountCents)}
        </p>
        <p className="company__note">{party === "investor" ? "Agreed. Paying from your wallet; it’s yours once your progress saves." : `Agreed. ${deal.investor} is paying in.`}</p>
      </article>
    );
  }
  if (deal.stage === "walked-away") return null;

  return (
    <article className="deal" aria-label={`Investment in ${deal.companyName}`}>
      <p className="deal__title">
        {deal.investor} investing in {deal.companyName}
      </p>
      <div className="hq__invite">
        <label className="home__name">
          <span>Amount, dollars</span>
          <input type="number" inputMode="numeric" min={MIN_INVESTMENT_CENTS / 100} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
        </label>
        <label className="home__name">
          <span>Share, %</span>
          <input type="number" inputMode="decimal" min={0.01} max={MAX_OFFER_BPS / 100} step={0.01} value={share} onChange={(event) => setShare(Number(event.target.value) || 0)} />
        </label>
        {isEdited && (
          <button type="button" className="button button--ghost" disabled={isBusy || !isValid} onClick={() => void run(() => api.tableTerms(deal.id, draft), "New terms on the table.")}>
            Table these terms
          </button>
        )}
      </div>
      <p className="company__note">
        {isEdited ? "Not on the table yet." : `On the table: values ${deal.companyName} at ${formatCents(impliedValuationCents(deal.terms.amountCents, deal.terms.equityBps))}.`}
      </p>
      <ul className="deal__parties">
        <li data-agreed={deal.agreed.includes("founder")}>
          {deal.agreed.includes("founder") ? "✓" : "○"} {deal.founder}, founder
        </li>
        <li data-agreed={deal.agreed.includes("investor")}>
          {deal.agreed.includes("investor") ? "✓" : "○"} {deal.investor}, investor
        </li>
      </ul>
      <div className="task__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={isBusy || isEdited || haveAgreed}
          onClick={() => void run(() => api.agreeDeal(deal.id, deal.terms), "You’ve agreed. Waiting on the other side.")}
        >
          {haveAgreed ? "Agreed" : "Agree to these terms"}
        </button>
        {isLeaving ? (
          <>
            <button type="button" className="button button--ghost" disabled={isBusy} onClick={() => void run(() => api.walkAway(deal.id), "You walked away.")}>
              Walk away for good
            </button>
            <button type="button" className="button button--quiet" onClick={() => setLeaving(false)}>
              Keep talking
            </button>
          </>
        ) : (
          <button type="button" className="button button--quiet" onClick={() => setLeaving(true)}>
            Walk away
          </button>
        )}
      </div>
      <p className="company__note" role="status">
        {notice}
      </p>
    </article>
  );
}
