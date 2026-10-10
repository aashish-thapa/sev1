-- Players asking to invest: pending → accepted (it becomes an investment offer to them) / declined / withdrawn.
CREATE TABLE investment_proposals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  investor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  equity_bps INTEGER NOT NULL CHECK (equity_bps > 0 AND equity_bps <= 10000),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  -- The proposer's Idempotency-Key, so a retried proposal is made once.
  request_key TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (investor_user_id, request_key)
);
-- One proposal in play per player and company.
CREATE UNIQUE INDEX investment_proposals_one_pending ON investment_proposals (company_id, investor_user_id) WHERE status = 'pending';
CREATE INDEX investment_proposals_by_investor ON investment_proposals (investor_user_id, status);
