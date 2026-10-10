import type { ReactNode } from "react";
import { conditionOf, tirednessOf, type Wellbeing } from "../../../domain/wellbeing.ts";

type Props = { wellbeing: Wellbeing; reduceMotion: boolean };

/** Two small gauges above the stick — a cup for energy, an apple for fullness — and a darkening view when you're running on empty. */
export function Meters({ wellbeing, reduceMotion }: Props) {
  const { isTired, isHungry } = conditionOf(wellbeing);
  const tiredness = tirednessOf(wellbeing);
  return (
    <>
      <div className="meters" data-reduce-motion={reduceMotion}>
        <Meter glyph={<CupIcon />} label="Energy" value={wellbeing.energy} isLow={isTired} />
        <Meter glyph={<AppleIcon />} label="Fullness" value={wellbeing.fullness} isLow={isHungry} />
      </div>
      {tiredness > 0 && <div className="tired" aria-hidden="true" data-reduce-motion={reduceMotion} style={{ opacity: Math.min(0.85, 0.25 + tiredness * 0.6) }} />}
    </>
  );
}

function Meter({ glyph, label, value, isLow }: { glyph: ReactNode; label: string; value: number; isLow: boolean }) {
  const percent = Math.round(value * 100);
  return (
    <div className="meter" data-low={isLow} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="meter__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="meter__track">
        <span className="meter__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
    </div>
  );
}

function CupIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h8v5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" />
      <path d="M11 6.5h1a1.5 1.5 0 0 1 0 3h-1" />
      <path d="M6 1.5c0 1 1 1 1 2M8.5 1.5c0 1 1 1 1 2" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 5c-1.5-1-5-1-5 3 0 3 2 6 3.5 6 .7 0 1-.4 1.5-.4s.8.4 1.5.4C11 14 13 11 13 8c0-4-3.5-4-5-3z" />
      <path d="M8 5c0-1.5.5-2.5 2-3" />
    </svg>
  );
}
