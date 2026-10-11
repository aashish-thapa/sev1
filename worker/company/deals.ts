/**
 * Investments agreed in person. A founder's offer, or a proposal the founder takes, opens a deal; the two
 * meet in the company's office (the investor walks in on the deal's pass), either may table new terms, and
 * it closes only when both agree to the same terms while they're in the room together. Then it's booked as
 * an accepted offer the investor's next save pays, exactly like any other investment.
 */
import { agree, propose, walkAway, type Deal, type DealProblem, type Party, type Terms } from "../../src/domain/company/deal.ts";
import type { Company, DealWire, MeetingResponse, MyCompany, OfferRequest } from "../../src/storage/company-protocol.ts";
import { dealOfferId, type DealChange, type DealRow, type DealStore } from "./deal-store.ts";
import { investRefOf, type InvestingService } from "./investing.ts";
import type { InvestorStore } from "./investor-store.ts";
import type { Caller, CompanyProblem, CompanyService, Outcome } from "./service.ts";
import type { CompanyStore, CompanyView } from "./store.ts";

/** Who's connected to the room at `code` right now, by user id (as the worker vouched when each socket opened). */
export type RoomPresence = (code: string) => Promise<ReadonlySet<string>>;

export type DealDeps = {
  readonly deals: DealStore;
  readonly companies: Pick<CompanyStore, "companyById" | "findUser">;
  readonly company: Pick<CompanyService, "foundersCompany" | "reloaded" | "mine">;
  readonly investing: Pick<InvestingService, "check" | "book">;
  readonly investors: Pick<InvestorStore, "setStatus">;
  /** The company's office room code, assigned on first use; null if it has none to give. */
  readonly meetingRoomOf: (companyId: string) => Promise<string | null>;
  readonly presence: RoomPresence;
  /** The player's wallet balance as of their last save (zero with none). */
  readonly balanceOf: (userId: string) => Promise<number>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly isOverLimit: (key: string) => Promise<boolean>;
};

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });

function dealOf(row: DealRow): Deal {
  if (row.stage === "agreed") return { stage: "agreed", terms: row.terms };
  // Who walked away isn't kept; a closed deal only ever refuses.
  if (row.stage === "walked-away") return { stage: "walked-away", by: "founder" };
  const agreed = new Set<Party>();
  if (row.agreedFounder) agreed.add("founder");
  if (row.agreedInvestor) agreed.add("investor");
  return { stage: "talking", terms: row.terms, agreed };
}

function changeOf(row: DealRow, deal: Deal): DealChange {
  switch (deal.stage) {
    case "talking":
      return { terms: deal.terms, stage: "talking", agreedFounder: deal.agreed.has("founder"), agreedInvestor: deal.agreed.has("investor") };
    case "agreed":
      return { terms: deal.terms, stage: "agreed", agreedFounder: true, agreedInvestor: true };
    case "walked-away":
      return { terms: row.terms, stage: "walked-away", agreedFounder: false, agreedInvestor: false };
  }
}

export function dealWireOf(row: DealRow): DealWire {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.companyName,
    founder: row.founder,
    investor: row.investor,
    terms: row.terms,
    stage: row.stage,
    agreed: row.stage === "talking" ? [...(row.agreedFounder ? ["founder" as const] : []), ...(row.agreedInvestor ? ["investor" as const] : [])] : [],
    investRef: row.stage === "agreed" ? investRefOf(dealOfferId(row.id)) : null,
    createdAt: row.createdAt,
  };
}

const isProblem = (outcome: Deal | DealProblem | "terms_changed"): outcome is DealProblem | "terms_changed" => typeof outcome === "string";

export class DealService {
  private readonly deps: DealDeps;

  constructor(deps: DealDeps) {
    this.deps = deps;
  }

  /** The founder offers a named player a stake: they'll settle it in a meeting. */
  async offer(caller: Caller, request: OfferRequest, requestKey: string | null): Promise<Outcome<Company>> {
    const founded = await this.deps.company.foundersCompany(caller);
    if (!founded.ok) return founded;
    const investor = await this.deps.companies.findUser(request.investor.trim());
    if (!investor) return fail("unknown_user");
    const opened = await this.open(founded.value, investor, { amountCents: request.amountCents, equityBps: request.equityBps }, requestKey);
    return opened.ok ? this.deps.company.reloaded(founded.value.company.id, caller.id) : opened;
  }

  /** Puts terms on the table between the company's founder and `investor`, if the founder could sell them today. */
  async open(view: CompanyView, investor: { readonly id: string; readonly username: string }, terms: Terms, requestKey: string | null): Promise<Outcome<{ dealId: string }>> {
    if (investor.id === view.company.founderId) return fail("self_offer");
    const problem = await this.deps.investing.check(view, investor.username, terms);
    if (problem) return fail(problem);
    const id = this.deps.newId();
    const opened = await this.deps.deals.open(
      { id, companyId: view.company.id, founderId: view.company.founderId, investorId: investor.id, terms, stage: "talking", agreedFounder: false, agreedInvestor: false, createdAt: this.deps.now() },
      requestKey,
    );
    if (opened === "already_talking") return fail("already_invited");
    if (opened === "duplicate" && requestKey !== null) {
      const retried = await this.deps.deals.dealByKey(view.company.id, requestKey);
      if (retried) return ok({ dealId: retried.id });
    }
    return ok({ dealId: id });
  }

  /** Where the two meet: the company's office, which the investor may enter while the deal is on the table. */
  async meeting(caller: Caller, dealId: string): Promise<Outcome<MeetingResponse>> {
    const found = await this.partyTo(caller, dealId);
    if (!found.ok) return found;
    if (found.value.row.stage !== "talking") return fail("deal_closed");
    const code = await this.deps.meetingRoomOf(found.value.row.companyId);
    return code ? ok({ code }) : fail("deal_not_found");
  }

  /** New terms on the table from either side; both must agree again. */
  async terms(caller: Caller, dealId: string, terms: Terms): Promise<Outcome<MyCompany>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const found = await this.partyTo(caller, dealId);
    if (!found.ok) return found;
    const { row } = found.value;
    const next = propose(dealOf(row), terms);
    if (isProblem(next)) return fail(next);
    if (!(await this.deps.deals.change(row.id, row.version, changeOf(row, next)))) return fail("terms_changed");
    return ok(await this.deps.company.mine(caller));
  }

  /**
   * Agrees to the terms exactly as the caller read them, with both parties in the office. The second agreement
   * books the investment, re-checked for the founder's control and the investor's saved wallet.
   */
  async agree(caller: Caller, dealId: string, seen: Terms): Promise<Outcome<MyCompany>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const found = await this.partyTo(caller, dealId);
    if (!found.ok) return found;
    const { row, party } = found.value;
    const next = agree(dealOf(row), party, seen);
    if (isProblem(next)) return fail(next);
    if (!(await this.isMeeting(row))) return fail("not_together");
    if (next.stage === "agreed") {
      const booked = await this.book(row);
      if (!booked.ok) return booked;
    }
    if (!(await this.deps.deals.change(row.id, row.version, changeOf(row, next)))) {
      // Both may agree at once: the booking stands if the other side's write closed the deal.
      const now = await this.deps.deals.deal(row.id);
      if (next.stage === "agreed" && now?.stage !== "agreed") await this.deps.investors.setStatus(dealOfferId(row.id), ["accepted"], "cancelled");
      if (now?.stage !== "agreed") return fail("terms_changed");
    }
    return ok(await this.deps.company.mine(caller));
  }

  async walkAway(caller: Caller, dealId: string): Promise<Outcome<MyCompany>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const found = await this.partyTo(caller, dealId);
    if (!found.ok) return found;
    const { row, party } = found.value;
    const next = walkAway(dealOf(row), party);
    if (isProblem(next)) return fail(next);
    if (!(await this.deps.deals.change(row.id, row.version, changeOf(row, next)))) return fail("terms_changed");
    return ok(await this.deps.company.mine(caller));
  }

  /** Takes a just-opened deal off the table again, when what opened it fell through. */
  async retract(dealId: string): Promise<void> {
    const row = await this.deps.deals.deal(dealId);
    if (row?.stage === "talking") await this.deps.deals.change(row.id, row.version, changeOf(row, { stage: "walked-away", by: "founder" }));
  }

  /** A player's deals still being talked over, or agreed and waiting for the investor's save to pay. */
  async dealsOf(userId: string): Promise<DealWire[]> {
    return (await this.deps.deals.openFor(userId)).map(dealWireOf);
  }

  private async book(row: DealRow): Promise<Outcome<unknown>> {
    if ((await this.deps.balanceOf(row.investorId)) < row.terms.amountCents) return fail("not_enough_money");
    const view = await this.deps.companies.companyById(row.companyId);
    if (view?.company.state !== "active") return fail("not_active");
    return this.deps.investing.book(view, { id: row.investorId, username: row.investor }, row.terms, row.id);
  }

  /** Both parties are connected to the company's office right now. */
  private async isMeeting(row: DealRow): Promise<boolean> {
    const code = await this.deps.meetingRoomOf(row.companyId);
    if (!code) return false;
    const present = await this.deps.presence(code);
    return present.has(row.founderId) && present.has(row.investorId);
  }

  private async partyTo(caller: Caller, dealId: string): Promise<Outcome<{ row: DealRow; party: Party }>> {
    const row = await this.deps.deals.deal(dealId);
    if (row?.founderId === caller.id) return ok({ row, party: "founder" });
    if (row?.investorId === caller.id) return ok({ row, party: "investor" });
    return fail("deal_not_found");
  }
}
