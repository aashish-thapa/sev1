import type { RoomMode } from "../src/multiplayer/protocol.ts";
import type { Scenario } from "../src/warroom/scenario.ts";
import type { Logger } from "./log.ts";
import { Match } from "./match.ts";
import type { Matchmaking, MatchmakingOutcome } from "./matchmaking.ts";
import { Room, type Connection, type JoinOutcome, type JoinRequest, type RoomTiming } from "./room.ts";

/** Whatever a room code leads to: one shared incident, or a versus match between two of them. */
export interface Venue {
  readonly code: string;
  readonly scenario: Scenario;
  readonly mode: RoomMode;
  /** Most engineers it seats. */
  readonly capacity: number;
  readonly hostName: string | null;
  readonly connectedCount: number;
  /** Nothing left to play: the incident closed, or the match is decided. */
  readonly isClosed: boolean;
  join(request: JoinRequest, connection: Connection): JoinOutcome;
  /** Present on a venue that can look for opponents: what matchmaking decided for it. */
  onMatchmaking?(outcome: MatchmakingOutcome): void;
  dispose(): void;
}

export type VenueSetup = {
  readonly code: string;
  readonly scenario: Scenario;
  readonly timing: RoomTiming;
  readonly logger: Logger;
  /** Called when who's connected changes, or play ends: what hosts track for expiry and listing. */
  readonly onOccupancyChange: (venue: Venue) => void;
  readonly matchmaking: Matchmaking;
};

export function openVenue(mode: RoomMode, { code, scenario, timing, logger, onOccupancyChange, matchmaking }: VenueSetup): Venue {
  if (mode === "coop") return new Room(code, scenario, timing, logger, onOccupancyChange);
  return new Match(code, scenario, timing, logger, onOccupancyChange, { format: mode, matchmaking });
}
