import type { Scenario } from "../src/warroom/scenario.ts";
import type { Logger } from "./log.ts";
import { generateRoomCode } from "./room-code.ts";
import { Room, type RoomTiming } from "./room.ts";

export type RegistryOptions = {
  readonly maxRooms: number;
  /** How long a room with nobody connected survives before it is torn down. */
  readonly roomGraceMs: number;
  readonly timing: RoomTiming;
  readonly random: () => number;
  readonly logger: Logger;
};

/** Owns every live room in the process: creation under a cap, lookup by code, and expiry once abandoned. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Null when the process is at its room cap or no free code could be found. */
  create(scenario: Scenario): Room | null {
    if (this.rooms.size >= this.options.maxRooms) return null;
    const code = generateRoomCode(this.options.random, (candidate) => this.rooms.has(candidate));
    if (!code) return null;
    const room = new Room(code, scenario, this.options.timing, this.options.logger, (changed) => this.occupancyChanged(changed));
    this.rooms.set(code, room);
    this.options.logger("info", "room_created", { room: code, scenario: scenario.id, rooms: this.rooms.size });
    this.occupancyChanged(room);
    return room;
  }

  find(code: string): Room | undefined {
    return this.rooms.get(code);
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
    if (this.rooms.delete(code)) this.options.logger("info", "room_expired", { room: code, rooms: this.rooms.size });
  }
}
