import type { PublicRoom, RoomVisibility } from "../src/multiplayer/protocol.ts";
import type { Venue } from "./venue.ts";

/** What a host knows about a room beyond the room itself: who may find it, and since when. */
export type RoomListing = { readonly visibility: RoomVisibility; readonly openedAt: number };

/**
 * How `room` appears in the public lobby, or null when it shouldn't: it's private, nobody is in it
 * to play with, it's full, or its incident is already over.
 */
export function publicListing(room: Venue, listing: RoomListing): PublicRoom | null {
  const players = room.connectedCount;
  if (listing.visibility !== "public" || players === 0 || players >= room.capacity || room.isClosed) return null;
  return {
    code: room.code,
    host: room.hostName ?? "Someone",
    players,
    maxPlayers: room.capacity,
    scenarioTitle: room.scenario.title,
    mode: room.mode,
    openedAt: listing.openedAt,
  };
}

/** Newest first, so the lobby shows the rooms most likely to still be early in their incident. */
export function newestFirst(rooms: readonly PublicRoom[]): PublicRoom[] {
  return [...rooms].sort((left, right) => right.openedAt - left.openedAt);
}
