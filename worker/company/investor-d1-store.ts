import type { PromisedMoney } from "../../src/domain/audit.ts";
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import type { BookLine } from "../../src/domain/company/investors.ts";
import { payRef } from "../../src/domain/economy.ts";
import type { Holding, PendingDividend } from "../../src/storage/company-protocol.ts";
import type { InvestorBank, SaveMoves } from "../api/store.ts";
import type { InvestorStore, OfferRow, OfferStatus, ReceivedOfferRow, ShareRow } from "./investor-store.ts";

type OfferRecord = {
  id: string;
  company_id: string;
  investor_user_id: string;
  investor: string;
  amount_cents: number;
  equity_bps: number;
  status: OfferStatus;
  invest_ref: string;
  expires_at: number | null;
  created_at: number;
};

const OFFER_COLUMNS =
  "investment_offers.id, investment_offers.company_id, investment_offers.investor_user_id, investors.username AS investor, investment_offers.amount_cents, " +
  "investment_offers.equity_bps, investment_offers.status, investment_offers.invest_ref, investment_offers.expires_at, investment_offers.created_at";

const toOffer = (row: OfferRecord): OfferRow => ({
  id: row.id,
  companyId: row.company_id,
  investorId: row.investor_user_id,
  investor: row.investor,
  amountCents: row.amount_cents,
  equityBps: row.equity_bps,
  status: row.status,
  investRef: row.invest_ref,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

/** The accepted offer a save's investment spend pays for, matched by its ref and its investor. */
const ACCEPTED = "FROM investment_offers WHERE invest_ref = ?1 AND investor_user_id = ?2 AND status = 'accepted'";

/**
 * What a save's investments and dividend claims write, in the save's own batch. An investment dilutes
 * every stake (integer division floors, like applyInvestment), adds the investor's stake, books the
 * money into the company and closes the offer — each step conditional on the offer still being
 * accepted, so a replayed save changes nothing. No expiry check here: the audit already found the
 * offer live, and refusing now would take the investor's money without giving them the stake.
 */
export function investorMoveStatements(db: D1Database, userId: string, moves: SaveMoves, at: number): D1PreparedStatement[] {
  const investments = moves.investRefs.flatMap((ref) => [
    db
      .prepare(`UPDATE company_shares SET bps = (bps * (10000 - (SELECT equity_bps ${ACCEPTED}))) / 10000 WHERE company_id = (SELECT company_id ${ACCEPTED})`)
      .bind(ref, userId),
    db
      .prepare(
        `INSERT INTO company_shares (company_id, user_id, bps, invested_cents) SELECT company_id, investor_user_id, equity_bps, amount_cents ${ACCEPTED} ` +
          "ON CONFLICT (company_id, user_id) DO UPDATE SET bps = company_shares.bps + excluded.bps, invested_cents = company_shares.invested_cents + excluded.invested_cents",
      )
      .bind(ref, userId),
    db
      .prepare(
        "INSERT INTO company_ledger (id, company_id, ref, amount_cents, reason, work_day, user_id, note, created_at) " +
          "SELECT ?3, offers.company_id, offers.invest_ref, offers.amount_cents, 'investment', companies.work_day, offers.investor_user_id, users.username, ?4 " +
          "FROM investment_offers AS offers JOIN companies ON companies.id = offers.company_id JOIN users ON users.id = offers.investor_user_id " +
          "WHERE offers.invest_ref = ?1 AND offers.investor_user_id = ?2 AND offers.status = 'accepted' ON CONFLICT (company_id, ref) DO NOTHING",
      )
      .bind(ref, userId, crypto.randomUUID(), at),
    db.prepare("UPDATE investment_offers SET status = 'completed', expires_at = NULL WHERE invest_ref = ?1 AND investor_user_id = ?2 AND status = 'accepted'").bind(ref, userId),
  ]);
  const dividends = moves.dividendIds.map((id) =>
    db.prepare("UPDATE dividend_payouts SET claimed_at = ? WHERE id = ? AND user_id = ? AND claimed_at IS NULL").bind(at, id, userId),
  );
  return [...investments, ...dividends];
}

export class D1InvestorStore implements InvestorStore, InvestorBank {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async claimsFor(userId: string, now: number): Promise<Pick<PromisedMoney, "investments" | "dividends">> {
    const [offers, dividends] = await this.db.batch([
      this.db.prepare("SELECT invest_ref, amount_cents FROM investment_offers WHERE investor_user_id = ? AND status = 'accepted' AND expires_at > ?").bind(userId, now),
      this.db.prepare("SELECT id, amount_cents FROM dividend_payouts WHERE user_id = ? AND claimed_at IS NULL").bind(userId),
    ]);
    return {
      investments: new Map((offers.results as { invest_ref: string; amount_cents: number }[]).map((row) => [row.invest_ref, row.amount_cents])),
      dividends: new Map((dividends.results as { id: string; amount_cents: number }[]).map((row) => [payRef.dividend(row.id), row.amount_cents])),
    };
  }

  async shares(companyId: string): Promise<ShareRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT company_shares.user_id, users.username, company_shares.bps, company_shares.invested_cents FROM company_shares JOIN users ON users.id = company_shares.user_id " +
          "WHERE company_id = ? AND company_shares.bps > 0 ORDER BY company_shares.bps DESC, users.username",
      )
      .bind(companyId)
      .all<{ user_id: string; username: string; bps: number; invested_cents: number }>();
    return results.map((row) => ({ userId: row.user_id, username: row.username, bps: row.bps, investedCents: row.invested_cents }));
  }

  async liveOffers(companyId: string): Promise<OfferRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${OFFER_COLUMNS} FROM investment_offers JOIN users AS investors ON investors.id = investment_offers.investor_user_id ` +
          "WHERE investment_offers.company_id = ? AND investment_offers.status IN ('open', 'accepted') ORDER BY investment_offers.created_at",
      )
      .bind(companyId)
      .all<OfferRecord>();
    return results.map(toOffer);
  }

  async offer(id: string): Promise<OfferRow | null> {
    const row = await this.db
      .prepare(`SELECT ${OFFER_COLUMNS} FROM investment_offers JOIN users AS investors ON investors.id = investment_offers.investor_user_id WHERE investment_offers.id = ?`)
      .bind(id)
      .first<OfferRecord>();
    return row ? toOffer(row) : null;
  }

  async createOffer(offer: OfferRow, requestKey: string | null): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT INTO investment_offers (id, company_id, investor_user_id, amount_cents, equity_bps, status, invest_ref, expires_at, request_key, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (company_id, request_key) DO NOTHING",
      )
      .bind(offer.id, offer.companyId, offer.investorId, offer.amountCents, offer.equityBps, offer.status, offer.investRef, offer.expiresAt, requestKey, offer.createdAt)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async setStatus(id: string, from: readonly OfferStatus[], to: OfferStatus, expiresAt: number | null = null): Promise<boolean> {
    const placeholders = from.map(() => "?").join(", ");
    const result = await this.db
      .prepare(`UPDATE investment_offers SET status = ?, expires_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .bind(to, expiresAt, id, ...from)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async receivedOffers(userId: string): Promise<ReceivedOfferRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${OFFER_COLUMNS}, companies.name AS company_name, companies.category, founders.username AS founder, companies.work_day, ` +
          "(SELECT COALESCE(SUM(amount_cents), 0) FROM company_ledger WHERE company_ledger.company_id = companies.id AND reason = 'revenue') AS lifetime_revenue " +
          "FROM investment_offers JOIN users AS investors ON investors.id = investment_offers.investor_user_id " +
          "JOIN companies ON companies.id = investment_offers.company_id JOIN users AS founders ON founders.id = companies.founder_id " +
          "WHERE investment_offers.investor_user_id = ? AND investment_offers.status IN ('open', 'accepted') AND companies.state = 'active' ORDER BY investment_offers.created_at",
      )
      .bind(userId)
      .all<OfferRecord & { company_name: string; category: CategoryId; founder: string; work_day: number; lifetime_revenue: number }>();
    return results.map((row) => ({
      ...toOffer(row),
      companyName: row.company_name,
      category: row.category,
      founder: row.founder,
      workDay: row.work_day,
      lifetimeRevenueCents: row.lifetime_revenue,
    }));
  }

  async holdings(userId: string): Promise<Holding[]> {
    const { results } = await this.db
      .prepare(
        "SELECT company_shares.company_id, companies.name, company_shares.bps, company_shares.invested_cents FROM company_shares JOIN companies ON companies.id = company_shares.company_id " +
          "WHERE company_shares.user_id = ? AND company_shares.bps > 0 ORDER BY companies.name",
      )
      .bind(userId)
      .all<{ company_id: string; name: string; bps: number; invested_cents: number }>();
    return results.map((row) => ({ companyId: row.company_id, companyName: row.name, bps: row.bps, investedCents: row.invested_cents }));
  }

  async pendingDividends(userId: string): Promise<PendingDividend[]> {
    const { results } = await this.db
      .prepare(
        "SELECT dividend_payouts.id, dividend_payouts.company_id, companies.name, dividend_payouts.work_day, dividend_payouts.amount_cents FROM dividend_payouts " +
          "JOIN companies ON companies.id = dividend_payouts.company_id WHERE dividend_payouts.user_id = ? AND dividend_payouts.claimed_at IS NULL ORDER BY dividend_payouts.created_at",
      )
      .bind(userId)
      .all<{ id: string; company_id: string; name: string; work_day: number; amount_cents: number }>();
    return results.map((row) => ({ id: row.id, companyId: row.company_id, companyName: row.name, workDay: row.work_day, amountCents: row.amount_cents }));
  }

  async bookSince(companyId: string, afterWorkDay: number): Promise<BookLine[]> {
    // Every line; the dividend and tracker rules decide which ones are running the company.
    const { results } = await this.db
      .prepare("SELECT work_day, reason, amount_cents FROM company_ledger WHERE company_id = ? AND work_day > ?")
      .bind(companyId, afterWorkDay)
      .all<{ work_day: number; reason: string; amount_cents: number }>();
    return results.map((row) => ({ workDay: row.work_day, reason: row.reason, amountCents: row.amount_cents }));
  }
}
