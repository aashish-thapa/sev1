import { useEffect, useRef } from "react";
import type { IncidentCard } from "../domain/incident.ts";

type Props = {
  incident: IncidentCard;
  isCorrect: boolean;
  ratingDelta: number | null;
  isLast: boolean;
  onNext: () => void;
};

export function Reveal({ incident, isCorrect, ratingDelta, isLast, onNext }: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const { explanation, source } = incident;

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rootRef.current?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    nextRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section ref={rootRef} className="reveal" data-outcome={isCorrect ? "resolved" : "missed"} aria-live="polite">
      <p className="reveal__verdict">
        <span aria-hidden="true">{isCorrect ? "✓" : "✗"}</span> {isCorrect ? "Resolved" : "Wrong call"}
        {ratingDelta !== null && ratingDelta !== 0 && (
          <span className="reveal__delta">
            {ratingDelta > 0 ? "+" : "−"}
            {Math.abs(ratingDelta)} <span className="visually-hidden">rating</span>
          </span>
        )}
      </p>
      <h3 className="reveal__cause">{explanation.cause}</h3>
      <p className="reveal__why">{explanation.why}</p>
      <p className="reveal__tell">
        <strong>The tell</strong> {explanation.tell}
      </p>
      {source && (
        <p className="reveal__source">
          Based on <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
        </p>
      )}
      <button ref={nextRef} type="button" className="button button--primary reveal__next" onClick={onNext}>
        {isLast ? "Close the shift" : "Next page"}
      </button>
      <p className="reveal__hint" aria-hidden="true">or swipe the card away</p>
    </section>
  );
}
