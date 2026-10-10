import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_CHAT_LENGTH } from "../../multiplayer/protocol.ts";
import type { CommsMessage } from "../scenario.ts";

type Props = {
  comms: readonly CommsMessage[];
  onSend: (text: string) => void;
};

/** How many recent lines the panel keeps on screen; older ones scroll. */
const VISIBLE_LINES = 30;
const OPEN_KEY = "t";

/** The room's text chat: what teammates typed, and a box to answer. Press T to start typing. */
export function TeamChat({ comms, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const lines = comms.filter((message) => message.kind === "chat").slice(-VISIBLE_LINES);

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  // T opens the box, the way squad games do, unless the keys are already going into a field.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (isTyping || event.repeat || event.key.toLowerCase() !== OPEN_KEY) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <section className="team-chat" aria-label="Team chat">
      <ol ref={log} className="team-chat__log" aria-live="polite">
        {lines.length === 0 ? (
          <li className="team-chat__empty">No messages yet.</li>
        ) : (
          lines.map((line, index) => (
            <li key={`${line.at}-${index}`} className="team-chat__line">
              <span className="team-chat__from">{line.from.split(" · ")[0]}</span> {line.text}
            </li>
          ))
        )}
      </ol>
      <form className="team-chat__form" onSubmit={send}>
        <input
          ref={input}
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          placeholder="Press T to chat"
          aria-label="Message your team"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Esc hands the keys back to the floor without sending.
            if (event.key === "Escape") event.currentTarget.blur();
          }}
        />
      </form>
    </section>
  );
}
