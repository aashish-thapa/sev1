/**
 * A company's office: one private multiplayer room, entered by its members and by investors who have a
 * deal on the table with it (they come to meet). The code is
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
export type OfficeAccess = { readonly kind: "not-an-office" } | { readonly kind: "member" } | { readonly kind: "visitor" } | { readonly kind: "denied" };

/** Whether this player may visit this company's office: an investor meeting the founder over a deal. */
export type VisitorPass = (companyId: string, userId: string) => Promise<boolean>;

const CODE_ATTEMPTS = 8;

export class CompanyOffice {
  private readonly store: OfficeRoomStore;
  private readonly reserve: ReserveRoom;
  private readonly random: () => number;
  private readonly hasPass: VisitorPass;

  constructor(store: OfficeRoomStore, reserve: ReserveRoom, random: () => number, hasPass: VisitorPass = async () => false) {
    this.store = store;
    this.reserve = reserve;
    this.random = random;
    this.hasPass = hasPass;
  }

  /** The member's office room code, assigning and reserving one on first entry; null for non-members. */
  async enter(userId: string): Promise<{ readonly code: string } | null> {
    const companyId = await this.store.companyOfMember(userId);
    if (!companyId) return null;
    const code = await this.roomOf(companyId);
    return code ? { code } : null;
  }

  /** The company's office code, assigning and reserving one if nobody has entered yet; null if no code could be held. */
  async roomOf(companyId: string): Promise<string | null> {
    const existing = await this.store.roomCodeOf(companyId);
    if (existing) return existing;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = generateRoomCode(this.random, () => false);
      if (!code || !(await this.reserve(code))) continue;
      if (await this.store.assignRoomCode(companyId, code)) return code;
      // Another member got there first: use the code they assigned.
      const winner = await this.store.roomCodeOf(companyId);
      if (winner) return winner;
    }
    return null;
  }

  /** Offices are for members and visiting investors; every other code is an ordinary game room. */
  async access(code: string, userId: string | null): Promise<OfficeAccess> {
    const companyId = await this.store.companyOfRoom(code);
    if (!companyId) return { kind: "not-an-office" };
    if (!userId) return { kind: "denied" };
    if ((await this.store.companyOfMember(userId)) === companyId) return { kind: "member" };
    return (await this.hasPass(companyId, userId)) ? { kind: "visitor" } : { kind: "denied" };
  }
}
