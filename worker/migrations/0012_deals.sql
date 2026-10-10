-- Investments agreed in person: talking → agreed (an accepted investment offer 'deal:<id>' then carries the money) / walked-away.
CREATE TABLE investment_deals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  founder_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  investor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  equity_bps INTEGER NOT NULL CHECK (equity_bps > 0 AND equity_bps <= 10000),
  stage TEXT NOT NULL CHECK (stage IN ('talking', 'agreed', 'walked-away')),
  agreed_founder INTEGER NOT NULL DEFAULT 0,
  agreed_investor INTEGER NOT NULL DEFAULT 0,
  -- Bumped on every change, so two answers to the same terms can't both land.
  version INTEGER NOT NULL DEFAULT 0,
  -- Whoever opened it (the founder's offer, or the proposal it came from), so a retry opens it once.
  request_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (company_id, request_key)
);
-- One deal on the table per investor and company.
CREATE UNIQUE INDEX investment_deals_one_talking ON investment_deals (company_id, investor_user_id) WHERE stage = 'talking';
CREATE INDEX investment_deals_by_investor ON investment_deals (investor_user_id, stage);
CREATE INDEX investment_deals_by_founder ON investment_deals (founder_user_id, stage);
