import { useState } from "react";
import { categoryById } from "../../domain/company/catalog.ts";
import { formatCents } from "../../domain/economy.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import type { Company } from "../../storage/company-protocol.ts";
import { companyErrorText } from "./errors.ts";

/** Your company from the street: what it is, and the door. Running it happens at your desk inside. */
export function CompanyCard({
  api,
  company,
  username,
  enterOffice,
  onLeft,
}: {
  api: CompanyApi;
  company: Company;
  username: string | null;
  enterOffice: (code: string) => void;
  /** After you've left: the page offers founding and jobs again. */
  onLeft: () => void;
}) {
  const [isOpening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isLeaving, setLeaving] = useState(false);
  const isFounder = company.members.some((member) => member.isFounder && member.username === username);

  const leave = async () => {
    setOpening(true);
    const left = await api.leave();
    setOpening(false);
    if (left.ok) onLeft();
    else setProblem(companyErrorText(left.error, left.message));
  };

  const enter = async () => {
    setOpening(true);
    setProblem(null);
    const office = await api.enterOffice();
    setOpening(false);
    if (office.ok) enterOffice(office.value.code);
    else setProblem(companyErrorText(office.error, office.message));
  };

  return (
    <section className="company-card" aria-labelledby="company-card-title">
      <p className="company-card__kicker">
        {categoryById(company.category).title} · {company.levelTitle} · day {company.workDay}
      </p>
      <h1 id="company-card-title" className="home__title company__title">
        {company.name}
      </h1>
      <p className="company-card__funds">{formatCents(company.fundsCents)}</p>
      <button type="button" className="button button--primary company-card__door" disabled={isOpening} onClick={() => void enter()}>
        {isOpening ? "Opening…" : "Enter the office"}
      </button>
      {!isFounder &&
        (isLeaving ? (
          <span className="hq__decide">
            <button type="button" className="button button--ghost" disabled={isOpening} onClick={() => void leave()}>
              Leave {company.name}
            </button>
            <button type="button" className="button button--quiet" onClick={() => setLeaving(false)}>
              Stay
            </button>
          </span>
        ) : (
          <button type="button" className="button button--quiet" onClick={() => setLeaving(true)}>
            Leave company
          </button>
        ))}
      {problem && <p className="company__note">{problem}</p>}
    </section>
  );
}
