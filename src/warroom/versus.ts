/**
 * Versus rules: two teams race their own copy of the same seeded incident. The simulation is
 * deterministic, so both sides face exactly the same outage; only what they do differs.
 */

export const TEAMS = ["red", "blue"] as const;
export type Team = (typeof TEAMS)[number];

export const TEAM_LABEL: Readonly<Record<Team, string>> = { red: "Red", blue: "Blue" };

export const PLAYERS_PER_TEAM = 3;

/** Once one side closes its incident, the other has this long to close theirs. */
export const OVERTIME_MS = 3 * 60_000;

/** Where a team's copy of the incident stands; `waiting` until the match starts. */
export type LanePhase = "waiting" | "live" | "monitoring" | "closed";

/** How a closed incident scored: debrief points (postmortem assumed right) and the simulated second it closed. */
export type Finish = { readonly points: number; readonly closedAt: number };

export type LaneStanding = {
  readonly team: Team;
  readonly players: number;
  readonly phase: LanePhase;
  /** The rate the pager watches, 0…1. */
  readonly alertRate: number;
  readonly reopenCount: number;
  readonly finish: Finish | null;
};

export type Winner = Team | "draw";

/** The side a new player joins: the smaller one, red when they're level. */
export function pickTeam(headcount: Readonly<Record<Team, number>>): Team | null {
  const open = TEAMS.filter((team) => headcount[team] < PLAYERS_PER_TEAM);
  if (open.length === 0) return null;
  return open.reduce((best, team) => (headcount[team] < headcount[best] ? team : best));
}

/**
 * The winner once every side has closed or overtime has run out; null while it's still open.
 * Points decide it, then the earlier close; a side that never closed can't win.
 */
export function decide(standings: readonly LaneStanding[], isOvertimeOver: boolean): Winner | null {
  const isEveryoneDone = standings.every((lane) => lane.finish !== null);
  if (!isEveryoneDone && !isOvertimeOver) return null;
  const finished = standings.flatMap((lane) => (lane.finish ? [{ team: lane.team, ...lane.finish }] : []));
  const ranked = finished.sort((left, right) => right.points - left.points || left.closedAt - right.closedAt);
  const [first, second] = ranked;
  if (!first) return "draw";
  if (second && second.points === first.points && second.closedAt === first.closedAt) return "draw";
  return first.team;
}

/** Where the match is: picking sides, racing, one side done and the clock on the other, or over. */
export type MatchStage =
  | { readonly name: "lineup" }
  | { readonly name: "racing" }
  | { readonly name: "overtime"; readonly msLeft: number }
  | { readonly name: "decided"; readonly winner: Winner };

/** A race nobody closes ends here, with whatever has closed by then. */
export const MATCH_TIME_LIMIT_MS = 30 * 60_000;
