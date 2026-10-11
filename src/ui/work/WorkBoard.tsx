import { useEffect, useState } from "react";
import type { CompanyApi, CompanyOutcome } from "../../storage/company-api.ts";
import type { WorkBoard as Board, WorkItem, WorkResult } from "../../storage/company-protocol.ts";
import { companyErrorText } from "../company/errors.ts";
import { QuestionView, type Answer } from "./QuestionViews.tsx";

const VERDICT_TEXT: Readonly<Record<WorkResult["outcome"], string>> = {
  shipped: "Shipped. The test passes.",
  "wrong-line": "That line isn’t the cause.",
  "wrong-fix": "Right line, but that patch doesn’t fix it.",
  correct: "Good review.",
  "shipped-a-bug": "Approved, and the bug went out with it.",
  "blocked-a-good-pr": "This one was fine to merge.",
};

type Props = {
  api: CompanyApi;
  /** e.g. "Infra / SRE". */
  roleLabel: string;
  /** Bumped when the work day closes, so the shipped count is read again. */
  version: number;
};

/** Today's work for your company role, graded on the server: one try per task. */
export function WorkBoard({ api, roleLabel, version }: Props) {
  const [board, setBoard] = useState<CompanyOutcome<Board> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.work(controller.signal).then(setBoard, () => undefined);
    return () => controller.abort();
  }, [api, version]);

  if (!board) return <p className="company__note">Loading today’s work…</p>;
  if (!board.ok) return <p className="company__note">{companyErrorText(board.error, board.message)}</p>;

  const { items, shippedSinceClose } = board.value;
  const graded = (item: WorkItem) =>
    setBoard((current) =>
      current?.ok
        ? {
            ...current,
            value: {
              ...current.value,
              items: current.value.items.map((existing) => (existing.question.id === item.question.id ? item : existing)),
              shippedSinceClose: current.value.shippedSinceClose + (item.result?.isDone ? 1 : 0),
            },
          }
        : current,
    );

  if (items.length === 0) return <p className="company__note">No {roleLabel} tasks for this company yet.</p>;
  const mineShipped = items.filter((item) => item.result?.isDone).length;
  return (
    <section className="company__panel" aria-label={`Today’s work, ${roleLabel}`}>
      <p className="company__note">
        {roleLabel} · {mineShipped}/{items.length} shipped · team {shippedSinceClose} · one try each
      </p>
      <ul className="work">
        {items.map((item) => {
          const isOpen = openId === item.question.id;
          return (
            <li key={item.question.id} className="work__item" data-shipped={item.result?.isDone ?? false}>
              <button type="button" className="work__toggle" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : item.question.id)}>
                <span className="work__kind">{item.question.kind === "code-fix" ? "Bug" : "Review"}</span>
                <span className="work__title">{item.question.title}</span>
                <span className="work__state">{item.result === null ? "open" : item.result.isDone ? "✓ shipped" : "✕ missed"}</span>
              </button>
              {isOpen && <WorkTask api={api} item={item} onGraded={graded} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WorkTask({ api, item, onGraded }: { api: CompanyApi; item: WorkItem; onGraded: (item: WorkItem) => void }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [isSending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { result } = item;

  const submit = async () => {
    if (!answer) return;
    setSending(true);
    setProblem(null);
    const outcome = await api.answerWork(answer);
    setSending(false);
    if (outcome.ok) onGraded(outcome.value);
    else setProblem(companyErrorText(outcome.error, outcome.message));
  };

  return (
    <div className="work__task">
      <QuestionView question={item.question} answer={answer} onAnswer={setAnswer} graded={result ? { line: result.reveal.line } : null} />
      {result ? (
        <div className="task__verdict" data-done={result.isDone} role="status">
          <p className="task__verdict-title">
            <span aria-hidden="true">{result.isDone ? "✓ " : "✕ "}</span>
            {VERDICT_TEXT[result.outcome]}
          </p>
          <p>{result.reveal.cause}</p>
          <p className="task__why">{result.reveal.why}</p>
        </div>
      ) : (
        <div className="task__actions">
          <button type="button" className="button button--primary" disabled={!answer || isSending} onClick={() => void submit()}>
            {isSending ? "Sending…" : item.question.kind === "code-fix" ? "Ship this patch" : "Submit review"}
          </button>
          {problem && <p className="company__note">{problem}</p>}
        </div>
      )}
    </div>
  );
}
