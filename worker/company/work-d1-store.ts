import type { WorkResult } from "../../src/domain/work/daily.ts";
import { WorkResultSchema } from "../../src/storage/company-protocol.ts";
import type { WorkRow, WorkStore } from "./work-store.ts";

type LogRow = { id: string; company_id: string; user_id: string; task_id: string; utc_day: string; result_json: string; answered_at: number };

/** The server wrote every stored result itself; a row that no longer parses is dropped, not trusted. */
function resultOf(json: string): WorkResult | null {
  try {
    const parsed = WorkResultSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export class D1WorkStore implements WorkStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async finishedBefore(userId: string, day: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT task_id FROM work_log WHERE user_id = ? AND utc_day < ? AND is_done = 1")
      .bind(userId, day)
      .all<{ task_id: string }>();
    return results.map((row) => row.task_id);
  }

  async answeredOn(userId: string, day: string): Promise<WorkRow[]> {
    const { results } = await this.db
      .prepare("SELECT id, company_id, user_id, task_id, utc_day, result_json, answered_at FROM work_log WHERE user_id = ? AND utc_day = ?")
      .bind(userId, day)
      .all<LogRow>();
    return results.flatMap((row) => {
      const result = resultOf(row.result_json);
      return result ? [{ id: row.id, companyId: row.company_id, userId: row.user_id, taskId: row.task_id, day: row.utc_day, result, answeredAt: row.answered_at }] : [];
    });
  }

  async record(row: WorkRow): Promise<boolean> {
    try {
      await this.db
        .prepare("INSERT INTO work_log (id, company_id, user_id, task_id, utc_day, outcome, is_done, result_json, answered_at, settled_work_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
        .bind(row.id, row.companyId, row.userId, row.taskId, row.day, row.result.outcome, row.result.isDone ? 1 : 0, JSON.stringify(row.result), row.answeredAt)
        .run();
      return true;
    } catch (error) {
      // A second answer to the same task the same day, possibly racing the first.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async unsettledShipped(companyId: string, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const { results } = await this.db
      .prepare("SELECT id FROM work_log WHERE company_id = ? AND is_done = 1 AND settled_work_day IS NULL ORDER BY answered_at LIMIT ?")
      .bind(companyId, limit)
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  async unsettledShippedCount(companyId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM work_log WHERE company_id = ? AND is_done = 1 AND settled_work_day IS NULL")
      .bind(companyId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
}
