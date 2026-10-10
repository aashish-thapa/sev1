import type { AccountStore, LedgerRow, SavedProgress, User } from "./store.ts";

type UserRow = { id: string; username: string; password_hash: string; created_at: number };

const toUser = (row: UserRow): User => ({ id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at });

export class D1AccountStore implements AccountStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async findUser(username: string): Promise<User | null> {
    const row = await this.db.prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?").bind(username).first<UserRow>();
    return row ? toUser(row) : null;
  }

  async createUser(user: User): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING")
      .bind(user.id, user.username, user.passwordHash, user.createdAt)
      .run();
    return result.meta.changes === 1;
  }

  async createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
    await this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, expiresAt).run();
  }

  async findSessionUser(tokenHash: string, now: number): Promise<User | null> {
    const row = await this.db
      .prepare(
        "SELECT users.id, users.username, users.password_hash, users.created_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
      )
      .bind(tokenHash, now)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async loadProgress(userId: string): Promise<SavedProgress | null> {
    const row = await this.db.prepare("SELECT body, updated_at FROM progress WHERE user_id = ?").bind(userId).first<{ body: string; updated_at: number }>();
    return row ? { body: row.body, updatedAt: row.updated_at } : null;
  }

  async saveProgress(userId: string, progress: SavedProgress, credits: readonly LedgerRow[]): Promise<void> {
    // One batch is one transaction: the saved wallet and the books never disagree about what was booked.
    await this.db.batch([
      this.db
        .prepare("INSERT INTO progress (user_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
        .bind(userId, progress.body, progress.updatedAt),
      ...credits.map((credit) =>
        this.db
          .prepare("INSERT INTO ledger (id, user_id, amount_cents, reason, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, source_ref) DO NOTHING")
          .bind(credit.id, userId, credit.amountCents, credit.reason, credit.sourceRef, credit.createdAt),
      ),
    ]);
  }

  async ledgerBalance(userId: string): Promise<number> {
    const row = await this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE user_id = ?").bind(userId).first<{ balance: number }>();
    return row?.balance ?? 0;
  }

  async countAttempt(key: string, windowStart: number): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO attempts (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN attempts.window_start = excluded.window_start THEN attempts.count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count",
      )
      .bind(key, windowStart)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }
}
