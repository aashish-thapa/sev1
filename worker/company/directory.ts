/** The public company list: search and the leaderboard, each company's level computed from its books. */
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import { companyLevel } from "../../src/domain/company/levels.ts";
import type { CompanySummary } from "../../src/storage/company-protocol.ts";
import type { CompanyDirectoryStore, CompanyListing } from "./directory-store.ts";
import { postingOf } from "./service.ts";

/** At most this many companies per list, and open postings per company. */
export const LIST_LIMIT = 50;
export const TOP_LIMIT = 20;
const POSTINGS_SHOWN = 20;
const QUERY_LENGTH = 40;

function summaryOf(listing: CompanyListing): CompanySummary {
  const level = companyLevel({ lifetimeRevenueCents: listing.lifetimeRevenueCents, workDays: listing.workDays });
  return {
    id: listing.id,
    name: listing.name,
    category: listing.category,
    level: level.level,
    levelTitle: level.title,
    founder: listing.founder,
    members: listing.members,
    revenue7dCents: Math.max(0, listing.revenue7dCents),
    lifetimeRevenueCents: Math.max(0, listing.lifetimeRevenueCents),
    postings: listing.postings.slice(0, POSTINGS_SHOWN).map(postingOf),
  };
}

export class CompanyDirectory {
  private readonly store: CompanyDirectoryStore;

  constructor(store: CompanyDirectoryStore) {
    this.store = store;
  }

  async search(query: string, category: CategoryId | null): Promise<CompanySummary[]> {
    return (await this.store.search(query.trim().slice(0, QUERY_LENGTH), category, LIST_LIMIT)).map(summaryOf);
  }

  async top(): Promise<CompanySummary[]> {
    return (await this.store.top(TOP_LIMIT)).map(summaryOf);
  }
}
