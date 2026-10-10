import { z } from "zod";
import type { Title } from "../../src/domain/career.ts";
import type { AdminStore, AdminUserRow, RawStats, WarRoomTotals } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TagsSchema = z.array(z.string());

function parseTags(raw: string): string[] {
  try {
    const parsed = TagsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** LIKE treats % and _ as wildcards; a username search means them literally. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export class D1AdminStore implements AdminStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async stats(now: number, signupsSince: number, passingPoints: number): Promise<RawStats> {
    const [accounts, signupDays, activity, levels, warRooms, cards, ledger, pro] = await this.db.batch([
      this.db
        .prepare(
          "SELECT COUNT(*) AS total, SUM(created_at >= ?1) AS newToday, SUM(created_at >= ?2) AS new7d, SUM(created_at >= ?3) AS new30d FROM users",
        )
        .bind(now - DAY_MS, now - 7 * DAY_MS, now - 30 * DAY_MS),
      this.db
        .prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count FROM users WHERE created_at >= ? GROUP BY day")
        .bind(signupsSince),
      this.db.prepare("SELECT SUM(updated_at >= ?1) AS active1d, SUM(updated_at >= ?2) AS active7d FROM progress").bind(now - DAY_MS, now - 7 * DAY_MS),
      this.db.prepare("SELECT title, COUNT(*) AS count FROM progress GROUP BY title"),
      this.db
        .prepare(
          "SELECT room.key AS scenarioId, COUNT(*) AS players, SUM(json_extract(room.value, '$.plays')) AS plays, " +
            "SUM(json_extract(room.value, '$.bestPoints') >= ?) AS passed, SUM(json_extract(room.value, '$.bestGrade') = 'S') AS sGrades " +
            "FROM progress, json_each(progress.body, '$.warRoom') AS room GROUP BY room.key ORDER BY players DESC",
        )
        .bind(passingPoints),
      this.db.prepare("SELECT SUM(json_extract(body, '$.correctCards')) AS total FROM progress"),
      this.db.prepare("SELECT reason, SUM(amount_cents) AS cents, COUNT(*) AS lines FROM ledger GROUP BY reason"),
      this.db.prepare("SELECT SUM(pro_until > ?) AS active, SUM(subscription_id IS NOT NULL) AS everSubscribed FROM entitlements").bind(now),
    ]);
    const first = <Row>(result: D1Result<unknown>) => (result.results[0] ?? {}) as Partial<Row>;
    const count = (value: unknown) => (typeof value === "number" ? value : 0);
    const totals = first<{ total: number; newToday: number; new7d: number; new30d: number }>(accounts);
    const active = first<{ active1d: number; active7d: number }>(activity);
    const byReason = new Map((ledger.results as { reason: string; cents: number; lines: number }[]).map((row) => [row.reason, row]));
    const subscribers = first<{ active: number; everSubscribed: number }>(pro);
    return {
      accounts: { total: count(totals.total), newToday: count(totals.newToday), new7d: count(totals.new7d), new30d: count(totals.new30d) },
      signupDays: (signupDays.results as { day: string; count: number }[]).map((row) => ({ day: row.day, count: count(row.count) })),
      activity: { active1d: count(active.active1d), active7d: count(active.active7d) },
      levels: (levels.results as { title: Title; count: number }[]).map((row) => ({ title: row.title, count: count(row.count) })),
      warRooms: (warRooms.results as WarRoomTotals[]).map((row) => ({
        scenarioId: row.scenarioId,
        players: count(row.players),
        plays: count(row.plays),
        passed: count(row.passed),
        sGrades: count(row.sGrades),
      })),
      correctCards: count(first<{ total: number }>(cards).total),
      earnedCents: { salary: count(byReason.get("salary")?.cents), card: count(byReason.get("card")?.cents), incident: count(byReason.get("incident")?.cents) },
      solutionsBought: count(byReason.get("solution")?.lines),
      pro: { active: count(subscribers.active), everSubscribed: count(subscribers.everSubscribed) },
    };
  }

  async searchUsers(prefix: string, limit: number): Promise<AdminUserRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT users.username, users.created_at, users.tags, progress.title, progress.experience, progress.updated_at FROM users " +
          "LEFT JOIN progress ON progress.user_id = users.id WHERE users.username LIKE ? ESCAPE '\\' ORDER BY users.username LIMIT ?",
      )
      .bind(likePrefix(prefix), limit)
      .all<{ username: string; created_at: number; tags: string; title: Title | null; experience: number | null; updated_at: number | null }>();
    return results.map((row) => ({
      username: row.username,
      createdAt: row.created_at,
      tags: parseTags(row.tags),
      title: row.title,
      experience: row.experience,
      lastActive: row.updated_at,
    }));
  }
}
