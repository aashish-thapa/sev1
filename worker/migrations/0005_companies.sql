-- Startup mode: companies whose money lives only here. Funds are the sum of company_ledger.

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  founder_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'unfunded' until the founder's seed spend lands in a save, then 'active'.
  state TEXT NOT NULL DEFAULT 'unfunded',
  funding_ref TEXT NOT NULL UNIQUE,
  funding_cents INTEGER NOT NULL,
  funding_expires_at INTEGER NOT NULL,
  work_day INTEGER NOT NULL DEFAULT 0,
  -- UTC date (YYYY-MM-DD) of the last settled work day; one settlement per real day.
  last_settled_on TEXT,
  -- Set by the request that claimed the latest work day; only that request's bookings are written.
  settle_token TEXT,
  created_at INTEGER NOT NULL
);

-- A player belongs to at most one company.
CREATE TABLE company_members (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  pay_cents INTEGER NOT NULL,
  is_founder INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE company_invitations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  pay_cents INTEGER NOT NULL,
  -- 'pending', 'accepted' or 'declined'.
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX company_invitations_one_pending ON company_invitations (company_id, user_id) WHERE status = 'pending';
CREATE INDEX company_invitations_by_user ON company_invitations (user_id, status);

CREATE TABLE company_rooms (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  bought_at INTEGER NOT NULL
);
CREATE INDEX company_rooms_by_company ON company_rooms (company_id);

CREATE TABLE company_servers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  bought_at INTEGER NOT NULL
);
CREATE INDEX company_servers_by_company ON company_servers (company_id);

-- Signed lines; every booking carries a ref so a retry never books twice.
CREATE TABLE company_ledger (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  work_day INTEGER NOT NULL,
  user_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (company_id, ref)
);

-- Pay booked for a member at settlement; their next save claims it into their wallet exactly once.
CREATE TABLE company_payouts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_day INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX company_payouts_unclaimed ON company_payouts (user_id, claimed_at);
