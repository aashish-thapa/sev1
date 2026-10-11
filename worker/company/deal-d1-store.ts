import { DEAL_OFFER_PREFIX, type DealChange, type DealOpened, type DealRow, type DealStage, type DealStore } from "./deal-store.ts";

type DealRecord = {
  id: string;
  company_id: string;
  company_name: string;
  founder_user_id: string;
  founder: string;
  investor_user_id: string;
  investor: string;
  amount_cents: number;
  equity_bps: number;
  stage: DealStage;
  agreed_founder: number;
  agreed_investor: number;
  version: number;
  created_at: number;
};

const SELECT =
  "SELECT deals.id, deals.company_id, companies.name AS company_name, deals.founder_user_id, founders.username AS founder, deals.investor_user_id, " +
  "investors.username AS investor, deals.amount_cents, deals.equity_bps, deals.stage, deals.agreed_founder, deals.agreed_investor, deals.version, deals.created_at " +
  "FROM investment_deals AS deals JOIN companies ON companies.id = deals.company_id " +
  "JOIN users AS founders ON founders.id = deals.founder_user_id JOIN users AS investors ON investors.id = deals.investor_user_id";

const toDeal = (row: DealRecord): DealRow => ({
  id: row.id,
  companyId: row.company_id,
  companyName: row.company_name,
  founderId: row.founder_user_id,
  founder: row.founder,
  investorId: row.investor_user_id,
  investor: row.investor,
  terms: { amountCents: row.amount_cents, equityBps: row.equity_bps },
  stage: row.stage,
  agreedFounder: row.agreed_founder === 1,
  agreedInvestor: row.agreed_investor === 1,
  version: row.version,
  createdAt: row.created_at,
});

export class D1DealStore implements DealStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async open(deal: Omit<DealRow, "companyName" | "founder" | "investor" | "version">, requestKey: string | null): Promise<DealOpened> {
    if (requestKey !== null && (await this.dealByKey(deal.companyId, requestKey))) return "duplicate";
    try {
      await this.db
        .prepare(
          "INSERT INTO investment_deals (id, company_id, founder_user_id, investor_user_id, amount_cents, equity_bps, stage, agreed_founder, agreed_investor, request_key, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'talking', 0, 0, ?, ?)",
        )
        .bind(deal.id, deal.companyId, deal.founderId, deal.investorId, deal.terms.amountCents, deal.terms.equityBps, requestKey, deal.createdAt)
        .run();
      return "opened";
    } catch (error) {
      if (!(error instanceof Error && /UNIQUE constraint failed/i.test(error.message))) throw error;
      // A retry racing the first request, or a deal already on the table with this investor.
      return requestKey !== null && (await this.dealByKey(deal.companyId, requestKey)) ? "duplicate" : "already_talking";
    }
  }

  async deal(id: string): Promise<DealRow | null> {
    const row = await this.db.prepare(`${SELECT} WHERE deals.id = ?`).bind(id).first<DealRecord>();
    return row ? toDeal(row) : null;
  }

  async dealByKey(companyId: string, requestKey: string): Promise<DealRow | null> {
    const row = await this.db.prepare(`${SELECT} WHERE deals.company_id = ? AND deals.request_key = ?`).bind(companyId, requestKey).first<DealRecord>();
    return row ? toDeal(row) : null;
  }

  async change(id: string, version: number, next: DealChange): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE investment_deals SET amount_cents = ?, equity_bps = ?, stage = ?, agreed_founder = ?, agreed_investor = ?, version = version + 1 WHERE id = ? AND version = ?",
      )
      .bind(next.terms.amountCents, next.terms.equityBps, next.stage, next.agreedFounder ? 1 : 0, next.agreedInvestor ? 1 : 0, id, version)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async openFor(userId: string): Promise<DealRow[]> {
    const { results } = await this.db
      .prepare(
        `${SELECT} LEFT JOIN investment_offers AS offers ON offers.id = ?2 || deals.id ` +
          "WHERE (deals.founder_user_id = ?1 OR deals.investor_user_id = ?1) AND (deals.stage = 'talking' OR (deals.stage = 'agreed' AND offers.status = 'accepted')) " +
          "ORDER BY deals.created_at",
      )
      .bind(userId, DEAL_OFFER_PREFIX)
      .all<DealRecord>();
    return results.map(toDeal);
  }

  async isTalkingWith(companyId: string, investorId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM investment_deals WHERE company_id = ? AND investor_user_id = ? AND stage = 'talking'")
      .bind(companyId, investorId)
      .first();
    return row !== null;
  }
}

