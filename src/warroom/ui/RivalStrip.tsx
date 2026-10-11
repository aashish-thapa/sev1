import type { RoomView } from "../../multiplayer/useRoom.ts";
import { formatAlertRate, formatCountdown, LANE_PHASE_LABEL } from "../match-view.ts";
import { TEAM_LABEL, type Team } from "../versus.ts";

type Props = {
  match: NonNullable<RoomView["match"]>;
  /** This player's side, highlighted among the lanes. */
  team: Team | null;
};

/** Both teams' race at a glance: how loud each side's pager is and how far they've got. */
export function RivalStrip({ match, team }: Props) {
  const { stage, lanes } = match;
  return (
    <section className="rival-strip" aria-label="Versus standings">
      {stage.name === "lineup" && <p className="rival-strip__note">Lining up. Press Page me when both teams are in.</p>}
      {stage.name === "overtime" && (
        <p className="rival-strip__note rival-strip__note--overtime" role="timer" aria-live="off">
          Overtime <strong>{formatCountdown(stage.msLeft)}</strong>
        </p>
      )}
      <ul className="rival-strip__lanes">
        {lanes.map((lane) => (
          <li key={lane.team} className="rival-strip__lane" data-team={lane.team} aria-current={lane.team === team ? "true" : undefined}>
            <span className="rival-strip__team">
              {TEAM_LABEL[lane.team]}
              {lane.team === team && <span className="rival-strip__you"> · you</span>}
            </span>
            <span className="rival-strip__rate" aria-label={`Alert rate ${formatAlertRate(lane.alertRate)}`}>
              {formatAlertRate(lane.alertRate)}
            </span>
            <span className="rival-strip__meta">{LANE_PHASE_LABEL[lane.phase]}</span>
            <span className="rival-strip__meta">
              {lane.reopenCount} re-page{lane.reopenCount === 1 ? "" : "s"} · {lane.players} on
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
