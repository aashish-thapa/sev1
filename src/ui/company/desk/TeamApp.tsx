import { useState, type FormEvent } from "react";
import { ROLE_MINIMUM_PAY_CENTS } from "../../../domain/company/catalog.ts";
import { checkOffer, type CompanyBook } from "../../../domain/company/rules.ts";
import { formatCents } from "../../../domain/economy.ts";
import { ROLE_IDS, type Role } from "../../../domain/incident.ts";
import { ROLE_INFO } from "../../../domain/roles.ts";
import { Hiring } from "../Hiring.tsx";
import { useCompanyAction, useDesk, type CompanyDesk } from "./desk.ts";

const OFFER_PROBLEM: Readonly<Record<"below_minimum" | "no_free_desk", string>> = {
  below_minimum: "Below the role’s minimum.",
  no_free_desk: "No free desk; buy another bay.",
};

/** The people: staff and pay, direct offers, and (for whoever hires) open roles and applicants. */
export function TeamApp({ desk }: { desk: CompanyDesk }) {
  const { api, company } = desk;
  const { isFounder, canHire, book } = useDesk(desk);
  const { act, notice, isBusy } = useCompanyAction(desk.refresh);

  return (
    <div className="desk">
      <table className="admin__table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Pay a day</th>
          </tr>
        </thead>
        <tbody>
          {company.members.map((member) => (
            <tr key={member.username}>
              <th scope="row">
                {member.username}
                {member.isFounder && <span className="admin__dim"> · founder</span>}
                {isFounder && !member.isFounder ? (
                  <label className="hq__toggle">
                    <input
                      type="checkbox"
                      checked={member.canHire}
                      disabled={isBusy}
                      onChange={(event) => {
                        const next = event.target.checked;
                        void act(
                          () => api.setMember({ username: member.username, role: member.role, payCents: member.payCents, canHire: next }),
                          () => (next ? `${member.username} can hire now.` : `${member.username} no longer hires.`),
                        );
                      }}
                    />{" "}
                    Can hire
                  </label>
                ) : (
                  !member.isFounder && member.canHire && <span className="admin__dim"> · hires</span>
                )}
              </th>
              <td>{ROLE_INFO[member.role].label}</td>
              <td>
                {isFounder ? (
                  <PayEditor
                    role={member.role}
                    payCents={member.payCents}
                    disabled={isBusy}
                    onSave={(payCents) => void act(() => api.setMember({ username: member.username, role: member.role, payCents }), () => `${member.username}: ${formatCents(payCents)} a day.`)}
                  />
                ) : (
                  formatCents(member.payCents)
                )}
              </td>
            </tr>
          ))}
          {company.pendingInvitations.map((invitation) => (
            <tr key={invitation.id} className="hq__pending">
              <th scope="row">
                {invitation.username} <span className="admin__dim">· offered</span>
              </th>
              <td>{ROLE_INFO[invitation.role].label}</td>
              <td>{formatCents(invitation.payCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isFounder && (
        <InviteForm
          book={book}
          pending={company.pendingInvitations.length}
          disabled={isBusy}
          onInvite={(username, role, payCents) => void act(() => api.invite({ username, role, payCents }), () => `Offer sent to ${username}.`)}
        />
      )}
      {canHire && <Hiring api={api} company={company} isBusy={isBusy} act={act} />}
      <p className="company__note" role="status">
        {notice}
      </p>
    </div>
  );
}

function PayEditor({ role, payCents, disabled, onSave }: { role: Role; payCents: number; disabled: boolean; onSave: (payCents: number) => void }) {
  const [dollars, setDollars] = useState(Math.round(payCents / 100));
  const minimum = ROLE_MINIMUM_PAY_CENTS[role] / 100;
  return (
    <span className="hq__pay">
      <input type="number" inputMode="numeric" min={minimum} value={dollars} aria-label="Pay a day, dollars" onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      <button type="button" className="button button--quiet" disabled={disabled || dollars < minimum || dollars * 100 === payCents} onClick={() => onSave(dollars * 100)}>
        Save
      </button>
    </span>
  );
}

function InviteForm({ book, pending, disabled, onInvite }: { book: CompanyBook; pending: number; disabled: boolean; onInvite: (username: string, role: Role, payCents: number) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("frontend");
  const [dollars, setDollars] = useState(ROLE_MINIMUM_PAY_CENTS.frontend / 100);
  const problem = checkOffer(book, role, dollars * 100, pending);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem || !username.trim()) return;
    onInvite(username.trim(), role, dollars * 100);
    setUsername("");
  };

  return (
    <form className="hq__invite" onSubmit={submit}>
      <label className="home__name">
        <span>Offer a job to</span>
        <input value={username} maxLength={24} autoCapitalize="none" spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label className="home__name">
        <span>Role</span>
        <select
          value={role}
          onChange={(event) => {
            const next = event.target.value as Role;
            setRole(next);
            setDollars(Math.max(dollars, ROLE_MINIMUM_PAY_CENTS[next] / 100));
          }}
        >
          {ROLE_IDS.map((option) => (
            <option key={option} value={option}>
              {ROLE_INFO[option].label} (min {formatCents(ROLE_MINIMUM_PAY_CENTS[option])})
            </option>
          ))}
        </select>
      </label>
      <label className="home__name">
        <span>Pay a day, dollars</span>
        <input type="number" inputMode="numeric" min={ROLE_MINIMUM_PAY_CENTS[role] / 100} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      </label>
      <button type="submit" className="button button--ghost" disabled={disabled || problem !== null || !username.trim()}>
        Send offer
      </button>
      {problem && <p className="company__note">{OFFER_PROBLEM[problem]}</p>}
    </form>
  );
}
