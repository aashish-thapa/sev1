import type { ReactNode } from "react";
import type { EvidenceItem, IncidentCard as Incident } from "../domain/incident.ts";
import { FactsList } from "./evidence/FactsList.tsx";
import { CodeBlock } from "./evidence/CodeBlock.tsx";
import { LogBlock } from "./evidence/LogBlock.tsx";
import type { LineSelection } from "./evidence/selection.ts";
import { MetricSparkline } from "./evidence/MetricSparkline.tsx";

type EvidenceRenderers = {
  [Type in EvidenceItem["type"]]: (item: Extract<EvidenceItem, { type: Type }>) => ReactNode;
};

const RENDERERS: EvidenceRenderers = {
  metric: (item) => <MetricSparkline metric={item} />,
  log: (item) => <LogBlock log={item} />,
  facts: (item) => <FactsList facts={item} />,
  code: (item) => <CodeBlock code={item} />,
};

function renderEvidence(item: EvidenceItem): ReactNode {
  return (RENDERERS[item.type] as (evidence: EvidenceItem) => ReactNode)(item);
}

const SEVERITY_GLYPH: Record<Incident["alert"]["severity"], string> = { SEV1: "▲", SEV2: "◆", SEV3: "●" };

type Props = {
  incident: Incident;
  /** Which log or code block (by evidence index) the player picks a line from. */
  pickable?: { evidence: number; selection: LineSelection };
};

export function IncidentCard({ incident, pickable }: Props) {
  const { alert } = incident;
  return (
    <article className="incident" aria-labelledby={`alert-${incident.id}`}>
      <header className="incident__alert">
        <p className="incident__meta">
          <span className="severity" data-severity={alert.severity}>
            <span aria-hidden="true">{SEVERITY_GLYPH[alert.severity]}</span> {alert.severity}
          </span>
          <span>{alert.service}</span>
          <span>
            <span className="visually-hidden">fired at </span>
            {alert.firedAt}
          </span>
        </p>
        <h2 id={`alert-${incident.id}`} className="incident__title">{alert.title}</h2>
      </header>
      <div className="incident__evidence">
        {incident.evidence.map((item, index) =>
          pickable && pickable.evidence === index && item.type === "log" ? (
            <LogBlock key={index} log={item} selection={pickable.selection} />
          ) : pickable && pickable.evidence === index && item.type === "code" ? (
            <CodeBlock key={index} code={item} selection={pickable.selection} />
          ) : (
            <div key={index}>{renderEvidence(item)}</div>
          ),
        )}
      </div>
    </article>
  );
}
