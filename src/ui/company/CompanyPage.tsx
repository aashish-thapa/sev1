import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccountContext } from "../../app/useAccount.ts";
import type { Role } from "../../domain/incident.ts";
import { formatCents } from "../../domain/economy.ts";
import type { CompanyApi, CompanyOutcome } from "../../storage/company-api.ts";
import type { Interview, InterviewAnswers, MyCompany, PendingPayout, Posting } from "../../storage/company-protocol.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import { InterviewView } from "../work/InterviewView.tsx";
import { CompanyDirectory } from "./CompanyDirectory.tsx";
import { MyApplications } from "./MyApplications.tsx";
import type { Task } from "../../domain/work/task.ts";
import { companyErrorText } from "./errors.ts";
import { FoundCompany } from "./FoundCompany.tsx";
import { Headquarters } from "./Headquarters.tsx";
import { Invitations } from "./Invitations.tsx";

export type CompanyPageProps = {
  api: CompanyApi;
  isSignedIn: boolean;
  username: string | null;
  walletCents: number;
  defaultRole: Role;
  /** Spends from the wallet against the server's funding ref; false if the balance is short. Repeating a ref is a no-op. */
  fundCompany: (fundingRef: string, cents: number) => boolean;
  /** Earns a booked salary into the wallet; claiming the same payout twice does nothing. */
  claimPayout: (payout: PendingPayout) => void;
  onSignUp: () => void;
  /** Daily-work tasks for the HQ's board. */
  tasks: readonly Task[];
  /** The local day, YYYY-MM-DD. */
  day: string;
  /** Joins the company's office room at `code`. */
  enterOffice: (code: string) => void;
};

/** Startup mode: found a company, answer offers, or run the one you're in. Accounts only. */
export function CompanyPage(props: CompanyPageProps) {
  const { api, isSignedIn, claimPayout } = props;
  const sync = useContext(AccountContext)?.sync ?? "local";
  const [mine, setMine] = useState<CompanyOutcome<MyCompany> | null>(null);
  // After a wallet move (funding) the company is re-read once that save has gone "saving" and then "saved",
  // so a "saved" left over from the save before isn't mistaken for this one.
  const awaiting = useRef<"nothing" | "move" | "save">("nothing");
  const setAwaitingSave = (isAwaiting: boolean) => {
    awaiting.current = isAwaiting ? "move" : "nothing";
  };

  const refresh = useCallback(async () => setMine(await api.mine()), [api]);
  const [interview, setInterview] = useState<{ interview: Interview; heading: string } | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = async (posting: Posting, companyName: string) => {
    setNotice(null);
    // Applying again returns the interview already under way, so leaving one doesn't lose it.
    const started = await api.apply(posting.id);
    if (started.ok) setInterview({ interview: started.value, heading: `${ROLE_INFO[posting.role].label} at ${companyName}` });
    else setNotice(companyErrorText(started.error, started.message));
  };

  const submit = async (taken: Interview, answers: InterviewAnswers["answers"]) => {
    setSubmitting(true);
    const graded = await api.answerInterview(taken.id, { answers });
    setSubmitting(false);
    setInterview(null);
    if (!graded.ok) return setNotice(companyErrorText(graded.error, graded.message));
    const { result, application } = graded.value;
    setNotice(
      `You got ${result.correct} of ${result.total} (${result.score}%). ` +
        (application.status === "rejected" ? `That’s under ${application.companyName}’s pass mark, so not this time.` : `${application.companyName} will decide; it shows under Your applications.`),
    );
    void refresh();
  };

  useEffect(() => {
    if (!isSignedIn) return;
    const controller = new AbortController();
    api.mine(controller.signal).then(setMine, () => undefined);
    return () => controller.abort();
  }, [api, isSignedIn]);

  // Pay the server booked lands in the wallet as soon as the page sees it.
  useEffect(() => {
    if (mine?.ok) for (const payout of mine.value.payouts) claimPayout(payout);
  }, [mine, claimPayout]);

  useEffect(() => {
    if (awaiting.current === "move" && sync === "saving") awaiting.current = "save";
    else if (awaiting.current === "save" && sync === "saved") {
      awaiting.current = "nothing";
      void refresh();
    }
  }, [refresh, sync]);

  if (!isSignedIn) {
    return (
      <section className="company" aria-labelledby="company-title">
        <h1 id="company-title" className="home__title company__title">
          Start a company
        </h1>
        <p className="company__lede">Found a tech company with the money you’ve earned, hire other players into real roles, and keep it running. Companies belong to accounts, so their money is safe on the server.</p>
        <button type="button" className="button button--primary company__cta" onClick={props.onSignUp}>
          Sign up to start one
        </button>
      </section>
    );
  }
  if (!mine) return <p className="admin__note">Loading your company…</p>;
  if (!mine.ok) return <p className="admin__note">{companyErrorText(mine.error, mine.message)}</p>;

  const { company, invitations, applications } = mine.value;
  if (interview) {
    return (
      <section className="company" aria-label="Interview">
        <InterviewView
          interview={interview.interview}
          heading={interview.heading}
          isSubmitting={isSubmitting}
          onSubmit={(answers) => void submit(interview.interview, answers)}
          onLeave={() => setInterview(null)}
        />
      </section>
    );
  }
  return (
    <section className="company" aria-label="Your company">
      {notice && (
        <p className="company__warning" role="status">
          {notice}
        </p>
      )}
      {company === null && <MyApplications applications={applications} />}
      {/* Without a company, joining one is the likelier first step: most players can't afford to found yet. */}
      {company === null && <CompanyDirectory api={api} onApply={(posting, name) => void apply(posting, name)} myApplications={applications} />}
      {invitations.length > 0 && <Invitations api={api} invitations={invitations} hasCompany={company !== null} onAnswered={refresh} />}
      {company === null ? (
        <FoundCompany
          api={api}
          walletCents={props.walletCents}
          defaultRole={props.defaultRole}
          onFounded={(fundingRef, seedCents) => {
            if (!props.fundCompany(fundingRef, seedCents)) return `Your wallet has ${formatCents(props.walletCents)}; the seed is more than that.`;
            setAwaitingSave(true);
            return null;
          }}
        />
      ) : company.state === "unfunded" && company.funding ? (
        <section className="company__panel">
          <h1 className="home__title company__title">{company.name}</h1>
          <p className="company__lede">
            Waiting for your {formatCents(company.funding.seedCents)} seed to reach the company. It moves when your progress next saves; if it doesn’t within a day, the company is cancelled and nothing is charged.
          </p>
          {sync === "offline" && <p className="company__warning">You’re offline, so the seed can’t reach the server yet. It goes as soon as you’re back.</p>}
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              const funding = company.funding;
              if (funding && props.fundCompany(funding.ref, funding.seedCents)) setAwaitingSave(true);
            }}
          >
            Send the seed again
          </button>
        </section>
      ) : (
        <Headquarters api={api} company={company} username={props.username} onChanged={refresh} tasks={props.tasks} day={props.day} enterOffice={props.enterOffice} />
      )}
      {company !== null && <CompanyDirectory api={api} onApply={null} myApplications={applications} />}
    </section>
  );
}
