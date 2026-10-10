import { useCallback, useEffect, useState } from "react";
import type { Run } from "../app/useShiftGame.ts";
import type { Attempt } from "../domain/progress.ts";
import { isCorrectChoice, type Choice, type PresentedIncident } from "../domain/shift.ts";
import { AnswerPad } from "./AnswerPad.tsx";
import { IncidentCard } from "./IncidentCard.tsx";
import { Reveal } from "./Reveal.tsx";
import { formatClock, useStopwatch } from "./useStopwatch.ts";
import { useSwipeAway } from "./useSwipeAway.ts";

type Props = {
  run: Run;
  onAnswer: (attempt: Attempt) => number;
  onFinish: () => void;
  onLeave: () => void;
  /** A new card is on screen (lets a presenter read it out). */
  onCardShown?: (presented: PresentedIncident) => void;
  onAnswered?: (presented: PresentedIncident, isCorrect: boolean) => void;
};

type Answered = { choice: Choice; isCorrect: boolean; ratingDelta: number | null };

export function ShiftView({ run, onAnswer, onFinish, onLeave, onCardShown, onAnswered }: Props) {
  const [cursor, setCursor] = useState(() => Math.min(run.attempts.length, run.incidents.length - 1));
  const [answered, setAnswered] = useState<Answered | null>(null);
  const presented = run.incidents[cursor];
  const isLast = cursor === run.incidents.length - 1;
  const clock = useStopwatch(answered === null);

  const choose = useCallback(
    (choice: Choice) => {
      if (answered) return;
      const isCorrect = isCorrectChoice(presented, choice);
      const delta = onAnswer({
        incidentId: presented.incident.id,
        topic: presented.incident.topic,
        difficulty: presented.incident.difficulty,
        isCorrect,
        elapsedMs: clock.elapsedMs(),
      });
      setAnswered({ choice, isCorrect, ratingDelta: run.mode === "rated" ? delta : null });
      onAnswered?.(presented, isCorrect);
    },
    [answered, clock, onAnswer, onAnswered, presented, run.mode],
  );

  const advance = useCallback(() => {
    if (!answered) return;
    if (isLast) {
      onFinish();
      return;
    }
    setAnswered(null);
    setCursor((index) => index + 1);
    clock.restart();
    window.scrollTo({ top: 0 });
  }, [answered, clock, isLast, onFinish]);

  const swipeRef = useSwipeAway<HTMLDivElement>(answered !== null, advance);

  useEffect(() => {
    onCardShown?.(presented);
  }, [onCardShown, presented]);

  return (
    <main className="shift">
      <header className="shift__bar">
        <button type="button" className="button button--quiet" onClick={onLeave}>
          Leave
        </button>
        <ShiftTicks run={run} cursor={cursor} />
        <p className="shift__clock" aria-label={`${clock.seconds} seconds on this page`}>
          {formatClock(clock.seconds)}
        </p>
      </header>
      {run.mode === "practice" && <p className="shift__practice">Practice shift · unrated</p>}

      <div ref={swipeRef} key={presented.incident.id} className="shift__card" data-answered={answered !== null}>
        <IncidentCard incident={presented.incident} pickable={lineSelectionFor(presented, answered, choose)} />
      </div>

      <section className="dock" aria-label="Your call" data-answered={answered !== null}>
        {!answered && <h2 className="dock__question">{presented.incident.question}</h2>}
        {presented.kind === "diagnose" && (
          <AnswerPad
            options={presented.options}
            answerIndex={presented.answerIndex}
            pickedIndex={answered?.choice.kind === "option" ? answered.choice.index : null}
            onPick={(index) => choose({ kind: "option", index })}
          />
        )}
        {answered && (
          <Reveal
            key={presented.incident.id}
            incident={presented.incident}
            isCorrect={answered.isCorrect}
            ratingDelta={answered.ratingDelta}
            isLast={isLast}
            onNext={advance}
          />
        )}
      </section>
    </main>
  );
}

function lineSelectionFor(presented: PresentedIncident, answered: Answered | null, choose: (choice: Choice) => void) {
  if (presented.kind !== "find-line") return undefined;
  const { answer } = presented.incident;
  const picked = answered?.choice.kind === "line" ? answered.choice.line : null;
  return {
    evidence: answer.evidence,
    selection: {
      isLocked: answered !== null,
      onPick: (line: number) => choose({ kind: "line", evidence: answer.evidence, line }),
      verdictFor: (line: number) => {
        if (picked === null) return undefined;
        if (line === answer.line) return picked === line ? ("picked-right" as const) : ("answer" as const);
        return line === picked ? ("picked-wrong" as const) : undefined;
      },
    },
  };
}

function ShiftTicks({ run, cursor }: { run: Run; cursor: number }) {
  const resolved = run.attempts.filter((attempt) => attempt.isCorrect).length;
  return (
    <div className="ticks">
      <p className="visually-hidden">
        Page {cursor + 1} of {run.incidents.length}. {resolved} resolved so far.
      </p>
      <ol className="ticks__row" aria-hidden="true">
        {run.incidents.map((presented, index) => {
          const attempt = run.attempts[index];
          const state = attempt ? (attempt.isCorrect ? "resolved" : "missed") : index === cursor ? "current" : "pending";
          return <li key={presented.incident.id} className="ticks__tick" data-state={state} />;
        })}
      </ol>
    </div>
  );
}
