import { useState, type FormEvent } from "react";
import { impliedValuationCents, MAX_OFFER_BPS, MIN_INVESTMENT_CENTS } from "../../domain/company/investors.ts";
import { formatCents } from "../../domain/economy.ts";

/** Ask a founder to let you invest: how much, for what share. The founder's answer turns it into an offer to you. */
export function ProposeForm({ isBusy, onPropose, onCancel }: { isBusy: boolean; onPropose: (amountCents: number, equityBps: number) => void; onCancel: () => void }) {
  const [dollars, setDollars] = useState(MIN_INVESTMENT_CENTS / 100);
  const [share, setShare] = useState(5);
  const amountCents = Math.round(dollars * 100);
  const equityBps = Math.round(share * 100);
  const problem =
    amountCents < MIN_INVESTMENT_CENTS ? `At least ${formatCents(MIN_INVESTMENT_CENTS)}.` : equityBps < 1 || equityBps > MAX_OFFER_BPS ? `Up to ${MAX_OFFER_BPS / 100}%.` : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!problem) onPropose(amountCents, equityBps);
  };

  return (
    <form className="hq__invite directory__propose" onSubmit={submit}>
      <label className="home__name">
        <span>Invest, dollars</span>
        <input type="number" inputMode="numeric" min={MIN_INVESTMENT_CENTS / 100} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      </label>
      <label className="home__name">
        <span>For, %</span>
        <input type="number" inputMode="decimal" min={0.01} max={MAX_OFFER_BPS / 100} step={0.01} value={share} onChange={(event) => setShare(Number(event.target.value) || 0)} />
      </label>
      <button type="submit" className="button button--ghost" disabled={isBusy || problem !== null}>
        Propose
      </button>
      <button type="button" className="button button--quiet" onClick={onCancel}>
        Cancel
      </button>
      <p className="company__note">{problem ?? `Values it at ${formatCents(impliedValuationCents(amountCents, equityBps))}.`}</p>
    </form>
  );
}
