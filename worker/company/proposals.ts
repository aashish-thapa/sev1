/**
 * Proposals to invest: a player asks a founder for a stake on their terms. The founder declines, or
 * accepts — which invites the player to meet and settle it in the company's office (see deals.ts).
 */
import { checkInvestmentOffer } from "../../src/domain/company/investors.ts";
import type { Company, MyCompany, ProposalRequest } from "../../src/storage/company-protocol.ts";
import type { DealService } from "./deals.ts";
import type { InvestorStore } from "./investor-store.ts";
import { capTableOf, founderOf } from "./ownership.ts";
import type { ProposalStore } from "./proposal-store.ts";
import type { Caller, CompanyProblem, CompanyService, Outcome } from "./service.ts";
import type { CompanyStore } from "./store.ts";

export type ProposalDeps = {
  readonly proposals: ProposalStore;
  readonly investors: Pick<InvestorStore, "shares" | "liveOffers">;
  readonly companies: Pick<CompanyStore, "companyById">;
  readonly company: Pick<CompanyService, "foundersCompany" | "reloaded" | "mine">;
  readonly deals: Pick<DealService, "open" | "retract">;
  readonly now: () => number;
  readonly newId: () => string;
  readonly isOverLimit: (key: string) => Promise<boolean>;
};

/** Who's proposing: the rules compare usernames, so the proposer's matters. */
export type Proposer = Caller & { readonly username: string };

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });

export class ProposalService {
  private readonly deps: ProposalDeps;

  constructor(deps: ProposalDeps) {
    this.deps = deps;
  }

  /** Anyone but the company's founder may ask to invest, once at a time, on terms the founder could offer. */
  async propose(caller: Proposer, companyId: string, request: ProposalRequest, requestKey: string | null): Promise<Outcome<MyCompany>> {
    const { proposals, investors, companies } = this.deps;
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const view = await companies.companyById(companyId);
    if (view?.company.state !== "active") return fail("not_active");
    if (view.company.founderId === caller.id) return fail("self_offer");
    const [shares, live] = await Promise.all([investors.shares(companyId), investors.liveOffers(companyId)]);
    const terms = { investor: caller.username, amountCents: request.amountCents, equityBps: request.equityBps };
    const problem = checkInvestmentOffer(capTableOf(founderOf(view), shares), terms, live);
    if (problem) return fail(problem);
    const created = await proposals.create(
      {
        id: this.deps.newId(),
        companyId,
        investorId: caller.id,
        investor: caller.username,
        amountCents: request.amountCents,
        equityBps: request.equityBps,
        status: "pending",
        createdAt: this.deps.now(),
      },
      requestKey,
    );
    if (created === "already_pending") return fail("already_proposed");
    return ok(await this.deps.company.mine(caller));
  }

  /**
   * The founder takes the terms to a meeting: a deal opens with the proposer, re-checked against every offer
   * now in play. If the proposer withdrew in the meantime, the fresh deal comes off the table again.
   */
  async accept(caller: Caller, proposalId: string): Promise<Outcome<Company>> {
    const founded = await this.deps.company.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    const proposal = await this.deps.proposals.proposal(proposalId);
    if (proposal?.status !== "pending" || proposal.companyId !== view.company.id) return fail("proposal_not_found");
    const investor = { id: proposal.investorId, username: proposal.investor };
    // Keyed by the proposal, so a retried accept never opens a second deal.
    const opened = await this.deps.deals.open(view, investor, { amountCents: proposal.amountCents, equityBps: proposal.equityBps }, `proposal:${proposal.id}`);
    if (!opened.ok) return opened;
    if (!(await this.deps.proposals.decide(proposal.id, "accepted", this.deps.now()))) {
      await this.deps.deals.retract(opened.value.dealId);
      return fail("proposal_not_found");
    }
    return this.deps.company.reloaded(view.company.id, caller.id);
  }

  async decline(caller: Caller, proposalId: string): Promise<Outcome<Company>> {
    const founded = await this.deps.company.foundersCompany(caller);
    if (!founded.ok) return founded;
    const proposal = await this.deps.proposals.proposal(proposalId);
    if (proposal?.companyId !== founded.value.company.id || !(await this.deps.proposals.decide(proposal.id, "declined", this.deps.now()))) {
      return fail("proposal_not_found");
    }
    return this.deps.company.reloaded(proposal.companyId, caller.id);
  }

  /** The proposer takes it back while the founder hasn't answered. */
  async withdraw(caller: Caller, proposalId: string): Promise<Outcome<MyCompany>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const proposal = await this.deps.proposals.proposal(proposalId);
    if (proposal?.investorId !== caller.id || !(await this.deps.proposals.decide(proposal.id, "withdrawn", this.deps.now()))) {
      return fail("proposal_not_found");
    }
    return ok(await this.deps.company.mine(caller));
  }
}
