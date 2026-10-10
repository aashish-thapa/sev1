import { useState } from "react";
import { categoryById } from "../../domain/company/catalog.ts";
import { formatCents } from "../../domain/economy.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import { companyErrorText } from "./errors.ts";
import type { ReceivedInvitation } from "../../storage/company-protocol.ts";

type Props = {
  api: CompanyApi;
  invitations: readonly ReceivedInvitation[];
  /** You can only work at one company; with one already, offers can be declined but not accepted. */
  hasCompany: boolean;
  onAnswered: () => void;
};

/** Job offers from other players' companies: a role, a daily pay, accept or decline. */
export function Invitations({ api, invitations, hasCompany, onAnswered }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const answer = async (id: string, choice: "accept" | "decline") => {
    setBusy(id);
    setProblem(null);
    const outcome = await api.respond(id, choice);
    setBusy(null);
    if (!outcome.ok) setProblem(companyErrorText(outcome.error, outcome.message));
    onAnswered();
  };

  return (
    <section className="company__panel" aria-labelledby="offers-title">
      <h2 id="offers-title" className="admin__heading">
        Job offers
      </h2>
      <ul className="offers">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="offers__row">
            <span className="offers__text">
              <strong>{invitation.companyName}</strong> ({categoryById(invitation.category).title}) wants you as{" "}
              <strong>{ROLE_INFO[invitation.role].label}</strong> for {formatCents(invitation.payCents)} a work day. From {invitation.from}.
            </span>
            <span className="offers__actions">
              <button type="button" className="button button--primary" disabled={hasCompany || busy !== null} onClick={() => void answer(invitation.id, "accept")}>
                Accept
              </button>
              <button type="button" className="button button--quiet" disabled={busy !== null} onClick={() => void answer(invitation.id, "decline")}>
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="company__note" role="status">
        {problem ?? (hasCompany ? "You already work at a company, so for now you can only decline." : "")}
      </p>
    </section>
  );
}
