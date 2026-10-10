-- Money an admin puts in a player's wallet (test money). The player's game claims each grant once,
-- in the same batch as the save that earns it; until then claimed_at is NULL.
CREATE TABLE admin_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  claimed_at INTEGER,
  -- A retried POST carries the same key, so it grants once. NULL keys are never deduplicated.
  idempotency_key TEXT,
  UNIQUE (granted_by, idempotency_key)
);
CREATE INDEX admin_grants_pending ON admin_grants (user_id, claimed_at);
