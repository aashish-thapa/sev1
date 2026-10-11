/** In-memory work log with D1's one-answer-per-day rule, for tests. */
import type { WorkRow, WorkStore } from "./work-store.ts";

export class MemoryWorkStore implements WorkStore {
  readonly rows: (WorkRow & { settledWorkDay: number | null })[] = [];

  async finishedBefore(userId: string, day: string): Promise<string[]> {
    return [...new Set(this.rows.filter((row) => row.userId === userId && row.day < day && row.result.isDone).map((row) => row.taskId))];
  }

  async answeredOn(userId: string, day: string): Promise<WorkRow[]> {
    return this.rows.filter((row) => row.userId === userId && row.day === day);
  }

  async record(row: WorkRow): Promise<boolean> {
    if (this.rows.some((existing) => existing.userId === row.userId && existing.taskId === row.taskId && existing.day === row.day)) return false;
    this.rows.push({ ...row, settledWorkDay: null });
    return true;
  }

  async unsettledShipped(companyId: string, limit: number): Promise<string[]> {
    return this.unsettled(companyId)
      .slice(0, Math.max(0, limit))
      .map((row) => row.id);
  }

  async unsettledShippedCount(companyId: string): Promise<number> {
    return this.unsettled(companyId).length;
  }

  /** What a winning settlement does to the rows it counted. */
  markSettled(ids: readonly string[], workDay: number): void {
    for (const row of this.rows) if (ids.includes(row.id) && row.settledWorkDay === null) row.settledWorkDay = workDay;
  }

  private unsettled(companyId: string) {
    return this.rows.filter((row) => row.companyId === companyId && row.result.isDone && row.settledWorkDay === null).sort((a, b) => a.answeredAt - b.answeredAt);
  }
}
