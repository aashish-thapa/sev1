/**
 * Investing, server side: a founder offers a slice of the company to a named player, who accepts (and
 * then pays from their wallet in their next save) or declines. The stake itself lands with that save,
 * in the same batch, so money and equity can't part ways.
 */
import { checkInvestmentOffer } from "../../src/domain/company/investors.ts";
import type { AcceptOfferResponse, Company, OfferRequest } from "../../src/storage/company-protocol.ts";
import type { CompanyStore, CompanyView } from "./store.ts";
import type { InvestorStore, OfferRow } from "./investor-store.ts";
import { capTableOf, founderOf } from "./ownership.ts";
import type { Caller, CompanyProblem, CompanyService, Outcome } from "./service.ts";

/** How long an accepted offer waits for the investor's save to pay it before the audit stops vouching for it. */
export const ACCEPTED_OFFER_MS = 24 * 60 * 60 * 1000;

const investRefOf = (offerId: string) => `company:invest:${offerId}`;

export type InvestingDeps = {
  readonly investors: InvestorStore;
  readonly companies: Pick<CompanyStore, "companyById" | "findUser">;
  readonly company: Pick<CompanyService, "foundersCompany" | "reloaded">;
  readonly now: () => number;
  readonly newId: () => string;
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

  async offer(caller: Caller, request: OfferRequest, requestKey: string | null): Promise<Outcome<Company>> {
    const founded = await this.deps.company.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    const investor = await this.deps.companies.findUser(request.investor.trim());
    if (!investor) return fail("unknown_user");
    const made = await this.offerTo(view, investor, { amountCents: request.amountCents, equityBps: request.equityBps }, requestKey);
    return made.ok ? this.deps.company.reloaded(view.company.id, caller.id) : made;
  }

  /**
   * Offers `investor` a stake in the founder's company, checked against every offer still in play so the
   * founder keeps control. Shared by a founder's own offer and an accepted proposal.
   */
  async offerTo(
    view: CompanyView,
    investor: { readonly id: string; readonly username: string },
    terms: { readonly amountCents: number; readonly equityBps: number },
    requestKey: string | null,
  ): Promise<Outcome<{ offerId: string }>> {
    const { investors } = this.deps;
    const [shares, live] = await Promise.all([investors.shares(view.company.id), investors.liveOffers(view.company.id)]);
    const problem = checkInvestmentOffer(capTableOf(founderOf(view), shares), { investor: investor.username, ...terms }, live);
    if (problem) return fail(problem);
    const id = this.deps.newId();
    await investors.createOffer(
      {
        id,
        companyId: view.company.id,
        investorId: investor.id,
        investor: investor.username,
        amountCents: terms.amountCents,
        equityBps: terms.equityBps,
        status: "open",
        investRef: investRefOf(id),
        expiresAt: null,
        createdAt: this.deps.now(),
      },
      requestKey,
    );
    return ok({ offerId: id });
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
