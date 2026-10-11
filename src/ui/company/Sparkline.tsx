import { useState, type PointerEvent } from "react";
import { formatCents } from "../../domain/economy.ts";

type Point = { readonly workDay: number; readonly valuationCents: number };

const WIDTH = 120;
const HEIGHT = 32;
const PAD = 3;

/** A company's worth over its recent work days: one line, the latest point marked, any day on hover. */
export function Sparkline({ points, label }: { points: readonly Point[]; label: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (points.length < 2) return null;
  const values = points.map((point) => point.valuationCents);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const x = (index: number) => PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2);
  const y = (value: number) => (high === low ? HEIGHT / 2 : PAD + (1 - (value - low) / (high - low)) * (HEIGHT - PAD * 2));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.valuationCents).toFixed(1)}`).join(" ");
  const shown = hovered ?? points.length - 1;

  const track = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHovered(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  };

  return (
    <span className="sparkline">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={`${label}: ${formatCents(values[0])} on day ${points[0].workDay}, ${formatCents(values.at(-1)!)} on day ${points.at(-1)!.workDay}`}
        onPointerMove={track}
        onPointerLeave={() => setHovered(null)}
      >
        <path d={path} className="sparkline__line" />
        <circle cx={x(shown)} cy={y(values[shown])} r={3} className="sparkline__dot" />
      </svg>
      {hovered !== null && (
        <span className="sparkline__tip" role="status">
          Day {points[hovered].workDay} · {formatCents(values[hovered])}
        </span>
      )}
    </span>
  );
}
