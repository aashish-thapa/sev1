/** What the public company list needs: active companies with the numbers that rank them. */
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import type { BookLine } from "../../src/domain/company/investors.ts";
import type { PostingRow } from "./hiring-store.ts";

export type CompanyListing = {
  readonly id: string;
  readonly name: string;
  readonly category: CategoryId;
  readonly founder: string;
  readonly members: number;
  readonly workDays: number;
  readonly lifetimeRevenueCents: number;
  /** Revenue booked over the company's last seven settled work days. */
  readonly revenue7dCents: number;
  /** Open postings only. */
  readonly postings: readonly PostingRow[];
  /** Every line in the company's books, oldest first: its valuation and that valuation's history come from these. */
  readonly lines: readonly BookLine[];
};

export interface CompanyDirectoryStore {
  /** Active companies whose name starts with `prefix` (any case), alphabetically. */
  search(prefix: string, category: CategoryId | null, limit: number): Promise<CompanyListing[]>;
  /** Active companies by revenue over their last seven work days, then lifetime revenue. */
  top(limit: number): Promise<CompanyListing[]>;
}
