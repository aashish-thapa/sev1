/** The public company list: search and the leaderboard, each company's level computed from its books. */
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import { impliedValuationCents } from "../../src/domain/company/investors.ts";
import { companyLevel } from "../../src/domain/company/levels.ts";
import { valuationHistory, weekChangeBps } from "../../src/domain/company/valuation.ts";
import type { CompanySummary, OfficeLayout } from "../../src/storage/company-protocol.ts";
import type { CompanyView } from "./store.ts";
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
    ...valuationOf(listing.lines, listing.workDays),
    lastRound: listing.lastRound && {
      valuationCents: impliedValuationCents(listing.lastRound.amountCents, listing.lastRound.equityBps),
      workDay: listing.lastRound.workDay,
      at: listing.lastRound.at,
    },
  };
}

/** What the company is worth now, how that moved over its last work days, and its change over the last week. */
export function valuationOf(lines: Parameters<typeof valuationHistory>[0], workDay: number) {
  const history = valuationHistory(lines, workDay);
  return { valuationCents: history.at(-1)?.valuationCents ?? 0, valuationHistory: history, weekChangeBps: weekChangeBps(history) };
}

export class CompanyDirectory {
  private readonly store: CompanyDirectoryStore;
  private readonly companyById: (id: string) => Promise<CompanyView | null>;

  constructor(store: CompanyDirectoryStore, companyById: (id: string) => Promise<CompanyView | null> = async () => null) {
    this.store = store;
    this.companyById = companyById;
  }

  /** What a visitor's floor needs to draw an active company's office: its rooms, servers and who sits where. */
  async layout(companyId: string): Promise<OfficeLayout | null> {
    const view = await this.companyById(companyId);
    if (view?.company.state !== "active") return null;
    return {
      name: view.company.name,
      category: view.company.category,
      rooms: [...view.rooms],
      servers: [...view.servers],
      members: view.members.map((member) => ({ username: member.username, role: member.role, isFounder: member.isFounder, joinedAt: member.joinedAt })),
    };
  }

  async search(query: string, category: CategoryId | null): Promise<CompanySummary[]> {
    return (await this.store.search(query.trim().slice(0, QUERY_LENGTH), category, LIST_LIMIT)).map(summaryOf);
  }

  async top(): Promise<CompanySummary[]> {
    return (await this.store.top(TOP_LIMIT)).map(summaryOf);
  }
}
