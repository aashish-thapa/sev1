import { useState } from "react";
import { gradeCodeFix, gradeReview, isDone, presentFixes, type CodeFixOutcome, type CodeFixTask, type PrReviewTask, type ReviewOutcome, type Task } from "../../domain/work/task.ts";

type Finish = (outcome: CodeFixOutcome | ReviewOutcome) => void;

const VERDICT_TEXT: Readonly<Record<CodeFixOutcome | ReviewOutcome, string>> = {
  shipped: "Shipped. The test passes.",
  "wrong-line": "That line isn’t the cause.",
  "wrong-fix": "Right line, but that patch doesn’t fix it.",
  correct: "Good review.",
  "shipped-a-bug": "Approved, and the bug went out with it.",
  "blocked-a-good-pr": "This one was fine to merge.",
};

/** One task, start to verdict; `day` keeps the patch order the same all day. */
export function TaskView({ task, day, onFinish }: { task: Task; day: string; onFinish: Finish }) {
  return task.kind === "code-fix" ? <CodeFix task={task} day={day} onFinish={onFinish} /> : <PrReview task={task} onFinish={onFinish} />;
}

function Verdict({ outcome, task }: { outcome: CodeFixOutcome | ReviewOutcome; task: Task }) {
  return (
    <div className="task__verdict" data-done={isDone(outcome)} role="status">
      <p className="task__verdict-title">
        <span aria-hidden="true">{isDone(outcome) ? "✓ " : "✕ "}</span>
        {VERDICT_TEXT[outcome]}
      </p>
      <p>{task.explanation.cause}</p>
      <p className="task__why">{task.explanation.why}</p>
    </div>
  );
}

function CodeFix({ task, day, onFinish }: { task: CodeFixTask; day: string; onFinish: Finish }) {
  const [line, setLine] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<CodeFixOutcome | null>(null);
  const { fixes, order } = presentFixes(task, day);

  const choose = (shown: number) => {
    if (line === null || outcome) return;
    const result = gradeCodeFix(task, line, order[shown]);
    setOutcome(result);
    onFinish(result);
  };

  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">Bug fix · {task.file.path}</p>
        <h3 className="task__title">{task.title}</h3>
      </header>
      <p className="task__ticket">{task.ticket}</p>
      <pre className="task__output" aria-label={`Failing test: ${task.failing.test}`}>
        <span className="task__output-title">✕ {task.failing.test}</span>
        {"\n"}
        {task.failing.output.join("\n")}
      </pre>
      <p className="task__step">{line === null ? "1. Click the line that causes it." : outcome ? "" : "2. Pick the patch for that line."}</p>
      <ol className="code" aria-label={task.file.path}>
        {task.file.lines.map((text, index) => (
          <li key={index}>
            <button
              type="button"
              className="code__line"
              aria-pressed={line === index}
              data-answer={outcome !== null && index === task.bugLine}
              disabled={outcome !== null}
              onClick={() => setLine(index)}
            >
              <span className="code__number">{index + 1}</span>
              <span className="code__text">{text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      {line !== null && !outcome && (
        <ul className="task__choices">
          {fixes.map((patch, shown) => (
            <li key={patch}>
              <button type="button" className="task__choice" onClick={() => choose(shown)}>
                <span className="task__choice-mark">−</span> <code>{task.file.lines[line]}</code>
                {"\n"}
                <span className="task__choice-mark">+</span> <code>{patch}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      {outcome && <Verdict outcome={outcome} task={task} />}
    </article>
  );
}

function PrReview({ task, onFinish }: { task: PrReviewTask; onFinish: Finish }) {
  const [isFlagging, setFlagging] = useState(false);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);

  const finish = (verdict: PrReviewTask["verdict"], flagged: number | null) => {
    const result = gradeReview(task, verdict, flagged);
    setOutcome(result);
    setFlagging(false);
    onFinish(result);
  };

  return (
    <article className="task">
      <header className="task__head">
        <p className="task__kind">
          Pull request · {task.path} · by {task.author}
        </p>
        <h3 className="task__title">{task.title}</h3>
      </header>
      <p className="task__ticket">{task.description}</p>
      {isFlagging && <p className="task__step">Click the added line that breaks it.</p>}
      <ol className="code code--diff" aria-label={`Diff of ${task.path}`}>
        {task.diff.map((entry, index) => (
          <li key={index}>
            <button
              type="button"
              className="code__line"
              data-op={entry.op}
              data-answer={outcome !== null && index === task.flaw}
              disabled={!isFlagging || entry.op !== "+"}
              onClick={() => finish("request-changes", index)}
            >
              <span className="code__number">{entry.op}</span>
              <span className="code__text">{entry.text || " "}</span>
            </button>
          </li>
        ))}
      </ol>
      {!outcome && (
        <div className="task__actions">
          <button type="button" className="button button--primary" disabled={isFlagging} onClick={() => finish("approve", null)}>
            Approve
          </button>
          <button type="button" className="button button--ghost" aria-pressed={isFlagging} onClick={() => setFlagging(!isFlagging)}>
            {isFlagging ? "Cancel" : "Request changes"}
          </button>
        </div>
      )}
      {outcome && <Verdict outcome={outcome} task={task} />}
    </article>
  );
}
