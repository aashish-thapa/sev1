import { useEffect, useState } from "react";
import { CATEGORIES, categoryById, type CategoryId } from "../../domain/company/catalog.ts";
import { TITLES } from "../../domain/career.ts";
import { formatCents } from "../../domain/economy.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { CompanyApi, CompanyOutcome } from "../../storage/company-api.ts";
import type { CompanySummary, MyApplication, MyProposal, Posting } from "../../storage/company-protocol.ts";
import { ProposeForm } from "./ProposeForm.tsx";
import { Sparkline } from "./Sparkline.tsx";

/** The week's move, with an arrow and a sign so it never rests on colour alone. */
function WeekChange({ bps }: { bps: number | null }) {
  if (bps === null) return <span className="admin__dim">new</span>;
  const direction = bps > 0 ? "up" : bps < 0 ? "down" : "flat";
  return (
    <span className="directory__change" data-direction={direction}>
      {direction === "up" ? "▲" : direction === "down" ? "▼" : "■"} {bps > 0 ? "+" : ""}
      {(bps / 100).toFixed(1)}% <span className="admin__dim">7d</span>
    </span>
  );
}
import { companyErrorText } from "./errors.ts";

/** Pause after typing before searching, so each keystroke isn't a query. */
const SEARCH_DELAY_MS = 300;

type Props = {
  api: CompanyApi;
  /** Null when you can't apply (you're already in a company); otherwise starts the interview. */
  onApply: ((posting: Posting, companyName: string) => void) | null;
  myApplications: readonly MyApplication[];
  /** Null for guests. Otherwise lets you ask any company but your own to take your money. */
  investing: { readonly ownCompanyId: string | null; readonly proposals: readonly MyProposal[]; readonly propose: (companyId: string, amountCents: number, equityBps: number) => Promise<string | null> } | null;
};

/** The company leaderboard, and search across every funded company with its open roles. */
export function CompanyDirectory({ api, onApply, myApplications, investing }: Props) {
  const [proposingTo, setProposingTo] = useState<string | null>(null);
  const [isProposing, setProposing] = useState(false);
  const [proposalNote, setProposalNote] = useState<{ companyId: string; text: string } | null>(null);
  const proposedTo = new Set(investing?.proposals.map((proposal) => proposal.companyId) ?? []);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [list, setList] = useState<CompanyOutcome<readonly CompanySummary[]> | null>(null);
  const isSearching = query.trim() !== "" || category !== null;

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        const read = isSearching ? api.search(query.trim(), category, controller.signal) : api.top(controller.signal);
        read.then(setList, () => undefined);
      },
      isSearching ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, category, isSearching]);

  const appliedTo = new Set(myApplications.map((application) => application.postingId));

  return (
    <section className="company__panel directory" aria-labelledby="directory-title">
      <h2 id="directory-title" className="admin__heading">
        {isSearching ? "Companies" : "Top companies"}
      </h2>
      <p className="company__note">{isSearching ? null : "By revenue, last 7 work days."}</p>
      <div className="directory__filters">
        <label className="home__name">
          <span>Find a company</span>
          <input value={query} maxLength={40} placeholder="Name" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="home__name">
          <span>Category</span>
          <select value={category ?? ""} onChange={(event) => setCategory((event.target.value || null) as CategoryId | null)}>
            <option value="">Any</option>
            {CATEGORIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!list ? (
        <p className="company__note">Loading…</p>
      ) : !list.ok ? (
        <p className="company__note">{companyErrorText(list.error, list.message)}</p>
      ) : list.value.length === 0 ? (
        <p className="company__note">{isSearching ? "No company matches." : "No company has closed a work day yet. Found one and be first."}</p>
      ) : (
        <ol className="directory__list">
          {list.value.map((company, index) => (
            <li key={company.id} className="directory__row">
              <div className="directory__main">
                {!isSearching && <span className="directory__rank">{index + 1}</span>}
                <div>
                  <p className="directory__name">{company.name}</p>
                  <p className="admin__dim">
                    {categoryById(company.category).title} · {company.levelTitle} · {company.members} {company.members === 1 ? "person" : "people"} · founded by {company.founder}
                  </p>
                </div>
                <div className="directory__market">
                  {company.valuationCents > 0 && (
                    <>
                      <Sparkline points={company.valuationHistory} label={`${company.name}’s valuation`} />
                      <span className="directory__valuation">
                        {company.lastRound && (
                          <span className="directory__round">
                            Last round {formatCents(company.lastRound.valuationCents)} <span className="admin__dim">· day {company.lastRound.workDay}</span>
                          </span>
                        )}
                        <span className="directory__worth">
                          {formatCents(company.valuationCents)} <span className="admin__dim">now</span>
                        </span>
                        <WeekChange bps={company.weekChangeBps} />
                      </span>
                    </>
                  )}
                  <span className="directory__revenue">
                    {formatCents(company.revenue7dCents)}
                    <span className="admin__dim"> revenue, 7d</span>
                  </span>
                </div>
              </div>
              {investing && company.id !== investing.ownCompanyId && (
                <div className="directory__invest">
                  {proposedTo.has(company.id) ? (
                    <span className="admin__dim">Proposal sent</span>
                  ) : proposingTo === company.id ? (
                    <ProposeForm
                      isBusy={isProposing}
                      onCancel={() => setProposingTo(null)}
                      onPropose={async (amountCents, equityBps) => {
                        setProposing(true);
                        const problem = await investing.propose(company.id, amountCents, equityBps);
                        setProposing(false);
                        if (problem) setProposalNote({ companyId: company.id, text: problem });
                        else setProposingTo(null);
                      }}
                    />
                  ) : (
                    <button type="button" className="button button--quiet" onClick={() => setProposingTo(company.id)}>
                      Offer to invest
                    </button>
                  )}
                  {proposalNote?.companyId === company.id && <p className="company__note">{proposalNote.text}</p>}
                </div>
              )}
              {company.postings.length > 0 && (
                <ul className="directory__postings" aria-label={`Open roles at ${company.name}`}>
                  {company.postings.map((posting) => (
                    <li key={posting.id} className="directory__posting">
                      <span>
                        <strong>{ROLE_INFO[posting.role].label}</strong>
                        <span className="admin__dim">
                          {" "}
                          · {formatCents(posting.payCents)} a day · {TITLES[posting.minCareerLevel]} or above · pass mark {posting.minScore}%
                        </span>
                      </span>
                      {onApply &&
                        (appliedTo.has(posting.id) ? (
                          <span className="admin__dim">Applied</span>
                        ) : (
                          <button type="button" className="button button--ghost" onClick={() => onApply(posting, company.name)}>
                            Apply: take the interview
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
