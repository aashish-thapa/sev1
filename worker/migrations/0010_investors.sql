-- Startup mode, phase 4: investors. Only investors' stakes are stored; the founder holds the rest
-- (10,000 bps less every stake), so the cap table always sums to the whole company.
CREATE TABLE company_shares (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bps INTEGER NOT NULL CHECK (bps >= 0 AND bps <= 10000),
  invested_cents INTEGER NOT NULL CHECK (invested_cents >= 0),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX company_shares_by_user ON company_shares (user_id);

-- open → accepted (the investor agreed; their save pays) → completed; or open → cancelled / declined.
CREATE TABLE investment_offers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  investor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  equity_bps INTEGER NOT NULL CHECK (equity_bps > 0 AND equity_bps <= 10000),
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'cancelled', 'declined', 'completed')),
  invest_ref TEXT NOT NULL UNIQUE,
  -- While accepted: until when the investor's save may still pay for it.
  expires_at INTEGER,
  -- The founder's Idempotency-Key, so a retried offer is made once.
  request_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (company_id, request_key)
);
CREATE INDEX investment_offers_by_company ON investment_offers (company_id, status);
CREATE INDEX investment_offers_by_investor ON investment_offers (investor_user_id, status);

CREATE TABLE dividend_payouts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_day INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX dividend_payouts_unclaimed ON dividend_payouts (user_id, claimed_at);
