import { useEffect, useState } from "react";
import type { Interview, InterviewAnswers } from "../../storage/company-protocol.ts";

type Answer = InterviewAnswers["answers"][number];
type Question = Interview["questions"][number];

type Props = {
  interview: Interview;
  /** What the posting is for, e.g. "Frontend at Ledgerly". */
  heading: string;
  isSubmitting: boolean;
  onSubmit: (answers: Answer[]) => void;
  onLeave: () => void;
};

/**
 * Takes an interview: every answer can be changed until it's sent, and nothing is graded here.
 * The answers go to the server, which holds the key.
 */
export function InterviewView({ interview, heading, isSubmitting, onSubmit, onLeave }: Props) {
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const secondsLeft = useSecondsUntil(interview.expiresAt);
  const answered = interview.questions.filter((question) => answers.has(question.id)).length;
  const isExpired = secondsLeft <= 0;

  const set = (answer: Answer) => setAnswers((current) => new Map(current).set(answer.taskId, answer));

  return (
    <section className="interview" aria-labelledby="interview-title">
      <header className="interview__head">
        <h1 id="interview-title" className="home__title company__title">
          Interview · {heading}
        </h1>
        <p className="company__lede">
          {interview.questions.length} questions. Answer what you can and send it; the company sees your score, not your answers.
        </p>
        <p className="interview__clock" role="timer" data-low={secondsLeft < 120}>
          {isExpired ? "Time’s up. This interview can’t be sent any more." : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} left`}
        </p>
      </header>
      <ol className="interview__questions">
        {interview.questions.map((question, index) => (
          <li key={question.id}>
            <p className="task__kind">
              Question {index + 1} of {interview.questions.length}
            </p>
            <QuestionView question={question} answer={answers.get(question.id) ?? null} onAnswer={set} />
          </li>
        ))}
      </ol>
      <div className="task__actions interview__actions">
        <button type="button" className="button button--primary" disabled={isSubmitting || isExpired || answered === 0} onClick={() => onSubmit([...answers.values()])}>
          {isSubmitting ? "Sending…" : answered < interview.questions.length ? `Send ${answered} of ${interview.questions.length} answers` : "Send answers"}
        </button>
        <button type="button" className="button button--quiet" onClick={onLeave}>
          Leave. You can come back to it before the time runs out.
        </button>
      </div>
    </section>
  );
}

function QuestionView({ question, answer, onAnswer }: { question: Question; answer: Answer | null; onAnswer: (answer: Answer) => void }) {
  return question.kind === "code-fix" ? (
    <CodeFixQuestion question={question} chosen={answer?.kind === "code-fix" ? answer : null} onAnswer={onAnswer} />
  ) : (
    <ReviewQuestion question={question} chosen={answer?.kind === "pr-review" ? answer : null} onAnswer={onAnswer} />
  );
}

/** Picking a line is only half an answer, so it stays here until a patch is chosen. */
function CodeFixQuestion({
  question,
  chosen,
  onAnswer,
}: {
  question: Extract<Question, { kind: "code-fix" }>;
  chosen: Extract<Answer, { kind: "code-fix" }> | null;
  onAnswer: (answer: Answer) => void;
}) {
  const [line, setLine] = useState<number | null>(chosen?.line ?? null);
  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">Bug fix · {question.file.path}</p>
        <h3 className="task__title">{question.title}</h3>
      </header>
      <p className="task__ticket">{question.ticket}</p>
      <pre className="task__output" aria-label={`Failing test: ${question.failing.test}`}>
        <span className="task__output-title">✕ {question.failing.test}</span>
        {"\n"}
        {question.failing.output.join("\n")}
      </pre>
      <p className="task__step">{line === null ? "1. Click the line that causes it." : "2. Pick the patch for that line."}</p>
      <ol className="code" aria-label={question.file.path}>
        {question.file.lines.map((text, index) => (
          <li key={index}>
            <button type="button" className="code__line" aria-pressed={line === index} onClick={() => setLine(index)}>
              <span className="code__number">{index + 1}</span>
              <span className="code__text">{text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      {line !== null && (
        <ul className="task__choices">
          {question.fixes.map((patch, shown) => (
            <li key={patch}>
              <button
                type="button"
                className="task__choice"
                aria-pressed={chosen?.line === line && chosen.fix === shown}
                onClick={() => onAnswer({ taskId: question.id, kind: "code-fix", line, fix: shown })}
              >
                <span className="task__choice-mark">−</span> <code>{question.file.lines[line]}</code>
                {"\n"}
                <span className="task__choice-mark">+</span> <code>{patch}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ReviewQuestion({
  question,
  chosen,
  onAnswer,
}: {
  question: Extract<Question, { kind: "pr-review" }>;
  chosen: Extract<Answer, { kind: "pr-review" }> | null;
  onAnswer: (answer: Answer) => void;
}) {
  const [isFlagging, setFlagging] = useState(false);
  const verdictText = chosen === null ? null : chosen.verdict === "approve" ? "You’ll approve it." : `You’ll request changes on line ${(chosen.flaggedLine ?? 0) + 1}.`;
  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">
          Pull request · {question.path} · by {question.author}
        </p>
        <h3 className="task__title">{question.title}</h3>
      </header>
      <p className="task__ticket">{question.description}</p>
      {isFlagging && <p className="task__step">Click the added line that breaks it.</p>}
      <ol className="code code--diff" aria-label={`Diff of ${question.path}`}>
        {question.diff.map((entry, index) => (
          <li key={index}>
            <button
              type="button"
              className="code__line"
              data-op={entry.op}
              aria-pressed={chosen?.flaggedLine === index}
              disabled={!isFlagging || entry.op !== "+"}
              onClick={() => {
                onAnswer({ taskId: question.id, kind: "pr-review", verdict: "request-changes", flaggedLine: index });
                setFlagging(false);
              }}
            >
              <span className="code__number">{entry.op}</span>
              <span className="code__text">{entry.text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="task__actions">
        <button
          type="button"
          className="button button--ghost"
          aria-pressed={chosen?.verdict === "approve"}
          onClick={() => {
            onAnswer({ taskId: question.id, kind: "pr-review", verdict: "approve", flaggedLine: null });
            setFlagging(false);
          }}
        >
          Approve
        </button>
        <button type="button" className="button button--ghost" aria-pressed={isFlagging || chosen?.verdict === "request-changes"} onClick={() => setFlagging(!isFlagging)}>
          {isFlagging ? "Cancel" : "Request changes"}
        </button>
      </div>
      {verdictText && <p className="company__note">{verdictText}</p>}
    </article>
  );
}

function useSecondsUntil(at: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((at - now) / 1000));
}
