/**
 * Investing, server side: the terms a founder and investor agree in a meeting become an accepted offer,
 * which the investor pays from their wallet in their next save. The stake itself lands with that save,
 * in the same batch, so money and equity can't part ways. Offers made before meetings existed can still
 * be accepted, declined or cancelled here.
 */
import { checkInvestmentOffer } from "../../src/domain/company/investors.ts";
import type { Terms } from "../../src/domain/company/deal.ts";
import type { AcceptOfferResponse, Company } from "../../src/storage/company-protocol.ts";
import { dealOfferId } from "./deal-store.ts";
import type { CompanyStore, CompanyView } from "./store.ts";
import type { InvestorStore, OfferRow } from "./investor-store.ts";
import { capTableOf, founderOf } from "./ownership.ts";
import type { Caller, CompanyProblem, CompanyService, Outcome } from "./service.ts";

/** How long an accepted offer waits for the investor's save to pay it before the audit stops vouching for it. */
export const ACCEPTED_OFFER_MS = 24 * 60 * 60 * 1000;

export const investRefOf = (offerId: string) => `company:invest:${offerId}`;

export type InvestingDeps = {
  readonly investors: InvestorStore;
  readonly companies: Pick<CompanyStore, "companyById">;
  readonly company: Pick<CompanyService, "foundersCompany" | "reloaded">;
  readonly now: () => number;
  readonly isOverLimit: (key: string) => Promise<boolean>;
  /** The player's wallet balance as of their last save (zero with none). */
  readonly balanceOf: (userId: string) => Promise<number>;
};

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });

/**
 * An offer can be taken back while nobody's paying for it: still open, or accepted and left unpaid past its
 * window. An accepted offer inside its window belongs to the investor's save in flight.
 */
const isWithdrawable = (offer: OfferRow, now: number) => offer.status === "open" || (offer.status === "accepted" && (offer.expiresAt ?? 0) <= now);

export class InvestingService {
  private readonly deps: InvestingDeps;

  constructor(deps: InvestingDeps) {
    this.deps = deps;
  }

  /** Why the founder couldn't sell `investor` these terms, counting every offer still in play; null when they could. */
  async check(view: CompanyView, investor: string, terms: Terms): Promise<CompanyProblem | null> {
    const { investors } = this.deps;
    const [shares, live] = await Promise.all([investors.shares(view.company.id), investors.liveOffers(view.company.id)]);
    return checkInvestmentOffer(capTableOf(founderOf(view), shares), { investor, ...terms }, live);
  }

  /**
   * Books the terms of an agreed deal as an accepted offer, re-checked against every offer now in play so the
   * founder keeps control. The investor's next save pays it under the returned ref; a retry books it once.
   */
  async book(view: CompanyView, investor: { readonly id: string; readonly username: string }, terms: Terms, dealId: string): Promise<Outcome<AcceptOfferResponse>> {
    const id = dealOfferId(dealId);
    const booked = await this.deps.investors.offer(id);
    if (!booked) {
      const problem = await this.check(view, investor.username, terms);
      if (problem) return fail(problem);
      await this.deps.investors.createOffer(
        {
          id,
          companyId: view.company.id,
          investorId: investor.id,
          investor: investor.username,
          amountCents: terms.amountCents,
          equityBps: terms.equityBps,
          status: "accepted",
          investRef: investRefOf(id),
          expiresAt: this.deps.now() + ACCEPTED_OFFER_MS,
          createdAt: this.deps.now(),
        },
        id,
      );
    }
    return ok({ investRef: investRefOf(id), amountCents: terms.amountCents });
  }

  async cancel(caller: Caller, offerId: string): Promise<Outcome<Company>> {
    const founded = await this.deps.company.foundersCompany(caller);
    if (!founded.ok) return founded;
    const offer = await this.deps.investors.offer(offerId);
    if (!offer || offer.companyId !== founded.value.company.id || !isWithdrawable(offer, this.deps.now())) return fail("offer_not_found");
    await this.deps.investors.setStatus(offer.id, [offer.status], "cancelled");
    return this.deps.company.reloaded(offer.companyId, caller.id);
  }

  /** Agrees to an offer: the investor's next save spends the amount under the returned ref. Retrying renews the window. */
  async accept(caller: Caller, offerId: string): Promise<Outcome<AcceptOfferResponse>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const offer = await this.receivedOffer(caller, offerId);
    if (!offer || (offer.status !== "open" && offer.status !== "accepted")) return fail("offer_not_found");
    const company = await this.deps.companies.companyById(offer.companyId);
    if (company?.company.state !== "active") return fail("offer_not_found");
    const balance = await this.deps.balanceOf(caller.id);
    if (balance < offer.amountCents) return fail("not_enough_money");
    const accepted = await this.deps.investors.setStatus(offer.id, ["open", "accepted"], "accepted", this.deps.now() + ACCEPTED_OFFER_MS);
    return accepted ? ok({ investRef: offer.investRef, amountCents: offer.amountCents }) : fail("offer_not_found");
  }

  async decline(caller: Caller, offerId: string): Promise<Outcome<{ declined: true }>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const offer = await this.receivedOffer(caller, offerId);
    if (!offer || !isWithdrawable(offer, this.deps.now())) return fail("offer_not_found");
    await this.deps.investors.setStatus(offer.id, [offer.status], "declined");
    return ok({ declined: true });
  }

  private async receivedOffer(caller: Caller, offerId: string): Promise<OfferRow | null> {
    const offer = await this.deps.investors.offer(offerId);
    return offer && offer.investorId === caller.id ? offer : null;
  }
}
