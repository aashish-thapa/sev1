/**
 * A company's arithmetic: what it owns, who it pays, and how a work day settles. Pure: the server
 * holds the balance and runs these to decide what's allowed and what each day books.
 */
import type { Role } from "../incident.ts";
import {
  categoryById,
  FOUNDING_RUNWAY_DAYS,
  MAX_SHIPPED_BONUS,
  ROLE_MINIMUM_PAY_CENTS,
  roomKindById,
  ROOM_KINDS,
  serverTierById,
  SHIPPED_TASK_BONUS,
  STARTER_SERVER_TIER,
  type CategoryId,
  type RoomKindId,
  type ServerTierId,
} from "./catalog.ts";

/**
 * What funding a company sets up: the first bay, bought from the seed, and the starter server,
 * granted free (it isn't charged, so it isn't in the founding minimum).
 */
export const FOUNDING_PURCHASES: { readonly room: RoomKindId; readonly server: ServerTierId } = { room: "bay", server: STARTER_SERVER_TIER };

/**
 * The seed a founder must put in: the first bay (bought from the seed when funding lands) plus a week
 * of the best-paid role's minimum. The starter server comes free with it, so it isn't counted here.
 */
export const FOUNDING_MINIMUM_CENTS = roomKindById("bay").costCents + FOUNDING_RUNWAY_DAYS * Math.max(...Object.values(ROLE_MINIMUM_PAY_CENTS));

export type Member = {
  readonly userId: string;
  readonly role: Role;
  /** Agreed pay per work day, never below the role's minimum. */
  readonly payCents: number;
};

/** Everything settlement and the rules need about a company; the server builds it from D1. */
export type CompanyBook = {
  readonly category: CategoryId;
  readonly fundsCents: number;
  readonly members: readonly Member[];
  readonly rooms: readonly RoomKindId[];
  readonly servers: readonly ServerTierId[];
};

export type OfferProblem = "below_minimum" | "no_free_desk";

/** Whether `payCents` a day for `role` is a valid offer, given the desks already taken or promised. */
export function checkOffer(book: CompanyBook, role: Role, payCents: number, pendingInvitations: number): OfferProblem | null {
  if (!Number.isInteger(payCents) || payCents < ROLE_MINIMUM_PAY_CENTS[role]) return "below_minimum";
  if (book.members.length + pendingInvitations >= seats(book.rooms)) return "no_free_desk";
  return null;
}

export function seats(rooms: readonly RoomKindId[]): number {
  return rooms.reduce((sum, room) => sum + roomKindById(room).seats, 0);
}

export function racks(rooms: readonly RoomKindId[]): number {
  return rooms.reduce((sum, room) => sum + roomKindById(room).racks, 0);
}

export function capacityRps(servers: readonly ServerTierId[]): number {
  return servers.reduce((sum, server) => sum + serverTierById(server).capacityRps, 0);
}

export type PurchaseProblem = "not_enough_funds" | "no_free_rack";

export function checkRoomPurchase(book: CompanyBook, room: RoomKindId): PurchaseProblem | null {
  return book.fundsCents < roomKindById(room).costCents ? "not_enough_funds" : null;
}

export function checkServerPurchase(book: CompanyBook, server: ServerTierId): PurchaseProblem | null {
  if (book.servers.length >= racks(book.rooms)) return "no_free_rack";
  return book.fundsCents < serverTierById(server).costCents ? "not_enough_funds" : null;
}

/** Key roles nobody in the company holds: their issues need a contractor. */
export function uncoveredRoles(book: CompanyBook): Role[] {
  const held = new Set(book.members.map((member) => member.role));
  return categoryById(book.category).keyRoles.filter((role) => !held.has(role));
}

/** What happened during the work day being settled. */
export type WorkDayReport = {
  /** Share of the day the product was healthy, 0…1. */
  readonly healthyShare: number;
  readonly tasksShipped: number;
  /** Contractor fees booked for issues resolved during the day. */
  readonly contractorCents: number;
};

export type LedgerReason = "revenue" | "room-upkeep" | "server-upkeep" | "contractor" | "payroll";

/** One signed line in the company's books; payroll lines name the member paid. */
export type LedgerLine = { readonly reason: LedgerReason; readonly amountCents: number; readonly userId?: string };

export type Settlement = {
  readonly lines: readonly LedgerLine[];
  /** What each member is owed for the day; becomes a claimable payout on the server. */
  readonly payroll: readonly { readonly userId: string; readonly amountCents: number }[];
  /** Can go below zero when upkeep outruns funds and revenue; payroll itself never does. */
  readonly fundsAfter: number;
  /** True when funds couldn't cover full pay: everyone got the same share of what was left. */
  readonly isPayrollShort: boolean;
};

/**
 * Books one work day: revenue comes in first, then upkeep and contractors, then payroll. If the
 * money runs short, every member gets the same fraction of their pay rather than some going unpaid.
 */
export function settleWorkDay(book: CompanyBook, report: WorkDayReport): Settlement {
  const category = categoryById(book.category);
  const healthy = Math.min(1, Math.max(0, report.healthyShare));
  const served = category.demandRps === 0 ? 1 : Math.min(1, capacityRps(book.servers) / category.demandRps);
  const shipped = 1 + Math.min(MAX_SHIPPED_BONUS, Math.max(0, report.tasksShipped) * SHIPPED_TASK_BONUS);
  const revenue = Math.round(category.baseRevenueCents * healthy * served * shipped);
  const roomUpkeep = book.rooms.reduce((sum, room) => sum + roomKindById(room).upkeepCents, 0);
  const serverUpkeep = book.servers.reduce((sum, server) => sum + serverTierById(server).upkeepCents, 0);
  const contractor = Math.max(0, Math.round(report.contractorCents));

  const lines: LedgerLine[] = [];
  if (revenue > 0) lines.push({ reason: "revenue", amountCents: revenue });
  if (roomUpkeep > 0) lines.push({ reason: "room-upkeep", amountCents: -roomUpkeep });
  if (serverUpkeep > 0) lines.push({ reason: "server-upkeep", amountCents: -serverUpkeep });
  if (contractor > 0) lines.push({ reason: "contractor", amountCents: -contractor });

  const available = Math.max(0, book.fundsCents + revenue - roomUpkeep - serverUpkeep - contractor);
  const owed = book.members.reduce((sum, member) => sum + member.payCents, 0);
  const share = owed === 0 || available >= owed ? 1 : available / owed;
  const payroll = book.members.map((member) => ({ userId: member.userId, amountCents: Math.floor(member.payCents * share) }));
  for (const pay of payroll) if (pay.amountCents > 0) lines.push({ reason: "payroll", amountCents: -pay.amountCents, userId: pay.userId });

  const fundsAfter = book.fundsCents + lines.reduce((sum, line) => sum + line.amountCents, 0);
  return { lines, payroll, fundsAfter, isPayrollShort: share < 1 };
}

/** Kinds of room a company can buy, in the order the HQ lists them. */
export const PURCHASABLE_ROOMS = ROOM_KINDS.map((room) => room.id);
