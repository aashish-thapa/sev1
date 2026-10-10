import { useEffect } from "react";

type Props = {
  options: readonly string[];
  answerIndex: number;
  pickedIndex: number | null;
  onPick: (index: number) => void;
};

export function AnswerPad({ options, answerIndex, pickedIndex, onPick }: Props) {
  const isLocked = pickedIndex !== null;

  useEffect(() => {
    if (isLocked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < options.length) onPick(index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isLocked, onPick, options.length]);

  return (
    <ol className="pad" aria-label="Your call">
      {options.map((option, index) => {
        const verdict = !isLocked
          ? undefined
          : index === answerIndex
            ? "answer"
            : index === pickedIndex
              ? "wrong"
              : "idle";
        // Once locked, only the pick and the answer stay — the rest is noise.
        if (verdict === "idle") return null;
        return (
          <li key={option}>
            <button
              type="button"
              className="pad__option"
              data-verdict={verdict}
              disabled={isLocked}
              onClick={() => onPick(index)}
            >
              <kbd className="pad__key" aria-hidden="true">{index + 1}</kbd>
              <span>{option}</span>
              {verdict === "answer" && <span className="pad__mark" aria-label="correct">✓</span>}
              {verdict === "wrong" && <span className="pad__mark" aria-label="your pick, wrong">✗</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
