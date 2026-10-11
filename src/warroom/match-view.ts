import { TEAM_LABEL, type LanePhase, type LaneStanding, type Team, type Winner } from "./versus.ts";

export const LANE_PHASE_LABEL: Readonly<Record<LanePhase, string>> = {
  waiting: "Waiting",
  live: "Firing",
  monitoring: "Monitoring",
  closed: "Closed",
};

/** How a decided match reads to one player; a player without a side only sees who won. */
export type MatchOutcome = "won" | "lost" | "draw" | "watched";

export function outcomeFor(winner: Winner, team: Team | null): MatchOutcome {
  if (winner === "draw") return "draw";
  if (team === null) return "watched";
  return winner === team ? "won" : "lost";
}

/** What a lane is called: its side, or the bot crew that plays it. */
export function laneName(lane: Pick<LaneStanding, "team" | "crew">): string {
  return lane.crew === "bots" ? "Bot crew" : TEAM_LABEL[lane.team];
}

/** Overtime left as m:ss, rounded up so the clock never shows 0:00 while time remains. */
export function formatCountdown(msLeft: number): string {
  return asClock(Math.ceil(msLeft / 1000));
}

/** Time spent so far as m:ss, counting whole seconds. */
export function formatElapsed(msElapsed: number): string {
  return asClock(Math.floor(msElapsed / 1000));
}

function asClock(seconds: number): string {
  const whole = Math.max(0, seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The pager's alert rate as a whole percentage. */
export function formatAlertRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
