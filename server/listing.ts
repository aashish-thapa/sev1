import { MAX_PLAYERS_PER_ROOM, type PublicRoom, type RoomVisibility } from "../src/multiplayer/protocol.ts";
import type { Room } from "./room.ts";

/** What a host knows about a room beyond the room itself: who may find it, and since when. */
export type RoomListing = { readonly visibility: RoomVisibility; readonly openedAt: number };

/**
 * How `room` appears in the public lobby, or null when it shouldn't: it's private, nobody is in it
 * to play with, it's full, or its incident is already over.
 */
export function publicListing(room: Room, listing: RoomListing): PublicRoom | null {
  const players = room.connectedCount;
  if (listing.visibility !== "public" || players === 0 || players >= MAX_PLAYERS_PER_ROOM || room.isClosed) return null;
  return {
    code: room.code,
    host: room.hostName ?? "Someone",
    players,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    scenarioTitle: room.scenario.title,
    openedAt: listing.openedAt,
  };
}

/** Newest first, so the lobby shows the rooms most likely to still be early in their incident. */
export function newestFirst(rooms: readonly PublicRoom[]): PublicRoom[] {
  return [...rooms].sort((left, right) => right.openedAt - left.openedAt);
}
