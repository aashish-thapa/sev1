import { useState, type FormEvent } from "react";
import { ROLE_MINIMUM_PAY_CENTS } from "../../domain/company/catalog.ts";
import { TITLES, type Level } from "../../domain/career.ts";
import { formatCents } from "../../domain/economy.ts";
import { ROLE_IDS, type Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import { INTERVIEW_LENGTH } from "../../domain/work/interview.ts";
import type { CompanyApi, CompanyOutcome } from "../../storage/company-api.ts";
import type { Company } from "../../storage/company-protocol.ts";

export type Act = <T>(work: () => Promise<CompanyOutcome<T>>, done: (value: T) => string) => Promise<void>;

/** Pass marks a posting can ask for, as answers right out of the interview. */
const PASS_MARKS = Array.from({ length: INTERVIEW_LENGTH + 1 }, (_, correct) => ({
  score: Math.round((correct / INTERVIEW_LENGTH) * 100),
  label: correct === 0 ? "Anyone who sits it" : correct === INTERVIEW_LENGTH ? `All ${INTERVIEW_LENGTH} right` : `${correct} of ${INTERVIEW_LENGTH} right`,
}));

type Props = { api: CompanyApi; company: Company; isBusy: boolean; act: Act };

/** Open roles and the people who interviewed for them. Shown to the founder and hiring managers. */
export function Hiring({ api, company, isBusy, act }: Props) {
  const postingById = new Map(company.postings.map((posting) => [posting.id, posting]));
  const pending = company.applications.filter((application) => application.status === "pending");
  const decided = company.applications.filter((application) => application.status !== "pending");

  return (
    <section className="company__panel" aria-labelledby="hiring-title">
      <h2 id="hiring-title" className="admin__heading">
        Hiring
      </h2>
      <p className="company__note">Applicants take a {INTERVIEW_LENGTH}-question interview; you see the score.</p>

      {company.postings.length > 0 && (
        <ul className="shop">
          {company.postings.map((posting) => (
            <li key={posting.id} className="shop__item">
              <span>
                <strong>{ROLE_INFO[posting.role].label}</strong>
                <span className="admin__dim">
                  {" "}
                  · {formatCents(posting.payCents)} a day · {TITLES[posting.minCareerLevel]} or above · pass mark {posting.minScore}%
                </span>
              </span>
              <button
                type="button"
                className="button button--quiet"
                disabled={isBusy}
                onClick={() => void act(() => api.closePosting(posting.id), () => `Closed the ${ROLE_INFO[posting.role].label} role.`)}
              >
                Close role
              </button>
            </li>
          ))}
        </ul>
      )}

      <PostingForm isBusy={isBusy} onOpen={(request) => void act(() => api.openPosting(request), () => `${ROLE_INFO[request.role].label} role is open. It shows on the company list.`)} />

      <h3 className="hq__subheading">Applicants</h3>
      {pending.length === 0 ? (
        <p className="company__note">{company.postings.length === 0 ? "Open a role to get applicants." : "Nobody waiting. Applicants who pass the interview show up here."}</p>
      ) : (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">For</th>
              <th scope="col">Career</th>
              <th scope="col">Interview</th>
              <th scope="col">
                <span className="admin__dim">Decision</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pending.map((application) => {
              const posting = postingById.get(application.postingId);
              return (
                <tr key={application.id}>
                  <th scope="row">{application.username}</th>
                  <td>{posting ? `${ROLE_INFO[posting.role].label}, ${formatCents(posting.payCents)}` : "a closed role"}</td>
                  <td>{application.careerTitle}</td>
                  <td>{application.score}%</td>
                  <td className="hq__decide">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={isBusy}
                      onClick={() => void act(() => api.decide(application.id, "hire"), () => `Hired ${application.username}. They’re on the staff list now.`)}
                    >
                      Hire
                    </button>
                    <button type="button" className="button button--quiet" disabled={isBusy} onClick={() => void act(() => api.decide(application.id, "reject"), () => `Passed on ${application.username}.`)}>
                      Pass
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {decided.length > 0 && (
        <p className="company__note">
          Earlier: {decided.length} decided ({decided.filter((application) => application.status === "hired").length} hired). Applicants below a pass mark are turned down
          automatically.
        </p>
      )}
    </section>
  );
}

function PostingForm({ isBusy, onOpen }: { isBusy: boolean; onOpen: (request: { role: Role; payCents: number; minCareerLevel: Level; minScore: number }) => void }) {
  const [role, setRole] = useState<Role>("frontend");
  const [dollars, setDollars] = useState(ROLE_MINIMUM_PAY_CENTS.frontend / 100);
  const [minCareerLevel, setMinCareerLevel] = useState<Level>(0);
  const [minScore, setMinScore] = useState(PASS_MARKS[2].score);
  const minimum = ROLE_MINIMUM_PAY_CENTS[role] / 100;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dollars < minimum) return;
    onOpen({ role, payCents: dollars * 100, minCareerLevel, minScore });
  };

  return (
    <form className="hq__invite" onSubmit={submit}>
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
        <input type="number" inputMode="numeric" min={minimum} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      </label>
      <label className="home__name">
        <span>Who can apply</span>
        <select value={minCareerLevel} onChange={(event) => setMinCareerLevel(Number(event.target.value) as Level)}>
          {TITLES.map((title, level) => (
            <option key={title} value={level}>
              {level === 0 ? "Anyone" : `${title} or above`}
            </option>
          ))}
        </select>
      </label>
      <label className="home__name">
        <span>Pass mark</span>
        <select value={minScore} onChange={(event) => setMinScore(Number(event.target.value))}>
          {PASS_MARKS.map((mark) => (
            <option key={mark.score} value={mark.score}>
              {mark.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button button--ghost" disabled={isBusy || dollars < minimum}>
        Open role
      </button>
      {dollars < minimum && <p className="company__note">That’s below the minimum for the role.</p>}
    </form>
  );
}
