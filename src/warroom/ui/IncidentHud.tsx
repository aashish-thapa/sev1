import type { Incident } from "../incident.ts";
import { SoundToggle } from "../../ui/SoundToggle.tsx";
import { useCareer } from "../../app/career-context.ts";
import { WalletChip } from "../../ui/WalletChip.tsx";
import { clockAt, type Scenario } from "../scenario.ts";

const countFormat = new Intl.NumberFormat("en");

/** Failed checkouts the SLA allows this hour; past it, contracts start paying out credits. */
const SLA_BUDGET = 9_000;

function SlaClock({ incident }: { incident: Incident }) {
  const { cluster, phase } = incident;
  const remaining = SLA_BUDGET - cluster.failedCheckouts;
  const failingPerSecond = cluster.traffic.requestsPerSecond * cluster.errorRate * cluster.traffic.checkoutShare;
  if (phase.name !== "live") return null;
  if (remaining <= 0) {
    return (
      <div data-tone="critical">
        <dt>SLA</dt>
        <dd>breached</dd>
      </div>
    );
  }
  if (failingPerSecond < 0.5) return null;
  const seconds = Math.floor(remaining / failingPerSecond);
  return (
    <div data-tone={seconds < 120 ? "critical" : "warn"}>
      <dt>SLA breach in</dt>
      <dd>
        {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
      </dd>
    </div>
  );
}

type Props = {
  incident: Incident;
  scenario: Scenario;
  isPaged: boolean;
  /** Absent when you can't start the incident yourself (a visitor to someone's office). */
  onPage?: () => void;
  onDeclare: () => void;
  onLeave: () => void;
};

export function IncidentHud({ incident, scenario, isPaged, onPage, onDeclare, onLeave }: Props) {
  const career = useCareer();
  const { cluster, phase } = incident;
  const errorPercent = Math.round(cluster.errorRate * 100);
  if (!isPaged) {
    return (
      <header className="hud">
        <div className="hud__row hud__row--calm">
          <button type="button" className="button button--quiet" onClick={onLeave}>
            Leave
          </button>
          <p className="hud__title">{career.title} on call · all quiet</p>
          <dl className="hud__wallet">
            <WalletChip />
          </dl>
          <SoundToggle />
          {onPage && (
            <button type="button" className="button button--ghost hud__resolve" onClick={onPage}>
              Page me
            </button>
          )}
        </div>
      </header>
    );
  }
  return (
    <header className="hud">
      <div className="hud__row hud__row--controls">
        <button type="button" className="button button--quiet" onClick={onLeave}>
          Leave
        </button>
        <p className="hud__title">
          <span className="severity" data-severity={scenario.severity}>
            {scenario.severity}
          </span>{" "}
          {scenario.title}
        </p>
        <SoundToggle />
        <p className="hud__clock">{clockAt(scenario, cluster.t)}</p>
      </div>
      <dl className="hud__stats">
        <div data-tone={errorPercent >= 5 ? "critical" : errorPercent >= 1 ? "warn" : "ok"}>
          <dt>checkout 5xx</dt>
          <dd>{errorPercent}%</dd>
        </div>
        <div>
          <dt>failed checkouts</dt>
          <dd>{countFormat.format(Math.round(cluster.failedCheckouts))}</dd>
        </div>
        <SlaClock incident={incident} />
        <WalletChip />
        <div className="hud__action">
          {phase.name === "monitoring" ? (
            <p className="hud__monitoring" role="status">
              Monitoring · {Math.ceil(phase.secondsLeft / 60)} min left
            </p>
          ) : (
            <button type="button" className="button button--ghost hud__resolve" onClick={onDeclare}>
              Declare resolved
            </button>
          )}
        </div>
      </dl>
    </header>
  );
}
