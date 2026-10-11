/** In-memory investing with the same conditional writes as D1, for tests. */
import type { PromisedMoney } from "../../src/domain/audit.ts";
import type { BookLine } from "../../src/domain/company/investors.ts";
import { payRef } from "../../src/domain/economy.ts";
import type { Holding, PendingDividend } from "../../src/storage/company-protocol.ts";
import type { InvestorBank, SaveMoves } from "../api/store.ts";
import type { InvestorStore, OfferRow, OfferStatus, ReceivedOfferRow, ShareRow } from "./investor-store.ts";
import type { MemoryCompanyStore } from "./memory-store.ts";

type Stake = { companyId: string; userId: string; bps: number; investedCents: number };

export class MemoryInvestorStore implements InvestorStore, InvestorBank {
  readonly stakes: Stake[] = [];
  readonly offers = new Map<string, OfferRow>();
  private readonly requestKeys = new Set<string>();
  private readonly companies: MemoryCompanyStore;

  constructor(companies: MemoryCompanyStore) {
    this.companies = companies;
  }

  /** What D1 does with a save's investments and dividend claims (see investorMoveStatements). */
  applyMoves(userId: string, moves: SaveMoves, at: number): void {
    for (const ref of moves.investRefs) {
      const offer = [...this.offers.values()].find((candidate) => candidate.investRef === ref && candidate.investorId === userId && candidate.status === "accepted");
      if (!offer) continue;
      for (const stake of this.stakes.filter((candidate) => candidate.companyId === offer.companyId)) {
        stake.bps = Math.floor((stake.bps * (10_000 - offer.equityBps)) / 10_000);
      }
      const existing = this.stakes.find((stake) => stake.companyId === offer.companyId && stake.userId === userId);
      if (existing) {
        existing.bps += offer.equityBps;
        existing.investedCents += offer.amountCents;
      } else {
        this.stakes.push({ companyId: offer.companyId, userId, bps: offer.equityBps, investedCents: offer.amountCents });
      }
      const workDay = this.companies.companies.get(offer.companyId)?.workDay ?? 0;
      this.companies.credit(offer.companyId, { ref, reason: "investment", amountCents: offer.amountCents, at, workDay, note: offer.investor });
      this.offers.set(offer.id, { ...offer, status: "completed", expiresAt: null });
    }
    for (const id of moves.dividendIds) {
      const dividend = this.companies.dividendPayouts.get(id);
      if (dividend && dividend.userId === userId && dividend.claimedAt === null) this.companies.dividendPayouts.set(id, { ...dividend, claimedAt: at });
    }
  }

  async claimsFor(userId: string, now: number): Promise<Pick<PromisedMoney, "investments" | "dividends">> {
    return {
      investments: new Map(
        [...this.offers.values()].filter((offer) => offer.investorId === userId && offer.status === "accepted" && (offer.expiresAt ?? 0) > now).map((offer) => [offer.investRef, offer.amountCents]),
      ),
      dividends: new Map([...this.companies.dividendPayouts.values()].filter((dividend) => dividend.userId === userId && dividend.claimedAt === null).map((dividend) => [payRef.dividend(dividend.id), dividend.amountCents])),
    };
  }

  async shares(companyId: string): Promise<ShareRow[]> {
    return this.stakes
      .filter((stake) => stake.companyId === companyId && stake.bps > 0)
      .map((stake) => ({ userId: stake.userId, username: this.companies.usernames.get(stake.userId) ?? "", bps: stake.bps, investedCents: stake.investedCents }))
      .sort((a, b) => b.bps - a.bps || a.username.localeCompare(b.username));
  }

  async liveOffers(companyId: string): Promise<OfferRow[]> {
    return [...this.offers.values()].filter((offer) => offer.companyId === companyId && (offer.status === "open" || offer.status === "accepted"));
  }

  async offer(id: string): Promise<OfferRow | null> {
    return this.offers.get(id) ?? null;
  }

  async createOffer(offer: OfferRow, requestKey: string | null): Promise<boolean> {
    const key = requestKey === null ? null : `${offer.companyId}:${requestKey}`;
    if (this.offers.has(offer.id) || (key !== null && this.requestKeys.has(key))) return false;
    if (key !== null) this.requestKeys.add(key);
    this.offers.set(offer.id, offer);
    return true;
  }

  async setStatus(id: string, from: readonly OfferStatus[], to: OfferStatus, expiresAt: number | null = null): Promise<boolean> {
    const offer = this.offers.get(id);
    if (!offer || !from.includes(offer.status)) return false;
    this.offers.set(id, { ...offer, status: to, expiresAt });
    return true;
  }

  async receivedOffers(userId: string): Promise<ReceivedOfferRow[]> {
    return [...this.offers.values()]
      .filter((offer) => offer.investorId === userId && (offer.status === "open" || offer.status === "accepted"))
      .flatMap((offer) => {
        const company = this.companies.companies.get(offer.companyId);
        if (!company || company.state !== "active") return [];
        const lifetimeRevenueCents = this.companies.ledger.filter((line) => line.companyId === company.id && line.reason === "revenue").reduce((sum, line) => sum + line.amountCents, 0);
        return [{ ...offer, companyName: company.name, category: company.category, founder: this.companies.usernames.get(company.founderId) ?? "", workDay: company.workDay, lifetimeRevenueCents }];
      });
  }

  async holdings(userId: string): Promise<Holding[]> {
    return this.stakes
      .filter((stake) => stake.userId === userId && stake.bps > 0)
      .map((stake) => ({ companyId: stake.companyId, companyName: this.companies.companies.get(stake.companyId)?.name ?? "", bps: stake.bps, investedCents: stake.investedCents }));
  }

  async pendingDividends(userId: string): Promise<PendingDividend[]> {
    return [...this.companies.dividendPayouts.values()]
      .filter((dividend) => dividend.userId === userId && dividend.claimedAt === null)
      .map((dividend) => ({ id: dividend.id, companyId: dividend.companyId, companyName: this.companies.companies.get(dividend.companyId)?.name ?? "", workDay: dividend.workDay, amountCents: dividend.amountCents }));
  }

  async bookSince(companyId: string, afterWorkDay: number): Promise<BookLine[]> {
    return this.companies.ledger
      .filter((line) => line.companyId === companyId && line.workDay > afterWorkDay)
      .map((line) => ({ workDay: line.workDay, reason: line.reason, amountCents: line.amountCents }));
  }
}
