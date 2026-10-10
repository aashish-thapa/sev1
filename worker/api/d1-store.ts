import { z } from "zod";
import type { Title } from "../../src/domain/career.ts";
import { companyMoveStatements } from "../company/d1-store.ts";
import { NO_COMPANY_MOVES, type AccountStore, type CompanyMoves, type LedgerRow, type RankedAccount, type SavedProgress, type Standing, type User } from "./store.ts";

const TagsSchema = z.array(z.string().min(1).max(40)).max(16);

type UserRow = { id: string; username: string; password_hash: string; created_at: number; tags: string };

/** Tags are a JSON array in one column; anything unreadable counts as none rather than failing a sign-in. */
function parseTags(raw: string | null | undefined): string[] {
  const parsed = TagsSchema.safeParse((() => {
    try {
      return JSON.parse(raw ?? "[]");
    } catch {
      return [];
    }
  })());
  return parsed.success ? parsed.data : [];
}

const toUser = (row: UserRow): User => ({ id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at, tags: parseTags(row.tags) });

export class D1AccountStore implements AccountStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async findUser(username: string): Promise<User | null> {
    const row = await this.db.prepare("SELECT id, username, password_hash, created_at, tags FROM users WHERE username = ?").bind(username).first<UserRow>();
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
        "SELECT users.id, users.username, users.password_hash, users.created_at, users.tags FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
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

  async saveProgress(userId: string, progress: SavedProgress, standing: Standing, credits: readonly LedgerRow[], moves: CompanyMoves = NO_COMPANY_MOVES): Promise<void> {
    // One batch is one transaction: the saved wallet, its standing and the books never disagree.
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO progress (user_id, body, updated_at, experience, title, featured_badge) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, experience = excluded.experience, title = excluded.title, featured_badge = excluded.featured_badge",
        )
        .bind(userId, progress.body, progress.updatedAt, standing.experience, standing.title, standing.featuredBadge),
      ...credits.map((credit) =>
        this.db
          .prepare("INSERT INTO ledger (id, user_id, amount_cents, reason, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, source_ref) DO NOTHING")
          .bind(credit.id, userId, credit.amountCents, credit.reason, credit.sourceRef, credit.createdAt),
      ),
      ...companyMoveStatements(this.db, userId, moves, progress.updatedAt),
    ]);
  }

  async topAccounts(limit: number): Promise<RankedAccount[]> {
    const { results } = await this.db
      .prepare(
        "SELECT users.username, users.tags, progress.experience, progress.title, progress.featured_badge FROM progress JOIN users ON users.id = progress.user_id " +
          "ORDER BY progress.experience DESC, progress.updated_at ASC LIMIT ?",
      )
      .bind(limit)
      .all<{ username: string; tags: string; experience: number; title: Title; featured_badge: string | null }>();
    return results.map((row) => ({ username: row.username, tags: parseTags(row.tags), experience: row.experience, title: row.title, featuredBadge: row.featured_badge }));
  }

  async rankOf(userId: string): Promise<{ rank: number; experience: number } | null> {
    const row = await this.db
      .prepare(
        "SELECT mine.experience AS experience, (SELECT COUNT(*) FROM progress AS other WHERE other.experience > mine.experience " +
          "OR (other.experience = mine.experience AND other.updated_at < mine.updated_at)) + 1 AS rank FROM progress AS mine WHERE mine.user_id = ?",
      )
      .bind(userId)
      .first<{ experience: number; rank: number }>();
    return row ? { rank: row.rank, experience: row.experience } : null;
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
