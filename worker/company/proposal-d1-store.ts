import type { MyProposalRow, ProposalCreated, ProposalRow, ProposalStatus, ProposalStore } from "./proposal-store.ts";

type ProposalRecord = {
  id: string;
  company_id: string;
  investor_user_id: string;
  investor: string;
  amount_cents: number;
  equity_bps: number;
  status: ProposalStatus;
  created_at: number;
};

const COLUMNS =
  "investment_proposals.id, investment_proposals.company_id, investment_proposals.investor_user_id, users.username AS investor, " +
  "investment_proposals.amount_cents, investment_proposals.equity_bps, investment_proposals.status, investment_proposals.created_at";
const FROM = "FROM investment_proposals JOIN users ON users.id = investment_proposals.investor_user_id";

const toProposal = (row: ProposalRecord): ProposalRow => ({
  id: row.id,
  companyId: row.company_id,
  investorId: row.investor_user_id,
  investor: row.investor,
  amountCents: row.amount_cents,
  equityBps: row.equity_bps,
  status: row.status,
  createdAt: row.created_at,
});

export class D1ProposalStore implements ProposalStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async create(proposal: ProposalRow, requestKey: string | null): Promise<ProposalCreated> {
    if (requestKey !== null) {
      const retried = await this.db.prepare("SELECT id FROM investment_proposals WHERE investor_user_id = ? AND request_key = ?").bind(proposal.investorId, requestKey).first();
      if (retried) return "duplicate";
    }
    try {
      await this.db
        .prepare(
          "INSERT INTO investment_proposals (id, company_id, investor_user_id, amount_cents, equity_bps, status, request_key, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(proposal.id, proposal.companyId, proposal.investorId, proposal.amountCents, proposal.equityBps, requestKey, proposal.createdAt)
        .run();
      return "created";
    } catch (error) {
      // The partial unique index refuses a second pending proposal to the same company.
      if (error instanceof Error && error.message.includes("UNIQUE")) return "already_pending";
      throw error;
    }
  }

  async proposal(id: string): Promise<ProposalRow | null> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE investment_proposals.id = ?`).bind(id).first<ProposalRecord>();
    return row ? toProposal(row) : null;
  }

  async pendingFor(companyId: string): Promise<ProposalRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} ${FROM} WHERE investment_proposals.company_id = ? AND investment_proposals.status = 'pending' ORDER BY investment_proposals.created_at`)
      .bind(companyId)
      .all<ProposalRecord>();
    return results.map(toProposal);
  }

  async pendingBy(userId: string): Promise<MyProposalRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS}, companies.name AS company_name ${FROM} JOIN companies ON companies.id = investment_proposals.company_id ` +
          "WHERE investment_proposals.investor_user_id = ? AND investment_proposals.status = 'pending' ORDER BY investment_proposals.created_at",
      )
      .bind(userId)
      .all<ProposalRecord & { company_name: string }>();
    return results.map((row) => ({ ...toProposal(row), companyName: row.company_name }));
  }

  async decide(id: string, to: Exclude<ProposalStatus, "pending">, at: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE investment_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(to, at, id).run();
    return result.meta.changes === 1;
  }
}
