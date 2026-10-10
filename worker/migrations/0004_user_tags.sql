-- Granted marks such as "creator": set by operators on the server, never claimable from a client.
ALTER TABLE users ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
