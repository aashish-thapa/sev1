/**
 * A company's office: one private multiplayer room, entered only by its members. The code is
 * assigned the first time someone enters and kept for good, so everyone always lands in the same room.
 */
import { generateRoomCode } from "../../server/room-code.ts";

/** Where a company's room code lives, and who may use it. */
export interface OfficeRoomStore {
  /** The active company this player belongs to, if any. */
  companyOfMember(userId: string): Promise<string | null>;
  roomCodeOf(companyId: string): Promise<string | null>;
  /** False when the company already has a code, or the code belongs to another company. */
  assignRoomCode(companyId: string, code: string): Promise<boolean>;
  /** The company a room code belongs to, if it's an office. */
  companyOfRoom(code: string): Promise<string | null>;
}

/** Holds a code for a company office in the room host; false when a game room already uses that code. */
export type ReserveRoom = (code: string) => Promise<boolean>;

/** Who may open a room socket at this code. */
export type OfficeAccess = { readonly kind: "not-an-office" } | { readonly kind: "member" } | { readonly kind: "denied" };

const CODE_ATTEMPTS = 8;

export class CompanyOffice {
  private readonly store: OfficeRoomStore;
  private readonly reserve: ReserveRoom;
  private readonly random: () => number;

  constructor(store: OfficeRoomStore, reserve: ReserveRoom, random: () => number) {
    this.store = store;
    this.reserve = reserve;
    this.random = random;
  }

  /** The member's office room code, assigning and reserving one on first entry; null for non-members. */
  async enter(userId: string): Promise<{ readonly code: string } | null> {
    const companyId = await this.store.companyOfMember(userId);
    if (!companyId) return null;
    const existing = await this.store.roomCodeOf(companyId);
    if (existing) return { code: existing };
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = generateRoomCode(this.random, () => false);
      if (!code || !(await this.reserve(code))) continue;
      if (await this.store.assignRoomCode(companyId, code)) return { code };
      // Another member got there first: use the code they assigned.
      const winner = await this.store.roomCodeOf(companyId);
      if (winner) return { code: winner };
    }
    return null;
  }

  /** Offices are members only; every other code is an ordinary game room. */
  async access(code: string, userId: string | null): Promise<OfficeAccess> {
    const companyId = await this.store.companyOfRoom(code);
    if (!companyId) return { kind: "not-an-office" };
    if (!userId) return { kind: "denied" };
    return (await this.store.companyOfMember(userId)) === companyId ? { kind: "member" } : { kind: "denied" };
  }
}
