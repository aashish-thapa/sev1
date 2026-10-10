import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAudio } from "../../../audio/index.ts";
import { PANIC_THRESHOLD } from "../people/behaviour.ts";
import { colleaguesIn, type Colleague } from "./colleagues.ts";
import { CALM_LINES, draw, PANIC_LINES, shuffledDeck } from "./smallTalk.ts";
import type { Usable } from "./usable.ts";

/** Who you're talking to and what they said; the bubble stays up while it's read (and spoken). */
export type Conversation = { readonly colleagueId: string; readonly name: string; readonly line: string };

/** Reach around someone's chair or spot that counts as walking up to them. */
const PERSONAL_SPACE = 0.7;
const SECONDS_PER_WORD = 0.36;
const MIN_SECONDS = 3.5;

const random = Math.random;

/** Walk up to a colleague, press E, and they turn and say something — calm small talk, or panic once production burns. */
export function useSmallTalk(panic: number) {
  const colleagues = useMemo(() => colleaguesIn(), []);
  const decks = useRef({ calm: shuffledDeck(CALM_LINES.length, random), panic: shuffledDeck(PANIC_LINES.length, random) });
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const isTalking = useRef(false);
  const panicRef = useRef(panic);
  useEffect(() => {
    panicRef.current = panic;
  }, [panic]);

  const talkTo = useCallback((colleague: Colleague) => {
    if (isTalking.current) return;
    const mood = panicRef.current >= PANIC_THRESHOLD ? "panic" : "calm";
    const lines = mood === "panic" ? PANIC_LINES : CALM_LINES;
    const next = draw(decks.current[mood], random);
    decks.current = { ...decks.current, [mood]: next.deck };
    const line = lines[next.index];
    isTalking.current = true;
    setConversation({ colleagueId: colleague.id, name: colleague.name, line });
    const readingTime = new Promise((resolve) => window.setTimeout(resolve, Math.max(MIN_SECONDS, line.split(" ").length * SECONDS_PER_WORD) * 1000));
    void Promise.all([getAudio().voice.speak(line, `colleague-${colleague.id}`), readingTime]).then(() => {
      isTalking.current = false;
      setConversation((current) => (current?.colleagueId === colleague.id && current.line === line ? null : current));
    });
  }, []);

  const usables = useMemo<Usable[]>(
    () =>
      colleagues.map((colleague) => ({
        key: `colleague:${colleague.id}`,
        footprint: { x: colleague.x, z: colleague.z, width: PERSONAL_SPACE, depth: PERSONAL_SPACE },
        verb: "Chat with",
        label: colleague.name,
        use: () => talkTo(colleague),
      })),
    [colleagues, talkTo],
  );

  return { conversation, usables };
}
