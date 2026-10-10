import { useEffect, useRef } from "react";
import { getAudio, stomachRumble, yawn } from "../../../audio/index.ts";
import { conditionOf, type Wellbeing } from "../../../domain/wellbeing.ts";

/** How often, roughly, a tired yawn or a hungry stomach makes itself heard — often enough to nag, not to annoy. */
const CUE_EVERY_MS = { tired: 80_000, hungry: 65_000 } as const;
const JITTER = 0.4;

/** Your body speaks up while you're tired or hungry: an occasional yawn, a rumbling stomach. */
export function useBodyCues(wellbeing: Wellbeing, isActive: boolean): void {
  const { isTired, isHungry } = conditionOf(wellbeing);
  useCue(isActive && isTired, CUE_EVERY_MS.tired, () => yawn(getAudio().engine));
  useCue(isActive && isHungry, CUE_EVERY_MS.hungry, () => stomachRumble(getAudio().engine));
}

function useCue(isOn: boolean, everyMs: number, play: () => void): void {
  const playRef = useRef(play);
  useEffect(() => {
    playRef.current = play;
  }, [play]);
  useEffect(() => {
    if (!isOn) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        playRef.current();
        schedule();
      }, everyMs * (1 - JITTER / 2 + Math.random() * JITTER));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [everyMs, isOn]);
}
