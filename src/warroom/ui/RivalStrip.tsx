import type { RoomMode } from "../../multiplayer/protocol.ts";
import type { RoomView } from "../../multiplayer/useRoom.ts";
import { formatAlertRate, formatCountdown, formatElapsed, LANE_PHASE_LABEL, laneName } from "../match-view.ts";
import type { MatchStage, Team } from "../versus.ts";

type Props = {
  match: NonNullable<RoomView["match"]>;
  /** This player's side, highlighted among the lanes. */
  team: Team | null;
  /** A matchmade lineup looks for opponents rather than waiting for a team to join by code. */
  mode: RoomMode;
};

function stageNote(stage: MatchStage, mode: RoomMode): string | null {
  switch (stage.name) {
    case "lineup":
      return mode === "matchmade" ? "Invite friends with the code, then press Page me to find opponents." : "Lining up. Press Page me when both teams are in.";
    case "searching":
      return `Looking for opponents… ${formatElapsed(stage.msElapsed)}`;
    case "found":
      return "Opponents found, joining…";
    default:
      return null;
  }
}

/** Both teams' race at a glance: how loud each side's pager is and how far they've got. */
export function RivalStrip({ match, team, mode }: Props) {
  const { stage, lanes } = match;
  const note = stageNote(stage, mode);
  return (
    <section className="rival-strip" aria-label="Versus standings">
      {note && <p className="rival-strip__note">{note}</p>}
      {stage.name === "overtime" && (
        <p className="rival-strip__note rival-strip__note--overtime" role="timer" aria-live="off">
          Overtime <strong>{formatCountdown(stage.msLeft)}</strong>
        </p>
      )}
      <ul className="rival-strip__lanes">
        {lanes.map((lane) => (
          <li key={lane.team} className="rival-strip__lane" data-team={lane.team} aria-current={lane.team === team ? "true" : undefined}>
            <span className="rival-strip__team">
              {laneName(lane)}
              {lane.team === team && <span className="rival-strip__you"> · you</span>}
            </span>
            <span className="rival-strip__rate" aria-label={`Alert rate ${formatAlertRate(lane.alertRate)}`}>
              {formatAlertRate(lane.alertRate)}
            </span>
            <span className="rival-strip__meta">{LANE_PHASE_LABEL[lane.phase]}</span>
            <span className="rival-strip__meta">
              {lane.reopenCount} re-page{lane.reopenCount === 1 ? "" : "s"}
              {lane.crew === "players" && ` · ${lane.players} on`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
