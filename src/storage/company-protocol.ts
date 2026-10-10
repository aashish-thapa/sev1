/**
 * Startup mode's wire contract. Company money lives only on the server (a ledger whose sum is the
 * balance). A player funds a company by spending from their own wallet against a funding ref the
 * server issued, and is paid by claiming payouts the server booked; the server never edits a save.
 */
import { z } from "zod";
import { CATEGORY_IDS, ROOM_KIND_IDS, SERVER_TIER_IDS } from "../domain/company/catalog.ts";
import { ROLE_IDS, type Role } from "../domain/incident.ts";

export const COMPANY_PATH = "/api/company";

const CategoryIdSchema = z.enum(CATEGORY_IDS);
const RoomKindIdSchema = z.enum(ROOM_KIND_IDS);
const ServerTierIdSchema = z.enum(SERVER_TIER_IDS);
const RoleSchema = z.enum(ROLE_IDS as [Role, ...Role[]]);
const Cents = z.int().nonnegative();
const SignedCents = z.int();

/** Unfunded until the founder's seed spend lands (it expires after a day); active after. */
export const COMPANY_STATES = ["unfunded", "active"] as const;

export const CompanyNameSchema = z.string().trim().min(3).max(40);

export const FoundRequestSchema = z.object({ name: CompanyNameSchema, category: CategoryIdSchema, role: RoleSchema, seedCents: Cents });
export type FoundRequest = z.input<typeof FoundRequestSchema>;

/** Spend exactly `seedCents` from the wallet with ref `fundingRef`; the next save funds the company. */
export const FoundResponseSchema = z.object({ companyId: z.string(), fundingRef: z.string(), seedCents: Cents });

export const LEDGER_REASONS = ["seed", "revenue", "room-upkeep", "server-upkeep", "contractor", "payroll", "room-purchase", "server-purchase"] as const;

export const CompanyMemberSchema = z.object({
  username: z.string(),
  role: RoleSchema,
  /** Per work day. */
  payCents: Cents,
  isFounder: z.boolean(),
  joinedAt: z.number(),
});

export const SentInvitationSchema = z.object({ id: z.string(), username: z.string(), role: RoleSchema, payCents: Cents });

export const CompanyLedgerLineSchema = z.object({
  at: z.number(),
  workDay: z.int().nonnegative(),
  reason: z.enum(LEDGER_REASONS),
  amountCents: SignedCents,
  /** Who a payroll line paid, or what a purchase bought. */
  note: z.string().nullable(),
});

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: CategoryIdSchema,
  state: z.enum(COMPANY_STATES),
  fundsCents: SignedCents,
  /** Work days settled so far. */
  workDay: z.int().nonnegative(),
  rooms: z.array(RoomKindIdSchema),
  servers: z.array(ServerTierIdSchema),
  members: z.array(CompanyMemberSchema),
  pendingInvitations: z.array(SentInvitationSchema),
  /** Newest last; the most recent lines only. */
  ledger: z.array(CompanyLedgerLineSchema).max(60),
  /** Present only while unfunded: the spend that will fund it. */
  funding: z.object({ ref: z.string(), seedCents: Cents, expiresAt: z.number() }).nullable(),
});
export type Company = z.output<typeof CompanySchema>;

/** An offer someone sent you: a role at a company, at a daily pay. */
export const ReceivedInvitationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  category: CategoryIdSchema,
  from: z.string(),
  role: RoleSchema,
  payCents: Cents,
});
export type ReceivedInvitation = z.output<typeof ReceivedInvitationSchema>;

/** Pay the server booked for you; earn it into your wallet with ref `payroll:<id>`. */
export const PendingPayoutSchema = z.object({ id: z.string(), amountCents: Cents, companyId: z.string(), workDay: z.int().nonnegative() });
export type PendingPayout = z.output<typeof PendingPayoutSchema>;

/** GET /api/company: your company (founded or joined), offers waiting for you, and pay to claim. */
export const MyCompanySchema = z.object({
  company: CompanySchema.nullable(),
  invitations: z.array(ReceivedInvitationSchema),
  payouts: z.array(PendingPayoutSchema),
});
export type MyCompany = z.output<typeof MyCompanySchema>;

export const BuyRoomRequestSchema = z.object({ room: RoomKindIdSchema });
export const BuyServerRequestSchema = z.object({ server: ServerTierIdSchema });
export const InviteRequestSchema = z.object({ username: z.string().trim().min(1).max(24), role: RoleSchema, payCents: Cents });
export const SetMemberRequestSchema = z.object({ username: z.string(), role: RoleSchema, payCents: Cents });

/**
 * POST /api/company/workday body: tasks the member shipped today. Phase 1 trusts it within a cap
 * (the server clamps it); phase 2 records each finished task on the server instead.
 */
export const SettleRequestSchema = z.object({ tasksShipped: z.int().nonnegative().max(50) });
export type SettleRequest = z.input<typeof SettleRequestSchema>;

/** POST /api/company/workday: what the settled day booked. */
export const WorkDaySettlementSchema = z.object({
  workDay: z.int().positive(),
  lines: z.array(CompanyLedgerLineSchema),
  fundsAfter: SignedCents,
  isPayrollShort: z.boolean(),
});
export type WorkDaySettlement = z.output<typeof WorkDaySettlementSchema>;
