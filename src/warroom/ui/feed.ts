import type { Incident } from "../incident.ts";
import type { CommsMessage } from "../scenario.ts";
import type { TerminalLine } from "./useIncident.ts";

/**
 * Everything the office needs from a running incident, wherever it runs:
 * the local simulation for solo play, or the room server for a team.
 */
export type IncidentFeed = {
  readonly incident: Incident;
  readonly terminal: readonly TerminalLine[];
  readonly history: readonly string[];
  readonly comms: readonly CommsMessage[];
  run(line: string): void;
  declare(): void;
  complete(line: string): { line: string; candidates: readonly string[] };
};

/** A teammate in a shared room, as the floor draws them. */
export type Teammate = {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
  /** The badge they chose to show (an achievements catalog id), or null. */
  readonly badge: string | null;
  readonly position: { readonly x: number; readonly z: number; readonly yaw: number } | null;
};

/** One line in the team activity feed: who ran what. */
export type TeamActivity = { readonly key: string; readonly text: string; readonly isChange: boolean };
