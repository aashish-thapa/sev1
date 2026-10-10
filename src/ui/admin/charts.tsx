import { useState } from "react";
import type { AdminStats } from "../../storage/admin-protocol.ts";

type Day = AdminStats["accounts"]["signupsByDay"][number];

const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** One column per day; each column is its own hover/focus target, and a table carries every value without hovering. */
export function SignupsChart({ days }: { days: readonly Day[] }) {
  const [focused, setFocused] = useState<Day | null>(null);
  const peak = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return (
    <figure className="chart">
      <p className="chart__readout" aria-live="polite">
        {focused ? (
          <>
            <strong>{focused.count.toLocaleString("en-US")}</strong> {focused.count === 1 ? "signup" : "signups"} on {shortDay(focused.day)}
          </>
        ) : (
          <>
            <strong>{total.toLocaleString("en-US")}</strong> in 30 days · peak {peak.toLocaleString("en-US")} a day
          </>
        )}
      </p>
      <div className="chart__plot" onPointerLeave={() => setFocused(null)}>
        <span className="chart__max" aria-hidden="true">
          {peak}
        </span>
        <div className="chart__columns">
          {days.map((day) => (
            <button
              key={day.day}
              type="button"
              className="chart__column"
              aria-label={`${shortDay(day.day)}: ${day.count} signups`}
              data-active={focused?.day === day.day}
              onPointerEnter={() => setFocused(day)}
              onFocus={() => setFocused(day)}
              onBlur={() => setFocused(null)}
            >
              <span className="chart__bar" style={{ height: `${(day.count / peak) * 100}%` }} />
            </button>
          ))}
        </div>
      </div>
      {days.length > 0 && (
        <p className="chart__axis" aria-hidden="true">
          <span>{shortDay(days[0].day)}</span>
          <span>{shortDay(days[days.length - 1].day)}</span>
        </p>
      )}
      <details className="chart__table">
        <summary>Show as a table</summary>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Signups</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{shortDay(day.day)}</th>
                <td>{day.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Accounts at each career level, as labelled horizontal bars; the count is text, never the bar's colour. */
export function LevelBars({ levels }: { levels: AdminStats["levels"] }) {
  const most = Math.max(1, ...levels.map((level) => level.count));
  return (
    <ul className="level-bars">
      {levels.map((level) => (
        <li key={level.title} className="level-bars__row">
          <span className="level-bars__label">{level.title}</span>
          <span className="level-bars__track">
            <span className="level-bars__bar" style={{ width: `${(level.count / most) * 100}%` }} />
          </span>
          <span className="level-bars__count">{level.count.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ul>
  );
}
