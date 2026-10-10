-- What an account has paid for. Written only by verified Stripe webhooks (and the checkout that creates the customer).
CREATE TABLE entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  pro_until INTEGER,
  subscription_id TEXT,
  subscription_status TEXT,
  -- Stripe event `created` (seconds) of the last subscription change applied; older events never overwrite newer ones.
  subscription_event_at INTEGER NOT NULL DEFAULT 0,
  cosmetics TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Stripe retries deliveries; each event is applied once.
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
