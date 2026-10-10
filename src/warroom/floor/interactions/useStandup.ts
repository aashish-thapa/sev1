import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAudio, notificationPing } from "../../../audio/index.ts";
import { nowSeconds } from "./clock.ts";
import { STANDUP, standupPhase, standupScript, type StandupPhase } from "./standup.ts";
import type { Usable } from "./usable.ts";

/** What the stand-up shows on screen: the calendar ping, then whatever the host is saying. */
export type StandupNotice = { readonly kind: "invite" } | { readonly kind: "speaking"; readonly line: string };

// Same speaker id the incident channel uses for Sam, so he keeps one voice.
const HOST_VOICE = STANDUP.host;
const INVITE_SECONDS = 9;

/** The daily stand-up in meeting room A: a calendar ping a minute in, and a short meeting you can join. */
export function useStandup(isIncidentOpen: boolean, title: string) {
  const [enteredAt] = useState(nowSeconds);
  const [phase, setPhase] = useState<StandupPhase>("not-yet");
  const [notice, setNotice] = useState<StandupNotice | null>(null);
  const [hasJoined, setJoined] = useState(false);
  const context = useRef({ isIncidentOpen, title });
  useEffect(() => {
    context.current = { isIncidentOpen, title };
  }, [isIncidentOpen, title]);

  useEffect(() => {
    const at = (seconds: number) => Math.max(0, (enteredAt + seconds - nowSeconds()) * 1000);
    const ping = window.setTimeout(() => {
      setPhase("on");
      setNotice({ kind: "invite" });
      const { engine, voice } = getAudio();
      notificationPing(engine);
      void voice.speak("Stand-up's starting in meeting room A.", HOST_VOICE);
    }, at(STANDUP.pingAt));
    const hideInvite = window.setTimeout(() => setNotice((current) => (current?.kind === "invite" ? null : current)), at(STANDUP.pingAt + INVITE_SECONDS));
    const end = window.setTimeout(() => setPhase(standupPhase(STANDUP.pingAt + STANDUP.openFor)), at(STANDUP.pingAt + STANDUP.openFor));
    return () => [ping, hideInvite, end].forEach((timer) => window.clearTimeout(timer));
  }, [enteredAt]);

  const join = useCallback(async () => {
    setJoined(true);
    const { voice } = getAudio();
    for (const line of standupScript(context.current.isIncidentOpen, context.current.title)) {
      setNotice({ kind: "speaking", line });
      await Promise.all([voice.speak(line, HOST_VOICE), new Promise((resolve) => window.setTimeout(resolve, Math.max(2500, line.length * 55)))]);
    }
    setNotice(null);
  }, []);

  const usables = useMemo<Usable[]>(
    () => (phase === "on" && !hasJoined ? [{ key: "standup", footprint: STANDUP.table, verb: "Join", label: "the stand-up", use: () => void join() }] : []),
    [hasJoined, join, phase],
  );

  return { notice, usables };
}
