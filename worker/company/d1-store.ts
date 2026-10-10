import { payRef } from "../../src/domain/economy.ts";
import { roomKindById, type CategoryId, type RoomKindId, type ServerTierId } from "../../src/domain/company/catalog.ts";
import { FOUNDING_PURCHASES } from "../../src/domain/company/rules.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { PendingPayout, ReceivedInvitation } from "../../src/storage/company-protocol.ts";
import type { CompanyBank, CompanyPromises, SaveMoves } from "../api/store.ts";
import type { BookLine, BookReason, CompanyRow, CompanyState, CompanyStore, CompanyView, InvitationRow, MemberRow, Purchase, SettledDay } from "./store.ts";

/** The first bay is bought from the seed the moment the company is funded; its ref makes that happen once. */
const FOUNDING_ROOM_REF = "room:founding";

type CompanyRecord = {
  id: string;
  name: string;
  category: CategoryId;
  founder_id: string;
  state: CompanyState;
  funding_ref: string;
  funding_cents: number;
  funding_expires_at: number;
  work_day: number;
  last_settled_on: string | null;
  created_at: number;
};

const toCompany = (row: CompanyRecord): CompanyRow => ({
  id: row.id,
  name: row.name,
  category: row.category,
  founderId: row.founder_id,
  state: row.state,
  fundingRef: row.funding_ref,
  fundingCents: row.funding_cents,
  fundingExpiresAt: row.funding_expires_at,
  workDay: row.work_day,
  lastSettledOn: row.last_settled_on,
  createdAt: row.created_at,
});

/**
 * What a save's company moves write, in the save's own batch: a seed funds the company it was issued
 * for (and buys its first bay), a payroll claim marks its payout paid. Every write is conditional, so a
 * replayed or forged move changes nothing.
 */
export function companyMoveStatements(db: D1Database, userId: string, moves: SaveMoves, at: number): D1PreparedStatement[] {
  const funding = moves.fundingRefs.flatMap((ref) => [
    db
      // No expiry check here: the audit already found the intent live, and this write rides in the same batch as the
      // save that debits the wallet — refusing it now would take the founder's money without funding the company.
      .prepare("UPDATE companies SET state = 'active' WHERE funding_ref = ? AND founder_id = ? AND state = 'unfunded'")
      .bind(ref, userId),
    db
      .prepare(
        "INSERT INTO company_ledger (id, company_id, ref, amount_cents, reason, work_day, user_id, note, created_at) " +
          "SELECT ?, id, funding_ref, funding_cents, 'seed', 0, founder_id, NULL, ? FROM companies WHERE funding_ref = ? AND state = 'active' " +
          "ON CONFLICT (company_id, ref) DO NOTHING",
      )
      .bind(crypto.randomUUID(), at, ref),
    db
      .prepare(
        "INSERT INTO company_ledger (id, company_id, ref, amount_cents, reason, work_day, user_id, note, created_at) " +
          "SELECT ?, id, ?, ?, 'room-purchase', 0, NULL, ?, ? FROM companies WHERE funding_ref = ? AND state = 'active' " +
          "ON CONFLICT (company_id, ref) DO NOTHING",
      )
      .bind(crypto.randomUUID(), FOUNDING_ROOM_REF, -roomKindById(FOUNDING_PURCHASES.room).costCents, roomKindById(FOUNDING_PURCHASES.room).title, at, ref),
    db
      .prepare("INSERT OR IGNORE INTO company_rooms (id, company_id, kind, bought_at) SELECT id || ':room:founding', id, ?, ? FROM companies WHERE funding_ref = ? AND state = 'active'")
      .bind(FOUNDING_PURCHASES.room, at, ref),
    // The starter server is free and sits in the bay's closet, so day one can earn: a row, no ledger line.
    db
      .prepare("INSERT OR IGNORE INTO company_servers (id, company_id, tier, bought_at) SELECT id || ':server:founding', id, ?, ? FROM companies WHERE funding_ref = ? AND state = 'active'")
      .bind(FOUNDING_PURCHASES.server, at, ref),
  ]);
  const claims = moves.payoutIds.map((id) =>
    db.prepare("UPDATE company_payouts SET claimed_at = ? WHERE id = ? AND user_id = ? AND claimed_at IS NULL").bind(at, id, userId),
  );
  return [...funding, ...claims];
}

export class D1CompanyStore implements CompanyStore, CompanyBank {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async claimsFor(userId: string, now: number): Promise<CompanyPromises> {
    const [fundings, payouts] = await this.db.batch([
      this.db.prepare("SELECT funding_ref, funding_cents FROM companies WHERE founder_id = ? AND state = 'unfunded' AND funding_expires_at > ?").bind(userId, now),
      this.db.prepare("SELECT id, amount_cents FROM company_payouts WHERE user_id = ? AND claimed_at IS NULL").bind(userId),
    ]);
    return {
      fundings: new Map((fundings.results as { funding_ref: string; funding_cents: number }[]).map((row) => [row.funding_ref, row.funding_cents])),
      payouts: new Map((payouts.results as { id: string; amount_cents: number }[]).map((row) => [payRef.payroll(row.id), row.amount_cents])),
    };
  }

  async companyOf(userId: string): Promise<CompanyView | null> {
    const row = await this.db.prepare("SELECT company_id FROM company_members WHERE user_id = ?").bind(userId).first<{ company_id: string }>();
    return row ? this.companyById(row.company_id) : null;
  }

  async companyById(companyId: string): Promise<CompanyView | null> {
    const [company, funds, members, rooms, servers, invitations, ledger, revenue] = await this.db.batch([
      this.db.prepare("SELECT * FROM companies WHERE id = ?").bind(companyId),
      this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS funds FROM company_ledger WHERE company_id = ?").bind(companyId),
      this.db
        .prepare(
          "SELECT company_members.user_id, users.username, company_members.role, company_members.pay_cents, company_members.is_founder, company_members.joined_at, company_members.can_hire " +
            "FROM company_members JOIN users ON users.id = company_members.user_id WHERE company_id = ? ORDER BY company_members.joined_at",
        )
        .bind(companyId),
      this.db.prepare("SELECT kind FROM company_rooms WHERE company_id = ? ORDER BY bought_at, id").bind(companyId),
      this.db.prepare("SELECT tier FROM company_servers WHERE company_id = ? ORDER BY bought_at, id").bind(companyId),
      this.db
        .prepare(
          "SELECT company_invitations.id, company_invitations.company_id, company_invitations.user_id, users.username, company_invitations.role, company_invitations.pay_cents, company_invitations.status " +
            "FROM company_invitations JOIN users ON users.id = company_invitations.user_id WHERE company_id = ? AND status = 'pending' ORDER BY company_invitations.created_at",
        )
        .bind(companyId),
      this.db
        .prepare("SELECT created_at, work_day, reason, amount_cents, note FROM company_ledger WHERE company_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 60")
        .bind(companyId),
      this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS revenue FROM company_ledger WHERE company_id = ? AND reason = 'revenue'").bind(companyId),
    ]);
    const record = company.results[0] as CompanyRecord | undefined;
    if (!record) return null;
    return {
      company: toCompany(record),
      fundsCents: (funds.results[0] as { funds: number }).funds,
      members: (members.results as { user_id: string; username: string; role: Role; pay_cents: number; is_founder: number; joined_at: number; can_hire: number }[]).map(
        (row): MemberRow => ({
          userId: row.user_id,
          username: row.username,
          role: row.role,
          payCents: row.pay_cents,
          isFounder: row.is_founder === 1,
          joinedAt: row.joined_at,
          canHire: row.can_hire === 1,
        }),
      ),
      rooms: (rooms.results as { kind: RoomKindId }[]).map((row) => row.kind),
      servers: (servers.results as { tier: ServerTierId }[]).map((row) => row.tier),
      pendingInvitations: (invitations.results as { id: string; company_id: string; user_id: string; username: string; role: Role; pay_cents: number; status: InvitationRow["status"] }[]).map(
        (row): InvitationRow => ({ id: row.id, companyId: row.company_id, userId: row.user_id, username: row.username, role: row.role, payCents: row.pay_cents, status: row.status }),
      ),
      ledger: (ledger.results as { created_at: number; work_day: number; reason: BookReason; amount_cents: number; note: string | null }[])
        .map((row): BookLine => ({ at: row.created_at, workDay: row.work_day, reason: row.reason, amountCents: row.amount_cents, note: row.note }))
        .reverse(),
      lifetimeRevenueCents: (revenue.results[0] as { revenue: number }).revenue,
    };
  }

  async found(company: CompanyRow, founder: { readonly role: Role; readonly payCents: number }): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO companies (id, name, category, founder_id, state, funding_ref, funding_cents, funding_expires_at, work_day, last_settled_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(company.id, company.name, company.category, company.founderId, company.state, company.fundingRef, company.fundingCents, company.fundingExpiresAt, company.workDay, company.lastSettledOn, company.createdAt),
        this.db
          .prepare("INSERT INTO company_members (company_id, user_id, role, pay_cents, is_founder, joined_at) VALUES (?, ?, ?, ?, 1, ?)")
          .bind(company.id, company.founderId, founder.role, founder.payCents, company.createdAt),
      ]);
      return true;
    } catch (error) {
      // The batch is one transaction: a founder already seated elsewhere leaves nothing behind.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async dropUnfunded(companyId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM company_members WHERE company_id = ? AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND state = 'unfunded')").bind(companyId, companyId),
      this.db.prepare("DELETE FROM companies WHERE id = ? AND state = 'unfunded'").bind(companyId),
    ]);
  }

  async findUser(username: string): Promise<{ id: string; username: string } | null> {
    return this.db.prepare("SELECT id, username FROM users WHERE username = ?").bind(username).first<{ id: string; username: string }>();
  }

  async receivedInvitations(userId: string): Promise<ReceivedInvitation[]> {
    const { results } = await this.db
      .prepare(
        "SELECT company_invitations.id, companies.id AS company_id, companies.name, companies.category, founders.username AS founder, company_invitations.role, company_invitations.pay_cents " +
          "FROM company_invitations JOIN companies ON companies.id = company_invitations.company_id JOIN users AS founders ON founders.id = companies.founder_id " +
          "WHERE company_invitations.user_id = ? AND company_invitations.status = 'pending' AND companies.state = 'active' ORDER BY company_invitations.created_at",
      )
      .bind(userId)
      .all<{ id: string; company_id: string; name: string; category: CategoryId; founder: string; role: Role; pay_cents: number }>();
    return results.map((row) => ({ id: row.id, companyId: row.company_id, companyName: row.name, category: row.category, from: row.founder, role: row.role, payCents: row.pay_cents }));
  }

  async pendingPayouts(userId: string): Promise<PendingPayout[]> {
    const { results } = await this.db
      .prepare("SELECT id, amount_cents, company_id, work_day FROM company_payouts WHERE user_id = ? AND claimed_at IS NULL ORDER BY created_at")
      .bind(userId)
      .all<{ id: string; amount_cents: number; company_id: string; work_day: number }>();
    return results.map((row) => ({ id: row.id, amountCents: row.amount_cents, companyId: row.company_id, workDay: row.work_day }));
  }

  async isBooked(companyId: string, ref: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS found FROM company_ledger WHERE company_id = ? AND ref = ?").bind(companyId, ref).first()) !== null;
  }

  async buy(companyId: string, purchase: Purchase): Promise<"booked" | "duplicate" | "short"> {
    const reason: BookReason = purchase.kind === "room" ? "room-purchase" : "server-purchase";
    const note = purchase.kind === "room" ? roomKindById(purchase.item).title : purchase.item;
    // Charge first, and only while the funds still cover it; the item exists only if its charge does.
    const [charge] = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO company_ledger (id, company_id, ref, amount_cents, reason, work_day, user_id, note, created_at) " +
            "SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM company_ledger WHERE company_id = ?) >= ? " +
            "ON CONFLICT (company_id, ref) DO NOTHING",
        )
        .bind(crypto.randomUUID(), companyId, purchase.ref, -purchase.costCents, reason, purchase.workDay, note, purchase.at, companyId, purchase.costCents),
      purchase.kind === "room"
        ? this.db
            .prepare("INSERT OR IGNORE INTO company_rooms (id, company_id, kind, bought_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM company_ledger WHERE company_id = ? AND ref = ?)")
            .bind(purchase.id, companyId, purchase.item, purchase.at, companyId, purchase.ref)
        : this.db
            .prepare("INSERT OR IGNORE INTO company_servers (id, company_id, tier, bought_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM company_ledger WHERE company_id = ? AND ref = ?)")
            .bind(purchase.id, companyId, purchase.item, purchase.at, companyId, purchase.ref),
    ]);
    if ((charge.meta.changes ?? 0) > 0) return "booked";
    return (await this.isBooked(companyId, purchase.ref)) ? "duplicate" : "short";
  }

  async invite(invitation: { id: string; companyId: string; userId: string; role: Role; payCents: number; at: number }): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT OR IGNORE INTO company_invitations (id, company_id, user_id, role, pay_cents, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .bind(invitation.id, invitation.companyId, invitation.userId, invitation.role, invitation.payCents, invitation.at)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async invitation(id: string): Promise<InvitationRow | null> {
    const row = await this.db
      .prepare(
        "SELECT company_invitations.id, company_invitations.company_id, company_invitations.user_id, users.username, company_invitations.role, company_invitations.pay_cents, company_invitations.status " +
          "FROM company_invitations JOIN users ON users.id = company_invitations.user_id WHERE company_invitations.id = ?",
      )
      .bind(id)
      .first<{ id: string; company_id: string; user_id: string; username: string; role: Role; pay_cents: number; status: InvitationRow["status"] }>();
    return row ? { id: row.id, companyId: row.company_id, userId: row.user_id, username: row.username, role: row.role, payCents: row.pay_cents, status: row.status } : null;
  }

  async accept(invitation: InvitationRow, at: number): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO company_members (company_id, user_id, role, pay_cents, is_founder, joined_at) VALUES (?, ?, ?, ?, 0, ?)")
          .bind(invitation.companyId, invitation.userId, invitation.role, invitation.payCents, at),
        this.db.prepare("UPDATE company_invitations SET status = 'accepted' WHERE id = ? AND status = 'pending'").bind(invitation.id),
      ]);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async decline(invitationId: string): Promise<void> {
    await this.db.prepare("UPDATE company_invitations SET status = 'declined' WHERE id = ? AND status = 'pending'").bind(invitationId).run();
  }

  async setMember(companyId: string, userId: string, role: Role, payCents: number, canHire?: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE company_members SET role = ?, pay_cents = ?, can_hire = COALESCE(?, can_hire) WHERE company_id = ? AND user_id = ?")
      .bind(role, payCents, canHire === undefined ? null : canHire ? 1 : 0, companyId, userId)
      .run();
  }

  async settle(day: SettledDay): Promise<boolean> {
    // Claim the day first, under a token only this request knows; every booking below checks the token,
    // so a second member settling at the same moment books nothing.
    const token = crypto.randomUUID();
    const claimed = "EXISTS (SELECT 1 FROM companies WHERE id = ? AND settle_token = ?)";
    const [advance] = await this.db.batch([
      this.db
        .prepare(
          "UPDATE companies SET work_day = work_day + 1, last_settled_on = ?, settle_token = ? WHERE id = ? AND state = 'active' AND work_day = ? AND (last_settled_on IS NULL OR last_settled_on <> ?)",
        )
        .bind(day.today, token, day.companyId, day.fromWorkDay, day.today),
      ...day.lines.map((line) =>
        this.db
          .prepare(
            "INSERT INTO company_ledger (id, company_id, ref, amount_cents, reason, work_day, user_id, note, created_at) " +
              `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${claimed} ON CONFLICT (company_id, ref) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), day.companyId, line.ref, line.amountCents, line.reason, day.fromWorkDay + 1, line.userId, line.note, day.at, day.companyId, token),
      ),
      ...day.payouts.map((payout) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO company_payouts (id, company_id, user_id, work_day, amount_cents, claimed_at, created_at) SELECT ?, ?, ?, ?, ?, NULL, ? WHERE ${claimed}`)
          .bind(payout.id, day.companyId, payout.userId, day.fromWorkDay + 1, payout.amountCents, day.at, day.companyId, token),
      ),
      ...day.dividends.map((dividend) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO dividend_payouts (id, company_id, user_id, work_day, amount_cents, claimed_at, created_at) SELECT ?, ?, ?, ?, ?, NULL, ? WHERE ${claimed}`)
          .bind(dividend.id, day.companyId, dividend.userId, day.fromWorkDay + 1, dividend.amountCents, day.at, day.companyId, token),
      ),
      ...day.workIds.map((id) =>
        this.db
          .prepare(`UPDATE work_log SET settled_work_day = ? WHERE id = ? AND company_id = ? AND settled_work_day IS NULL AND ${claimed}`)
          .bind(day.fromWorkDay + 1, id, day.companyId, day.companyId, token),
      ),
    ]);
    return (advance.meta.changes ?? 0) > 0;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
