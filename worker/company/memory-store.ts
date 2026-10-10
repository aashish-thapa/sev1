/** In-memory company books with the same conditional writes as D1, for tests. */
import { roomKindById, type RoomKindId, type ServerTierId } from "../../src/domain/company/catalog.ts";
import { FOUNDING_PURCHASES } from "../../src/domain/company/rules.ts";
import { payRef } from "../../src/domain/economy.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { PendingPayout, ReceivedInvitation } from "../../src/storage/company-protocol.ts";
import type { CompanyBank, CompanyPromises, SaveMoves } from "../api/store.ts";
import type { BookLine, BookReason, CompanyRow, CompanyStore, CompanyView, InvitationRow, MemberRow, Purchase, SettledDay } from "./store.ts";

type Line = BookLine & { readonly companyId: string; readonly ref: string };

export class MemoryCompanyStore implements CompanyStore, CompanyBank {
  readonly usernames = new Map<string, string>();
  readonly companies = new Map<string, CompanyRow>();
  readonly members: (MemberRow & { companyId: string })[] = [];
  readonly invitations = new Map<string, InvitationRow & { at: number }>();
  readonly rooms: { companyId: string; id: string; kind: RoomKindId }[] = [];
  readonly servers: { companyId: string; id: string; tier: ServerTierId }[] = [];
  readonly ledger: Line[] = [];
  readonly payouts = new Map<string, { id: string; companyId: string; userId: string; workDay: number; amountCents: number; claimedAt: number | null }>();

  addUser(id: string, username: string): void {
    this.usernames.set(id, username);
  }

  /** What D1 does with a save's company moves (see companyMoveStatements). */
  applyMoves(userId: string, moves: SaveMoves, at: number): void {
    for (const ref of moves.fundingRefs) {
      const company = [...this.companies.values()].find((candidate) => candidate.fundingRef === ref);
      // Like D1: the audit already found the intent live, so the save that debits the wallet always activates it.
      if (!company || company.founderId !== userId || company.state !== "unfunded") continue;
      this.companies.set(company.id, { ...company, state: "active" });
      this.book(company.id, { ref, reason: "seed", amountCents: company.fundingCents, at, workDay: 0, note: null });
      const room = roomKindById(FOUNDING_PURCHASES.room);
      this.book(company.id, { ref: "room:founding", reason: "room-purchase", amountCents: -room.costCents, at, workDay: 0, note: room.title });
      if (!this.rooms.some((owned) => owned.id === `${company.id}:room:founding`)) this.rooms.push({ companyId: company.id, id: `${company.id}:room:founding`, kind: FOUNDING_PURCHASES.room });
      // The starter server is free (no ledger line), like D1.
      if (!this.servers.some((owned) => owned.id === `${company.id}:server:founding`)) this.servers.push({ companyId: company.id, id: `${company.id}:server:founding`, tier: FOUNDING_PURCHASES.server });
    }
    for (const id of moves.payoutIds) {
      const payout = this.payouts.get(id);
      if (payout && payout.userId === userId && payout.claimedAt === null) this.payouts.set(id, { ...payout, claimedAt: at });
    }
  }

  async claimsFor(userId: string, now: number): Promise<CompanyPromises> {
    return {
      fundings: new Map(
        [...this.companies.values()].filter((company) => company.founderId === userId && company.state === "unfunded" && company.fundingExpiresAt > now).map((company) => [company.fundingRef, company.fundingCents]),
      ),
      payouts: new Map([...this.payouts.values()].filter((payout) => payout.userId === userId && payout.claimedAt === null).map((payout) => [payRef.payroll(payout.id), payout.amountCents])),
    };
  }

  async companyOf(userId: string): Promise<CompanyView | null> {
    const member = this.members.find((candidate) => candidate.userId === userId);
    return member ? this.companyById(member.companyId) : null;
  }

  async companyById(companyId: string): Promise<CompanyView | null> {
    const company = this.companies.get(companyId);
    if (!company) return null;
    const lines = this.ledger.filter((line) => line.companyId === companyId);
    return {
      company,
      fundsCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      members: this.members.filter((member) => member.companyId === companyId),
      rooms: this.rooms.filter((room) => room.companyId === companyId).map((room) => room.kind),
      servers: this.servers.filter((server) => server.companyId === companyId).map((server) => server.tier),
      pendingInvitations: [...this.invitations.values()].filter((invitation) => invitation.companyId === companyId && invitation.status === "pending"),
      ledger: lines.map(({ at, workDay, reason, amountCents, note }) => ({ at, workDay, reason, amountCents, note })),
    };
  }

  async found(company: CompanyRow, founder: { role: Role; payCents: number }): Promise<boolean> {
    if (this.members.some((member) => member.userId === company.founderId)) return false;
    this.companies.set(company.id, company);
    this.members.push({ companyId: company.id, userId: company.founderId, username: this.usernames.get(company.founderId) ?? "", role: founder.role, payCents: founder.payCents, isFounder: true, joinedAt: company.createdAt });
    return true;
  }

  async dropUnfunded(companyId: string): Promise<void> {
    if (this.companies.get(companyId)?.state !== "unfunded") return;
    this.companies.delete(companyId);
    for (let index = this.members.length - 1; index >= 0; index -= 1) if (this.members[index].companyId === companyId) this.members.splice(index, 1);
  }

  async findUser(username: string): Promise<{ id: string; username: string } | null> {
    const entry = [...this.usernames.entries()].find(([, name]) => name === username);
    return entry ? { id: entry[0], username: entry[1] } : null;
  }

  async receivedInvitations(userId: string): Promise<ReceivedInvitation[]> {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.userId === userId && invitation.status === "pending" && this.companies.get(invitation.companyId)?.state === "active")
      .map((invitation) => {
        const company = this.companies.get(invitation.companyId) as CompanyRow;
        return { id: invitation.id, companyId: company.id, companyName: company.name, category: company.category, from: this.usernames.get(company.founderId) ?? "", role: invitation.role, payCents: invitation.payCents };
      });
  }

  async pendingPayouts(userId: string): Promise<PendingPayout[]> {
    return [...this.payouts.values()]
      .filter((payout) => payout.userId === userId && payout.claimedAt === null)
      .map((payout) => ({ id: payout.id, amountCents: payout.amountCents, companyId: payout.companyId, workDay: payout.workDay }));
  }

  async isBooked(companyId: string, ref: string): Promise<boolean> {
    return this.ledger.some((line) => line.companyId === companyId && line.ref === ref);
  }

  async buy(companyId: string, purchase: Purchase): Promise<"booked" | "duplicate" | "short"> {
    if (this.ledger.some((line) => line.companyId === companyId && line.ref === purchase.ref)) return "duplicate";
    const funds = this.ledger.filter((line) => line.companyId === companyId).reduce((sum, line) => sum + line.amountCents, 0);
    if (funds < purchase.costCents) return "short";
    const reason: BookReason = purchase.kind === "room" ? "room-purchase" : "server-purchase";
    this.book(companyId, { ref: purchase.ref, reason, amountCents: -purchase.costCents, at: purchase.at, workDay: purchase.workDay, note: null });
    if (purchase.kind === "room") this.rooms.push({ companyId, id: purchase.id, kind: purchase.item });
    else this.servers.push({ companyId, id: purchase.id, tier: purchase.item });
    return "booked";
  }

  async invite(invitation: { id: string; companyId: string; userId: string; role: Role; payCents: number; at: number }): Promise<boolean> {
    const pending = [...this.invitations.values()].some((other) => other.companyId === invitation.companyId && other.userId === invitation.userId && other.status === "pending");
    if (pending) return false;
    this.invitations.set(invitation.id, { ...invitation, username: this.usernames.get(invitation.userId) ?? "", status: "pending" });
    return true;
  }

  async invitation(id: string): Promise<InvitationRow | null> {
    return this.invitations.get(id) ?? null;
  }

  async accept(invitation: InvitationRow, at: number): Promise<boolean> {
    if (this.members.some((member) => member.userId === invitation.userId)) return false;
    this.members.push({ companyId: invitation.companyId, userId: invitation.userId, username: invitation.username, role: invitation.role, payCents: invitation.payCents, isFounder: false, joinedAt: at });
    const stored = this.invitations.get(invitation.id);
    if (stored) this.invitations.set(invitation.id, { ...stored, status: "accepted" });
    return true;
  }

  async decline(invitationId: string): Promise<void> {
    const stored = this.invitations.get(invitationId);
    if (stored?.status === "pending") this.invitations.set(invitationId, { ...stored, status: "declined" });
  }

  async setMember(companyId: string, userId: string, role: Role, payCents: number): Promise<void> {
    const index = this.members.findIndex((member) => member.companyId === companyId && member.userId === userId);
    if (index >= 0) this.members[index] = { ...this.members[index], role, payCents };
  }

  async settle(day: SettledDay): Promise<boolean> {
    const company = this.companies.get(day.companyId);
    if (!company || company.state !== "active" || company.workDay !== day.fromWorkDay || company.lastSettledOn === day.today) return false;
    this.companies.set(company.id, { ...company, workDay: company.workDay + 1, lastSettledOn: day.today });
    for (const line of day.lines) this.book(day.companyId, { ref: line.ref, reason: line.reason, amountCents: line.amountCents, at: day.at, workDay: day.fromWorkDay + 1, note: line.note });
    for (const payout of day.payouts) {
      if (!this.payouts.has(payout.id)) this.payouts.set(payout.id, { ...payout, companyId: day.companyId, workDay: day.fromWorkDay + 1, claimedAt: null });
    }
    return true;
  }

  private book(companyId: string, line: Omit<Line, "companyId">): void {
    if (this.ledger.some((existing) => existing.companyId === companyId && existing.ref === line.ref)) return;
    this.ledger.push({ ...line, companyId });
  }
}
