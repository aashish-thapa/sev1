import { useEffect, useState } from "react";
import type { Interview } from "../../storage/company-protocol.ts";
import { QuestionView, type Answer } from "./QuestionViews.tsx";

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
          Leave for now
        </button>
      </div>
    </section>
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
