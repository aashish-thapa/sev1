import { useState } from "react";
import { formatCents } from "../../domain/economy.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import type { DealWire } from "../../storage/company-protocol.ts";
import { companyErrorText } from "./errors.ts";
import { percent } from "./percent.ts";

type Props = {
  api: CompanyApi;
  deals: readonly DealWire[];
  username: string | null;
  /** Walk into the company's office for the meeting. */
  enterMeeting: (code: string, companyId: string) => void;
};

/** Investments waiting to be agreed in person: who you're meeting, about what, and the door. */
export function Deals({ api, deals, username, enterMeeting }: Props) {
  const [problem, setProblem] = useState<string | null>(null);
  const open = deals.filter((deal) => deal.stage === "talking");
  if (open.length === 0) return null;

  const go = async (deal: DealWire) => {
    setProblem(null);
    const meeting = await api.dealMeeting(deal.id);
    if (meeting.ok) enterMeeting(meeting.value.code, deal.companyId);
    else setProblem(companyErrorText(meeting.error, meeting.message));
  };

  return (
    <section className="company__panel" aria-labelledby="deals-title">
      <h2 id="deals-title" className="admin__heading">
        Meetings
      </h2>
      <ul className="shop">
        {open.map((deal) => (
          <li key={deal.id} className="shop__item">
            <span>
              <strong>{deal.founder === username ? deal.investor : deal.founder}</strong>
              <span className="admin__dim">
                {" "}
                · {percent(deal.terms.equityBps)} of {deal.companyName} for {formatCents(deal.terms.amountCents)}
              </span>
            </span>
            <button type="button" className="button button--primary" onClick={() => void go(deal)}>
              Go to the meeting
            </button>
          </li>
        ))}
      </ul>
      {problem && <p className="company__note">{problem}</p>}
    </section>
  );
}
