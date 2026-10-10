import type { PendingGrant } from "../api/store.ts";
import type { GrantRow, GrantStore, NewGrant } from "./store.ts";

type Row = { id: string; user_id: string; username: string; amount_cents: number; note: string; granted_by: string; granted_at: number; claimed_at: number | null };

const SELECT = "SELECT admin_grants.id, admin_grants.user_id, users.username, amount_cents, note, granted_by, granted_at, claimed_at FROM admin_grants JOIN users ON users.id = admin_grants.user_id";

const toGrant = (row: Row): GrantRow => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  amountCents: row.amount_cents,
  note: row.note,
  grantedBy: row.granted_by,
  grantedAt: row.granted_at,
  claimedAt: row.claimed_at,
});

/** Marks grants claimed by the save that earned them; conditional, so a replayed or forged claim changes nothing. */
export function grantClaimStatements(db: D1Database, userId: string, grantIds: readonly string[], at: number): D1PreparedStatement[] {
  return grantIds.map((id) => db.prepare("UPDATE admin_grants SET claimed_at = ? WHERE id = ? AND user_id = ? AND claimed_at IS NULL").bind(at, id, userId));
}

export class D1GrantStore implements GrantStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async create(grant: NewGrant): Promise<{ grant: GrantRow; isNew: boolean }> {
    await this.db
      .prepare(
        "INSERT INTO admin_grants (id, user_id, amount_cents, note, granted_by, granted_at, claimed_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) " +
          "ON CONFLICT (granted_by, idempotency_key) DO NOTHING",
      )
      .bind(grant.id, grant.userId, grant.amountCents, grant.note, grant.grantedBy, grant.grantedAt, grant.idempotencyKey)
      .run();
    const stored =
      grant.idempotencyKey === null
        ? await this.db.prepare(`${SELECT} WHERE admin_grants.id = ?`).bind(grant.id).first<Row>()
        : await this.db.prepare(`${SELECT} WHERE granted_by = ? AND idempotency_key = ?`).bind(grant.grantedBy, grant.idempotencyKey).first<Row>();
    if (!stored) throw new Error("admin grant vanished after insert");
    return { grant: toGrant(stored), isNew: stored.id === grant.id };
  }

  async pendingFor(userId: string): Promise<PendingGrant[]> {
    const { results } = await this.db
      .prepare("SELECT id, amount_cents, note, granted_at FROM admin_grants WHERE user_id = ? AND claimed_at IS NULL ORDER BY granted_at")
      .bind(userId)
      .all<{ id: string; amount_cents: number; note: string; granted_at: number }>();
    return results.map((row) => ({ id: row.id, amountCents: row.amount_cents, note: row.note, grantedAt: row.granted_at }));
  }

  async historyFor(userId: string, limit: number): Promise<GrantRow[]> {
    const { results } = await this.db.prepare(`${SELECT} WHERE admin_grants.user_id = ? ORDER BY granted_at DESC LIMIT ?`).bind(userId, limit).all<Row>();
    return results.map(toGrant);
  }
}
