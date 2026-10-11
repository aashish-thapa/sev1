import type { LanePhase, Team, Winner } from "./versus.ts";

export const TEAM_LABEL: Readonly<Record<Team, string>> = { red: "Red", blue: "Blue" };

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

/** Overtime left as m:ss, rounded up so the clock never shows 0:00 while time remains. */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The pager's alert rate as a whole percentage. */
export function formatAlertRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
