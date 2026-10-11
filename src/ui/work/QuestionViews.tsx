import { useState } from "react";
import type {
  InterviewAnswers,
  WorkItem,
} from "../../storage/company-protocol.ts";

/** A question's answer as it will be sent; a bug fix's `fix` indexes the patches as shown. */
export type Answer = InterviewAnswers["answers"][number];
type Question = WorkItem["question"];
/** Once graded, the answer is locked and the real bug or flaw line is marked (null for a clean PR). */
type Graded = { readonly line: number | null };

/** A question to answer: nothing is graded here; the answer goes to the server, which holds the key. */
export function QuestionView({
  question,
  answer,
  onAnswer,
  graded = null,
}: {
  question: Question;
  answer: Answer | null;
  onAnswer: (answer: Answer) => void;
  graded?: Graded | null;
}) {
  return question.kind === "code-fix" ? (
    <CodeFixQuestion
      question={question}
      chosen={answer?.kind === "code-fix" ? answer : null}
      onAnswer={onAnswer}
      graded={graded}
    />
  ) : (
    <ReviewQuestion
      question={question}
      chosen={answer?.kind === "pr-review" ? answer : null}
      onAnswer={onAnswer}
      graded={graded}
    />
  );
}

/** Picking a line is only half an answer, so it stays here until a patch is chosen. */
function CodeFixQuestion({
  question,
  chosen,
  onAnswer,
  graded,
}: {
  question: Extract<Question, { kind: "code-fix" }>;
  chosen: Extract<Answer, { kind: "code-fix" }> | null;
  onAnswer: (answer: Answer) => void;
  graded: Graded | null;
}) {
  const [line, setLine] = useState<number | null>(chosen?.line ?? null);
  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">Bug fix · {question.file.path}</p>
        <h3 className="task__title">{question.title}</h3>
      </header>
      <p className="task__ticket">{question.ticket}</p>
      <pre
        className="task__output"
        aria-label={`Failing test: ${question.failing.test}`}
      >
        <span className="task__output-title">✕ {question.failing.test}</span>
        {"\n"}
        {question.failing.output.join("\n")}
      </pre>
      {!graded && (
        <p className="task__step">
          {line === null
            ? "1. Click the line that causes it."
            : "2. Pick the patch for that line."}
        </p>
      )}
      <ol className="code" aria-label={question.file.path}>
        {question.file.lines.map((text, index) => (
          <li key={index}>
            <button
              type="button"
              className="code__line"
              aria-pressed={line === index}
              data-answer={graded?.line === index}
              disabled={graded !== null}
              onClick={() => setLine(index)}
            >
              <span className="code__number">{index + 1}</span>
              <span className="code__text">{text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      {line !== null && !graded && (
        <ul className="task__choices">
          {question.fixes.map((patch, shown) => (
            <li key={patch}>
              <button
                type="button"
                className="task__choice"
                aria-pressed={chosen?.line === line && chosen.fix === shown}
                onClick={() =>
                  onAnswer({
                    taskId: question.id,
                    kind: "code-fix",
                    line,
                    fix: shown,
                  })
                }
              >
                <span className="task__choice-mark">−</span>{" "}
                <code>{question.file.lines[line]}</code>
                {"\n"}
                <span className="task__choice-mark">+</span>{" "}
                <code>{patch}</code>
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
  graded,
}: {
  question: Extract<Question, { kind: "pr-review" }>;
  chosen: Extract<Answer, { kind: "pr-review" }> | null;
  onAnswer: (answer: Answer) => void;
  graded: Graded | null;
}) {
  const [isFlagging, setFlagging] = useState(false);
  const verdictText =
    chosen === null
      ? null
      : chosen.verdict === "approve"
        ? "You’ll approve it."
        : `You’ll request changes on line ${(chosen.flaggedLine ?? 0) + 1}.`;
  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">
          Pull request · {question.path} · by {question.author}
        </p>
        <h3 className="task__title">{question.title}</h3>
      </header>
      <p className="task__ticket">{question.description}</p>
      {isFlagging && (
        <p className="task__step">Click the added line that breaks it.</p>
      )}
      <ol className="code code--diff" aria-label={`Diff of ${question.path}`}>
        {question.diff.map((entry, index) => (
          <li key={index}>
            <button
              type="button"
              className="code__line"
              data-op={entry.op}
              aria-pressed={chosen?.flaggedLine === index}
              data-answer={graded?.line === index}
              disabled={graded !== null || !isFlagging || entry.op !== "+"}
              onClick={() => {
                onAnswer({
                  taskId: question.id,
                  kind: "pr-review",
                  verdict: "request-changes",
                  flaggedLine: index,
                });
                setFlagging(false);
              }}
            >
              <span className="code__number">{entry.op}</span>
              <span className="code__text">{entry.text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      {!graded && (
        <div className="task__actions">
          <button
            type="button"
            className="button button--ghost"
            aria-pressed={chosen?.verdict === "approve"}
            onClick={() => {
              onAnswer({
                taskId: question.id,
                kind: "pr-review",
                verdict: "approve",
                flaggedLine: null,
              });
              setFlagging(false);
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="button button--ghost"
            aria-pressed={isFlagging || chosen?.verdict === "request-changes"}
            onClick={() => setFlagging(!isFlagging)}
          >
            {isFlagging ? "Cancel" : "Request changes"}
          </button>
        </div>
      )}
      {verdictText && <p className="company__note">{verdictText}</p>}
    </article>
  );
}
