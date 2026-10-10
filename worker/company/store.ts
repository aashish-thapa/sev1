/** What the company service needs from storage: D1 in production, memory in tests. Money moves are conditional writes. */
import type { CategoryId, RoomKindId, ServerTierId } from "../../src/domain/company/catalog.ts";
import type { LedgerReason } from "../../src/domain/company/rules.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { LEDGER_REASONS, PendingPayout, ReceivedInvitation } from "../../src/storage/company-protocol.ts";

export type CompanyState = "unfunded" | "active";
export type BookReason = (typeof LEDGER_REASONS)[number];

export type CompanyRow = {
  readonly id: string;
  readonly name: string;
  readonly category: CategoryId;
  readonly founderId: string;
  readonly state: CompanyState;
  readonly fundingRef: string;
  readonly fundingCents: number;
  readonly fundingExpiresAt: number;
  readonly workDay: number;
  /** UTC date of the last settled work day, or null before the first. */
  readonly lastSettledOn: string | null;
  readonly createdAt: number;
};

export type MemberRow = {
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
  readonly payCents: number;
  readonly isFounder: boolean;
  readonly joinedAt: number;
  /** May open postings and hire; the founder always may. */
  readonly canHire: boolean;
};

export type InvitationRow = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
  readonly payCents: number;
  readonly status: "pending" | "accepted" | "declined";
};

export type BookLine = { readonly at: number; readonly workDay: number; readonly reason: BookReason; readonly amountCents: number; readonly note: string | null };

/** A company as the rules and the HQ see it, read in one go. */
export type CompanyView = {
  readonly company: CompanyRow;
  readonly fundsCents: number;
  readonly members: readonly MemberRow[];
  readonly rooms: readonly RoomKindId[];
  readonly servers: readonly ServerTierId[];
  readonly pendingInvitations: readonly InvitationRow[];
  /** Newest last. */
  readonly ledger: readonly BookLine[];
  /** Every revenue line ever booked; with work days, it sets the company's level. */
  readonly lifetimeRevenueCents: number;
};

/** Something bought from company funds: booked only if the funds still cover it when written. */
export type Purchase =
  | { readonly kind: "room"; readonly item: RoomKindId; readonly id: string; readonly ref: string; readonly costCents: number; readonly at: number; readonly workDay: number }
  | { readonly kind: "server"; readonly item: ServerTierId; readonly id: string; readonly ref: string; readonly costCents: number; readonly at: number; readonly workDay: number };

/** One work day's bookings, written only if the company is still on the day it was settled from. */
export type SettledDay = {
  readonly companyId: string;
  readonly fromWorkDay: number;
  readonly today: string;
  readonly at: number;
  readonly lines: readonly { readonly ref: string; readonly reason: LedgerReason; readonly amountCents: number; readonly userId: string | null; readonly note: string | null }[];
  readonly payouts: readonly { readonly id: string; readonly userId: string; readonly amountCents: number }[];
};

export interface CompanyStore {
  /** The company this player founded or joined, if any. */
  companyOf(userId: string): Promise<CompanyView | null>;
  companyById(companyId: string): Promise<CompanyView | null>;
  /** False when the founder already belongs to a company. */
  found(company: CompanyRow, founder: { readonly role: Role; readonly payCents: number }): Promise<boolean>;
  /** Drops a company that was never funded (its founder may found again). */
  dropUnfunded(companyId: string): Promise<void>;
  findUser(username: string): Promise<{ readonly id: string; readonly username: string } | null>;
  receivedInvitations(userId: string): Promise<ReceivedInvitation[]>;
  pendingPayouts(userId: string): Promise<PendingPayout[]>;
  /** Whether a booking under this ref exists: a retried purchase is recognised before anything is re-checked. */
  isBooked(companyId: string, ref: string): Promise<boolean>;
  /** "duplicate" when this ref was already booked (a retry); "short" when the funds no longer cover it. */
  buy(companyId: string, purchase: Purchase): Promise<"booked" | "duplicate" | "short">;
  /** False when this player already has a pending offer from the company. */
  invite(invitation: { readonly id: string; readonly companyId: string; readonly userId: string; readonly role: Role; readonly payCents: number; readonly at: number }): Promise<boolean>;
  invitation(id: string): Promise<InvitationRow | null>;
  /** Joins the company and closes the offer; false when the player already belongs to a company. */
  accept(invitation: InvitationRow, at: number): Promise<boolean>;
  decline(invitationId: string): Promise<void>;
  /** `canHire` undefined leaves the member's hiring permission as it is. */
  setMember(companyId: string, userId: string, role: Role, payCents: number, canHire?: boolean): Promise<void>;
  /** False when another settlement got there first. */
  settle(day: SettledDay): Promise<boolean>;
}
