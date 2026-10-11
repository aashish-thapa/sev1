import { ROLE_INFO } from "../../domain/roles.ts";
import type { RoomView } from "../../multiplayer/useRoom.ts";
import { outcomeFor, type MatchOutcome } from "../match-view.ts";
import { mostValuable, type Scorecard } from "../scorecard.ts";
import { TEAM_LABEL, type Team, type Winner } from "../versus.ts";

function headline(outcome: MatchOutcome, winner: Winner): string {
  if (outcome === "won") return "Your team won";
  if (outcome === "lost") return "Your team lost";
  if (outcome === "draw" || winner === "draw") return "Dead heat: a draw";
  return `${TEAM_LABEL[winner]} won`;
}

/** The verdict on a versus match, once it's decided: who won, and each side's points. */
export function MatchResult({ match, team }: { match: NonNullable<RoomView["match"]>; team: Team | null }) {
  if (match.stage.name !== "decided") return null;
  const { winner } = match.stage;
  const outcome = outcomeFor(winner, team);
  return (
    <section className="match-result" data-outcome={outcome} aria-label="Match result">
      <h2 className="match-result__headline">{headline(outcome, winner)}</h2>
      <dl className="match-result__lanes">
        {match.lanes.map((lane) => (
          <div key={lane.team} data-team={lane.team} aria-current={lane.team === team ? "true" : undefined}>
            <dt>
              {TEAM_LABEL[lane.team]}
              {lane.team === winner && " ★"}
            </dt>
            <dd>{lane.finish ? `${lane.finish.points} pts` : "Didn't close"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** What each engineer did, with the most valuable one picked out. */
export function ScorecardTable({ scorecard }: { scorecard: Scorecard }) {
  if (scorecard.length === 0) return null;
  const mvp = mostValuable(scorecard);
  return (
    <section className="scorecard" aria-label="Scorecard">
      <h2 className="scorecard__title">Scorecard</h2>
      <div className="scorecard__scroll">
        <table className="scorecard__table">
          <thead>
            <tr>
              <th scope="col">Engineer</th>
              <th scope="col">
                <abbr title="Commands run">Cmds</abbr>
              </th>
              <th scope="col">
                <abbr title="Commands that changed the cluster">Chg</abbr>
              </th>
              <th scope="col">
                <abbr title="Resolve calls made while the alert was still firing">Early</abbr>
              </th>
              <th scope="col">Fix</th>
            </tr>
          </thead>
          <tbody>
            {scorecard.map((tally) => (
              <tr key={tally.playerId} data-mvp={tally === mvp ? "true" : undefined}>
                <th scope="row">
                  {tally.name}
                  {tally === mvp && <span className="scorecard__mvp"> MVP</span>}
                  <span className="scorecard__role">{ROLE_INFO[tally.role].label}</span>
                </th>
                <td>{tally.commands}</td>
                <td>{tally.changes}</td>
                <td>{tally.earlyDeclares}</td>
                <td>{tally.isFixer ? <span aria-label="Fixed the root cause">✓</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
