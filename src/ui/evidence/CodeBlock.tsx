import type { CodeEvidenceItem } from "../../domain/incident.ts";
import { VERDICT_LABEL, type LineSelection } from "./selection.ts";

type DiffKind = "add" | "remove" | "context";

function diffKind(line: string, isDiff: boolean): DiffKind {
  if (!isDiff) return "context";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** Source or diff with line numbers; with `selection` every line becomes a tap target. */
export function CodeBlock({ code, selection }: { code: CodeEvidenceItem; selection?: LineSelection }) {
  const isDiff = code.language === "diff";
  return (
    <section className="code" aria-label={code.label}>
      <h3 className="evidence__label">{code.label}</h3>
      <ol className={selection ? "code__lines code__lines--pickable" : "code__lines"} data-language={code.language}>
        {code.lines.map((line, index) => {
          const number = code.startLine + index;
          const kind = diffKind(line, isDiff);
          const content = (
            <>
              <span className="code__number" aria-hidden="true">{number}</span>
              <span className="code__text">{line === "" ? " " : line}</span>
            </>
          );
          if (!selection) {
            return (
              <li key={index} className="code__line" data-diff={kind}>
                {content}
              </li>
            );
          }
          const verdict = selection.verdictFor(index);
          return (
            <li key={index}>
              <button
                type="button"
                className="code__line code__pick"
                data-diff={kind}
                data-verdict={verdict}
                disabled={selection.isLocked}
                aria-label={`Line ${number}: ${line.trim() || "blank"}${verdict ? VERDICT_LABEL[verdict] : ""}`}
                onClick={() => selection.onPick(index)}
              >
                {content}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
