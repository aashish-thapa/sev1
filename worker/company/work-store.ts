/** What daily work needs from storage: each member's graded answers, and which shipped work a closed day has counted. */
import type { WorkResult } from "../../src/domain/work/daily.ts";

export type WorkRow = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly taskId: string;
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly result: WorkResult;
  readonly answeredAt: number;
};

export interface WorkStore {
  /** Task ids this member shipped on days before `day`. */
  finishedBefore(userId: string, day: string): Promise<string[]>;
  /** This member's graded answers on `day`. */
  answeredOn(userId: string, day: string): Promise<WorkRow[]>;
  /** Records one graded answer; false when this member already answered this task today. */
  record(row: WorkRow): Promise<boolean>;
  /** Shipped work no closed day has counted yet, oldest first, at most `limit` row ids. */
  unsettledShipped(companyId: string, limit: number): Promise<string[]>;
  /** How much shipped work the next closed day would count, uncapped. */
  unsettledShippedCount(companyId: string): Promise<number>;
}
