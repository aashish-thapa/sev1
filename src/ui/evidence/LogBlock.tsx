import type { LogEvidenceItem } from "../../domain/incident.ts";
import { VERDICT_LABEL, type LineSelection } from "./selection.ts";

/** Read-only by default; with `selection` every line becomes a tap target. */
export function LogBlock({ log, selection }: { log: LogEvidenceItem; selection?: LineSelection }) {
  return (
    <section className="log" aria-label={log.label}>
      <h3 className="evidence__label">{log.label}</h3>
      <ol className={selection ? "log__lines log__lines--pickable" : "log__lines"}>
        {log.lines.map((line, index) => {
          const content = (
            <>
              <span className="log__ts">{line.ts}</span>
              <span className="log__level" data-level={line.level}>{line.level}</span>
              {line.source && <span className="log__source">{line.source}</span>}
              <span className="log__text">{line.text}</span>
            </>
          );
          if (!selection) return <li key={index} className="log__line">{content}</li>;

          const verdict = selection.verdictFor(index);
          return (
            <li key={index}>
              <button
                type="button"
                className="log__line log__pick"
                data-verdict={verdict}
                disabled={selection.isLocked}
                onClick={() => selection.onPick(index)}
              >
                {content}
                {verdict && <span className="visually-hidden">{VERDICT_LABEL[verdict]}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
