import { useId, useState, type PointerEvent } from "react";
import type { MetricEvidenceItem } from "../../domain/incident.ts";

const WIDTH = 320;
const HEIGHT = 76;
const PAD_Y = 8;

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function MetricSparkline({ metric }: { metric: MetricEvidenceItem }) {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { points, markAt, unit, label } = metric;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (index: number) => (index / (points.length - 1)) * WIDTH;
  const y = (value: number) => PAD_Y + (1 - (value - min) / span) * (HEIGHT - PAD_Y * 2);

  const line = points.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const area = `${line} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z`;
  const format = (value: number) => `${numberFormat.format(value)}${unit ? ` ${unit}` : ""}`;

  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "mouse") return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHoverIndex(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };

  const focusIndex = hoverIndex ?? markAt;

  return (
    <figure className="metric" aria-labelledby={titleId}>
      <figcaption className="metric__head">
        <span id={titleId} className="evidence__label">{label}</span>
        <span className="metric__readout" aria-hidden="true">
          {focusIndex === undefined ? format(points[points.length - 1]) : format(points[focusIndex])}
        </span>
      </figcaption>
      <div className="metric__canvas">
      <svg
        className="metric__plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={titleId}
        onPointerMove={trackPointer}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <path className="metric__area" d={area} />
        {focusIndex !== undefined && (
          <line className="metric__crosshair" x1={x(focusIndex)} x2={x(focusIndex)} y1={0} y2={HEIGHT} />
        )}
        <path className="metric__line" d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      {focusIndex !== undefined && (
        <span
          className="metric__marker"
          aria-hidden="true"
          style={{ left: `${(focusIndex / (points.length - 1)) * 100}%`, top: `${(y(points[focusIndex]) / HEIGHT) * 100}%` }}
        />
      )}
      </div>
      <div className="metric__scale" aria-hidden="true">
        <span>min {format(min)}</span>
        <span>max {format(max)}</span>
      </div>
      <table className="visually-hidden">
        <caption>{label}, oldest to newest</caption>
        <tbody>
          {points.map((value, index) => (
            <tr key={index}>
              <th scope="row">Sample {index + 1}{index === markAt ? " (change point)" : ""}</th>
              <td>{format(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
