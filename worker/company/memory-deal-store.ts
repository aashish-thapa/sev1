import { dealOfferId, type DealChange, type DealOpened, type DealRow, type DealStore } from "./deal-store.ts";
import type { MemoryInvestorStore } from "./memory-investor-store.ts";
import type { MemoryCompanyStore } from "./memory-store.ts";

/** Deals in memory, for tests; names resolve the way D1's joins do, and "paid" reads the investor store's offers. */
export class MemoryDealStore implements DealStore {
  readonly deals = new Map<string, DealRow>();
  private readonly keys = new Map<string, string>();
  private readonly companies: MemoryCompanyStore;
  private readonly investors: MemoryInvestorStore;

  constructor(companies: MemoryCompanyStore, investors: MemoryInvestorStore) {
    this.companies = companies;
    this.investors = investors;
  }

  async open(deal: Omit<DealRow, "companyName" | "founder" | "investor" | "version">, requestKey: string | null): Promise<DealOpened> {
    const key = requestKey === null ? null : `${deal.companyId}:${requestKey}`;
    if (key !== null && this.keys.has(key)) return "duplicate";
    const isTalking = [...this.deals.values()].some((existing) => existing.stage === "talking" && existing.companyId === deal.companyId && existing.investorId === deal.investorId);
    if (isTalking) return "already_talking";
    if (key !== null) this.keys.set(key, deal.id);
    const name = (userId: string) => this.companies.usernames.get(userId) ?? "";
    this.deals.set(deal.id, {
      ...deal,
      companyName: this.companies.companies.get(deal.companyId)?.name ?? "",
      founder: name(deal.founderId),
      investor: name(deal.investorId),
      version: 0,
    });
    return "opened";
  }

  async deal(id: string): Promise<DealRow | null> {
    return this.deals.get(id) ?? null;
  }

  async dealByKey(companyId: string, requestKey: string): Promise<DealRow | null> {
    const id = this.keys.get(`${companyId}:${requestKey}`);
    return id === undefined ? null : (this.deals.get(id) ?? null);
  }

  async change(id: string, version: number, next: DealChange): Promise<boolean> {
    const deal = this.deals.get(id);
    if (deal?.version !== version) return false;
    this.deals.set(id, { ...deal, ...next, version: version + 1 });
    return true;
  }

  async openFor(userId: string): Promise<DealRow[]> {
    return [...this.deals.values()]
      .filter((deal) => deal.founderId === userId || deal.investorId === userId)
      .filter((deal) => deal.stage === "talking" || (deal.stage === "agreed" && this.investors.offers.get(dealOfferId(deal.id))?.status === "accepted"))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async isTalkingWith(companyId: string, investorId: string): Promise<boolean> {
    return [...this.deals.values()].some((deal) => deal.companyId === companyId && deal.investorId === investorId && deal.stage === "talking");
  }
}
