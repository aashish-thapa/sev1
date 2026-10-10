import type { FactsEvidenceItem } from "../../domain/incident.ts";

export function FactsList({ facts }: { facts: FactsEvidenceItem }) {
  return (
    <section className="facts" aria-label={facts.label}>
      <h3 className="evidence__label">{facts.label}</h3>
      <dl className="facts__list">
        {facts.items.map((item) => (
          <div key={item.key} className="facts__row">
            <dt>{item.key}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
