import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { TerminalLine } from "./useIncident.ts";

type Props = {
  lines: readonly TerminalLine[];
  history: readonly string[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onRun: (line: string) => void;
  onComplete: (line: string) => { line: string; candidates: readonly string[] };
  suggestions: readonly string[];
  isDisabled: boolean;
  onEscape?: () => void;
  /** Changing this value moves keyboard focus into the prompt (e.g. when the laptop finishes opening). */
  focusSignal?: number;
  /** The shell prompt, e.g. `oncall@prod-bastion:~$`. */
  prompt: string;
};

export function Terminal({ lines, history, draft, onDraftChange, onRun, onComplete, suggestions, isDisabled, onEscape, focusSignal, prompt }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<readonly string[]>([]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length, candidates]);

  useEffect(() => {
    if (focusSignal) inputRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRun(draft);
    onDraftChange("");
    setHistoryIndex(null);
    setCandidates([]);
  };

  const completeDraft = () => {
    const result = onComplete(draft);
    onDraftChange(result.line);
    setCandidates(result.candidates);
    inputRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      completeDraft();
    } else if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      onDraftChange(history[index]);
    } else if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      const index = historyIndex + 1;
      setHistoryIndex(index >= history.length ? null : index);
      onDraftChange(index >= history.length ? "" : history[index]);
    } else if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      onRun("clear");
    }
  };

  return (
    <section className="terminal" aria-label="Bastion terminal">
      <div ref={scrollRef} className="terminal__screen" role="log" aria-live="polite" onClick={() => inputRef.current?.focus({ preventScroll: true })}>
        {lines.map((line) => (
          <pre key={line.id} className="terminal__line" data-tone={line.tone}>
            {line.text}
          </pre>
        ))}
        {candidates.length > 0 && <pre className="terminal__line" data-tone="dim">{candidates.join("   ")}</pre>}
      </div>

      <div className="terminal__chips" aria-label="Suggested commands">
        {suggestions.map((command) => (
          <button
            key={command}
            type="button"
            className="chip"
            onClick={() => {
              onDraftChange(command);
              inputRef.current?.focus({ preventScroll: true });
            }}
          >
            {command}
          </button>
        ))}
      </div>

      <form className="terminal__prompt" onSubmit={submit}>
        <label htmlFor="terminal-input" className="terminal__ps1">
          <span className="terminal__ps1-host">{prompt.slice(0, -1)}</span>$
        </label>
        <input
          ref={inputRef}
          id="terminal-input"
          className="terminal__input"
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
            setCandidates([]);
          }}
          onKeyDown={onKeyDown}
          disabled={isDisabled}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          aria-describedby="terminal-help"
        />
        <button type="button" className="terminal__key" onClick={completeDraft} disabled={isDisabled} aria-label="Complete (Tab)">
          ⇥
        </button>
        <button type="submit" className="terminal__key terminal__key--run" disabled={isDisabled} aria-label="Run command">
          ↵
        </button>
      </form>
      <p id="terminal-help" className="visually-hidden">
        Tab completes, arrow up and down walk your command history.
      </p>
    </section>
  );
}
