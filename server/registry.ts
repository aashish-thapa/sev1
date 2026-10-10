import type { PublicRoom, RoomVisibility } from "../src/multiplayer/protocol.ts";
import type { Scenario } from "../src/warroom/scenario.ts";
import { newestFirst, publicListing, type RoomListing } from "./listing.ts";
import type { Logger } from "./log.ts";
import { generateRoomCode } from "./room-code.ts";
import { Room, type RoomTiming } from "./room.ts";
import type { RoomDirectory } from "./session.ts";

export type RegistryOptions = {
  readonly maxRooms: number;
  /** How long a room with nobody connected survives before it is torn down. */
  readonly roomGraceMs: number;
  readonly timing: RoomTiming;
  readonly random: () => number;
  readonly logger: Logger;
  /** Epoch milliseconds, for when each room opened. */
  readonly now: () => number;
};

/** Owns every live room in the process: creation under a cap, lookup by code, and expiry once abandoned. */
export class RoomRegistry implements RoomDirectory {
  private readonly rooms = new Map<string, Room>();
  private readonly listings = new Map<string, RoomListing>();
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Null when the process is at its room cap or no free code could be found. */
  create(scenario: Scenario, visibility: RoomVisibility): Room | null {
    if (this.rooms.size >= this.options.maxRooms) return null;
    const code = generateRoomCode(this.options.random, (candidate) => this.rooms.has(candidate));
    if (!code) return null;
    const room = new Room(code, scenario, this.options.timing, this.options.logger, (changed) => this.occupancyChanged(changed));
    this.rooms.set(code, room);
    this.listings.set(code, { visibility, openedAt: this.options.now() });
    this.options.logger("info", "room_created", { room: code, scenario: scenario.id, visibility, rooms: this.rooms.size });
    this.occupancyChanged(room);
    return room;
  }

  find(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Public rooms someone could join right now. */
  listPublic(): PublicRoom[] {
    const listed = [...this.rooms.values()].flatMap((room) => {
      const listing = this.listings.get(room.code);
      const entry = listing ? publicListing(room, listing) : null;
      return entry ? [entry] : [];
    });
    return newestFirst(listed);
  }

  closeAll() {
    for (const code of [...this.rooms.keys()]) this.remove(code);
  }

  private occupancyChanged(room: Room) {
    const pending = this.expiries.get(room.code);
    if (room.connectedCount > 0) {
      if (pending) clearTimeout(pending);
      this.expiries.delete(room.code);
    } else if (!pending) {
      this.expiries.set(
        room.code,
        setTimeout(() => this.remove(room.code), this.options.roomGraceMs),
      );
    }
  }

  private remove(code: string) {
    const expiry = this.expiries.get(code);
    if (expiry) clearTimeout(expiry);
    this.expiries.delete(code);
    this.rooms.get(code)?.dispose();
    this.listings.delete(code);
    if (this.rooms.delete(code)) this.options.logger("info", "room_expired", { room: code, rooms: this.rooms.size });
  }
}
