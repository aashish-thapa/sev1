/**
 * Startup mode on the server: who may do what to a company, using the shared pure rules for every
 * money decision. Storage, HTTP and the clock are injected; nothing here reads them directly.
 */
import { ROLE_MINIMUM_PAY_CENTS, roomKindById, serverTierById, type RoomKindId, type ServerTierId } from "../../src/domain/company/catalog.ts";
import { checkOffer, checkRoomPurchase, checkServerPurchase, FOUNDING_MINIMUM_CENTS, settleWorkDay, type CompanyBook } from "../../src/domain/company/rules.ts";
import { companyLevel } from "../../src/domain/company/levels.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { Application, Company, FoundRequest, MyCompany, Posting, WorkDaySettlement } from "../../src/storage/company-protocol.ts";
import type { ApplicationRow, HiringStore, PostingRow } from "./hiring-store.ts";
import type { WorkStore } from "./work-store.ts";
import { dividendsOn, myInvesting, NO_OWNERSHIP, ownershipOf, type InvestorReads, type Ownership, type ProposalReads } from "./ownership.ts";
import type { CompanyStore, CompanyView } from "./store.ts";

/** How long a founder has to put the seed in before the company is dropped. */
export const FUNDING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most ledger lines the HQ shows. */
const LEDGER_SHOWN = 60;
/** Until tasks are recorded on the server, a member's report can claim at most this many per member a day. */
const TASKS_PER_MEMBER_CAP = 3;
/** The most shipped work one closed day counts, whatever the team size. */
const MAX_TASKS_PER_DAY = 50;

export type CompanyProblem =
  | "not_in_company"
  | "not_founder"
  | "not_active"
  | "already_in_company"
  | "below_founding_minimum"
  | "below_minimum"
  | "no_free_desk"
  | "not_enough_funds"
  | "no_free_rack"
  | "unknown_user"
  | "self_invite"
  | "already_invited"
  | "invitation_not_found"
  | "already_settled_today"
  | "rate_limited"
  | "not_hiring"
  | "posting_closed"
  | "already_applied"
  | "below_level"
  | "interview_expired"
  | "interview_not_found"
  | "application_not_found"
  | "no_questions"
  | "not_on_board"
  | "already_answered"
  | "invalid"
  | "self_offer"
  | "below_minimum_investment"
  | "too_much_equity"
  | "founder_control"
  | "offer_not_found"
  | "not_enough_money"
  | "already_proposed"
  | "proposal_not_found"
  | "cannot_fire_founder"
  | "founder_cannot_leave";

export type Outcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: CompanyProblem };

/** Who's asking; the service only needs their id. */
export type Caller = { readonly id: string };

/** Every day counts as fully healthy for now; phase 2 derives this from recorded War Room outcomes. */
export const HEALTHY_SHARE_DEFAULT = 1;

export type CompanyDeps = {
  readonly store: CompanyStore;
  readonly now: () => number;
  /** Shipped work the server recorded; without it, a closed day counts none. */
  readonly work?: Pick<WorkStore, "unsettledShipped">;
  /**
   * What a member's coffees and snacks cost on a UTC day (YYYY-MM-DD), read from their saved progress.
   * Without it the pantry is free, as in job mode.
   */
  readonly pantryOf?: (userId: string, day: string) => Promise<number>;
  readonly newId: () => string;
  /** True when this caller has made too many company writes recently. */
  readonly isOverLimit: (key: string) => Promise<boolean>;
  /** Postings and applications to show in the HQ; without it the HQ lists none. */
  readonly hiring?: Pick<HiringStore, "postingsOf" | "applicationsOf" | "myApplications">;
  /** Stakes, offers and dividends; without it a company has no investors. */
  readonly investors?: InvestorReads;
  /** Players' proposals to invest; without it there are none. */
  readonly proposals?: ProposalReads;
};

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export function bookOf(view: CompanyView): CompanyBook {
  return {
    category: view.company.category,
    fundsCents: view.fundsCents,
    members: view.members.map((member) => ({ userId: member.userId, role: member.role, payCents: member.payCents })),
    rooms: view.rooms,
    servers: view.servers,
  };
}

/** The company's level, from lifetime revenue and work days survived — never from its bank balance. */
export function levelOf(view: Pick<CompanyView, "lifetimeRevenueCents" | "company">) {
  return companyLevel({ lifetimeRevenueCents: view.lifetimeRevenueCents, workDays: view.company.workDay });
}

export function postingOf(row: PostingRow): Posting {
  return { id: row.id, companyId: row.companyId, role: row.role, payCents: row.payCents, minCareerLevel: row.minCareerLevel, minScore: row.minScore, isOpen: row.isOpen, createdAt: row.createdAt };
}

export function applicationOf(row: ApplicationRow): Application {
  return { id: row.id, postingId: row.postingId, username: row.username, careerTitle: row.careerTitle, score: row.score, status: row.status, appliedAt: row.appliedAt };
}

/** Whether this member may open postings and hire: the founder always, others when granted. */
export function canHire(view: CompanyView, userId: string): boolean {
  const member = view.members.find((candidate) => candidate.userId === userId);
  return member !== undefined && (member.isFounder || member.canHire);
}

function companyOf(view: CompanyView, postings: readonly PostingRow[], applications: readonly ApplicationRow[], ownership: Ownership): Company {
  const { company } = view;
  const level = levelOf(view);
  return {
    id: company.id,
    name: company.name,
    category: company.category,
    state: company.state,
    fundsCents: view.fundsCents,
    workDay: company.workDay,
    rooms: [...view.rooms],
    servers: [...view.servers],
    members: view.members.map((member) => ({
      username: member.username,
      role: member.role,
      payCents: member.payCents,
      isFounder: member.isFounder,
      joinedAt: member.joinedAt,
      canHire: member.isFounder || member.canHire,
    })),
    pendingInvitations: view.pendingInvitations.map((invitation) => ({ id: invitation.id, username: invitation.username, role: invitation.role, payCents: invitation.payCents })),
    ledger: view.ledger.slice(-LEDGER_SHOWN).map((line) => ({ ...line })),
    funding: company.state === "unfunded" ? { ref: company.fundingRef, seedCents: company.fundingCents, expiresAt: company.fundingExpiresAt } : null,
    level: level.level,
    levelTitle: level.title,
    lifetimeRevenueCents: view.lifetimeRevenueCents,
    postings: postings.map(postingOf),
    applications: applications.map(applicationOf),
    ...ownership,
  };
}

export class CompanyService {
  private readonly deps: CompanyDeps;

  constructor(deps: CompanyDeps) {
    this.deps = deps;
  }

  /** Your company (with any expired, never-funded one dropped), the offers waiting for you and pay to claim. */
  async mine(caller: Caller): Promise<MyCompany> {
    const { store } = this.deps;
    const [view, invitations, payouts, applications, investing] = await Promise.all([
      this.companyFor(caller.id),
      store.receivedInvitations(caller.id),
      store.pendingPayouts(caller.id),
      this.deps.hiring?.myApplications(caller.id) ?? [],
      this.deps.investors ? myInvesting(caller.id, this.deps.investors, this.deps.proposals) : { investmentOffers: [], holdings: [], dividends: [], proposals: [] },
    ]);
    return { company: view ? await this.present(view, caller.id) : null, invitations, payouts, applications, ...investing };
  }

  async found(caller: Caller, request: FoundRequest): Promise<Outcome<{ companyId: string; fundingRef: string; seedCents: number }>> {
    const { store, now, newId } = this.deps;
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    if (await this.companyFor(caller.id)) return fail("already_in_company");
    if (!Number.isInteger(request.seedCents) || request.seedCents < FOUNDING_MINIMUM_CENTS) return fail("below_founding_minimum");
    const id = newId();
    const fundingRef = `company:fund:${id}:${newId()}`;
    const at = now();
    const created = await store.found(
      {
        id,
        name: request.name.trim(),
        category: request.category,
        founderId: caller.id,
        state: "unfunded",
        fundingRef,
        fundingCents: request.seedCents,
        fundingExpiresAt: at + FUNDING_WINDOW_MS,
        workDay: 0,
        lastSettledOn: null,
        createdAt: at,
      },
      // A founder starts on their role's minimum and can raise it once the company earns.
      { role: request.role, payCents: ROLE_MINIMUM_PAY_CENTS[request.role] },
    );
    return created ? ok({ companyId: id, fundingRef, seedCents: request.seedCents }) : fail("already_in_company");
  }

  async buyRoom(caller: Caller, room: RoomKindId, requestKey: string | null): Promise<Outcome<Company>> {
    return this.buy(caller, "room", requestKey, (view) => {
      const problem = checkRoomPurchase(bookOf(view), room);
      return problem ?? { kind: "room", item: room, costCents: roomKindById(room).costCents };
    });
  }

  async buyServer(caller: Caller, server: ServerTierId, requestKey: string | null): Promise<Outcome<Company>> {
    return this.buy(caller, "server", requestKey, (view) => {
      const problem = checkServerPurchase(bookOf(view), server);
      return problem ?? { kind: "server", item: server, costCents: serverTierById(server).costCents };
    });
  }

  async invite(caller: Caller, request: { username: string; role: Role; payCents: number }): Promise<Outcome<Company>> {
    const founded = await this.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    const invitee = await this.deps.store.findUser(request.username.trim());
    if (!invitee) return fail("unknown_user");
    if (invitee.id === caller.id) return fail("self_invite");
    // One company per player: someone already employed has to leave before an offer can mean anything.
    if (await this.deps.store.companyOf(invitee.id)) return fail("already_in_company");
    const problem = checkOffer(bookOf(view), request.role, request.payCents, view.pendingInvitations.length);
    if (problem) return fail(problem);
    const sent = await this.deps.store.invite({ id: this.deps.newId(), companyId: view.company.id, userId: invitee.id, role: request.role, payCents: request.payCents, at: this.deps.now() });
    return sent ? this.reloaded(view.company.id, caller.id) : fail("already_invited");
  }

  /** Only the founder may change a member's role, pay or hiring permission. */
  async setMember(caller: Caller, request: { username: string; role: Role; payCents: number; canHire?: boolean }): Promise<Outcome<Company>> {
    const founded = await this.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    const member = view.members.find((candidate) => candidate.username === request.username);
    if (!member) return fail("not_in_company");
    // A changed offer to someone already seated: they keep their desk, so judge it with them out of the count.
    const others = { ...bookOf(view), members: bookOf(view).members.filter((candidate) => candidate.userId !== member.userId) };
    const problem = checkOffer(others, request.role, request.payCents, view.pendingInvitations.length);
    if (problem) return fail(problem);
    await this.deps.store.setMember(view.company.id, member.userId, request.role, request.payCents, member.isFounder ? undefined : request.canHire);
    return this.reloaded(view.company.id, caller.id);
  }

  /** The founder lets a member go: their desk frees up; pay already booked for them stays theirs to claim. */
  async fire(caller: Caller, username: string): Promise<Outcome<Company>> {
    const founded = await this.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    const member = view.members.find((candidate) => candidate.username === username);
    if (!member) return fail("not_in_company");
    if (member.isFounder) return fail("cannot_fire_founder");
    await this.deps.store.removeMember(view.company.id, member.userId);
    return this.reloaded(view.company.id, caller.id);
  }

  /** A member walks out, free to found or join another company; the founder can't (there's no handover yet). */
  async leave(caller: Caller): Promise<Outcome<MyCompany>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const view = await this.companyFor(caller.id);
    if (!view) return fail("not_in_company");
    if (view.company.founderId === caller.id) return fail("founder_cannot_leave");
    await this.deps.store.removeMember(view.company.id, caller.id);
    return ok(await this.mine(caller));
  }

  async accept(caller: Caller, invitationId: string): Promise<Outcome<Company>> {
    const { store } = this.deps;
    const invitation = await store.invitation(invitationId);
    if (!invitation || invitation.userId !== caller.id || invitation.status !== "pending") return fail("invitation_not_found");
    if (await this.companyFor(caller.id)) return fail("already_in_company");
    const joined = await store.accept(invitation, this.deps.now());
    return joined ? this.reloaded(invitation.companyId, caller.id) : fail("already_in_company");
  }

  async decline(caller: Caller, invitationId: string): Promise<Outcome<null>> {
    const invitation = await this.deps.store.invitation(invitationId);
    if (!invitation || invitation.userId !== caller.id || invitation.status !== "pending") return fail("invitation_not_found");
    await this.deps.store.decline(invitationId);
    return ok(null);
  }

  /** Any member may close the day, once per real UTC day. */
  async settle(caller: Caller): Promise<Outcome<WorkDaySettlement>> {
    const { store, now } = this.deps;
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const view = await this.companyFor(caller.id);
    if (!view) return fail("not_in_company");
    if (view.company.state !== "active") return fail("not_active");
    const at = now();
    const today = utcDay(at);
    if (view.company.lastSettledOn === today) return fail("already_settled_today");

    const book = bookOf(view);
    const pantryOf = this.deps.pantryOf;
    const pantryCents = pantryOf ? (await Promise.all(book.members.map((member) => pantryOf(member.userId, today)))).reduce((sum, cents) => sum + cents, 0) : 0;
    // Work the server graded and no closed day has counted yet, across every member; the client's own count is ignored.
    const countable = Math.min(MAX_TASKS_PER_DAY, TASKS_PER_MEMBER_CAP * book.members.length);
    const workIds = this.deps.work ? await this.deps.work.unsettledShipped(view.company.id, countable) : [];
    const settlement = settleWorkDay(book, {
      pantryCents,
      healthyShare: HEALTHY_SHARE_DEFAULT,
      tasksShipped: workIds.length,
      // Contractors are booked per issue once phase 2 records issues; a day settles without them until then.
      contractorCents: 0,
    });
    const workDay = view.company.workDay + 1;
    const nameOf = new Map(view.members.map((member) => [member.userId, member.username]));
    const lines = settlement.lines.map((line) => ({
      ref: line.userId ? `day:${workDay}:${line.reason}:${line.userId}` : `day:${workDay}:${line.reason}`,
      reason: line.reason,
      amountCents: line.amountCents,
      userId: line.userId ?? null,
      note: line.userId ? (nameOf.get(line.userId) ?? null) : null,
    }));
    const payouts = settlement.payroll
      .filter((pay) => pay.amountCents > 0)
      .map((pay) => ({ id: `${view.company.id}:${workDay}:${pay.userId}`, userId: pay.userId, amountCents: pay.amountCents }));
    // A day that closes a week also pays investors their share of the week's profit, in the same batch.
    const dividends = this.deps.investors ? await dividendsOn(view, workDay, lines, settlement.fundsAfter, this.deps.investors) : { lines: [], payouts: [] };
    const booked = await store.settle({
      companyId: view.company.id,
      fromWorkDay: view.company.workDay,
      today,
      at,
      lines: [...lines, ...dividends.lines],
      payouts,
      dividends: dividends.payouts,
      workIds,
    });
    if (!booked) return fail("already_settled_today");
    return ok({
      workDay,
      lines: [...lines, ...dividends.lines].map((line) => ({ at, workDay, reason: line.reason, amountCents: line.amountCents, note: line.note })),
      fundsAfter: settlement.fundsAfter - dividends.payouts.reduce((sum, payout) => sum + payout.amountCents, 0),
      isPayrollShort: settlement.isPayrollShort,
    });
  }

  /** The caller's company, unless it's an unfunded one whose window closed — that one is dropped. */
  async companyFor(userId: string): Promise<CompanyView | null> {
    const view = await this.deps.store.companyOf(userId);
    if (view && view.company.state === "unfunded" && view.company.fundingExpiresAt <= this.deps.now()) {
      await this.deps.store.dropUnfunded(view.company.id);
      return null;
    }
    return view;
  }

  /** The caller's company when they founded it and it's running; rate-limited like every founder write. */
  async foundersCompany(caller: Caller): Promise<Outcome<CompanyView>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const view = await this.companyFor(caller.id);
    if (!view) return fail("not_in_company");
    if (view.company.founderId !== caller.id) return fail("not_founder");
    if (view.company.state !== "active") return fail("not_active");
    return ok(view);
  }

  private async buy(
    caller: Caller,
    kind: "room" | "server",
    requestKey: string | null,
    choose: (view: CompanyView) => "not_enough_funds" | "no_free_rack" | { kind: "room"; item: RoomKindId; costCents: number } | { kind: "server"; item: ServerTierId; costCents: number },
  ): Promise<Outcome<Company>> {
    const founded = await this.foundersCompany(caller);
    if (!founded.ok) return founded;
    const view = founded.value;
    // A retried request carries the same key and ref: recognise it before re-checking funds it already spent.
    const key = requestKey ?? this.deps.newId();
    const ref = `${kind}:${key}`;
    if (requestKey !== null && (await this.deps.store.isBooked(view.company.id, ref))) return this.reloaded(view.company.id, caller.id);
    const choice = choose(view);
    if (typeof choice === "string") return fail(choice);
    const common = { id: `${view.company.id}:${kind}:${key}`, ref, costCents: choice.costCents, at: this.deps.now(), workDay: view.company.workDay };
    const purchase = choice.kind === "room" ? { ...common, kind: "room" as const, item: choice.item } : { ...common, kind: "server" as const, item: choice.item };
    const result = await this.deps.store.buy(view.company.id, purchase);
    return result === "short" ? fail("not_enough_funds") : this.reloaded(view.company.id, caller.id);
  }

  /** The company as `viewerId` may see it: postings and applicants only for the founder and hiring managers. */
  async present(view: CompanyView, viewerId: string): Promise<Company> {
    const { hiring, investors } = this.deps;
    const ownership = investors && view.company.state === "active" ? await ownershipOf(view, viewerId, investors, this.deps.proposals) : NO_OWNERSHIP;
    if (!hiring || !canHire(view, viewerId)) return companyOf(view, [], [], ownership);
    const [postings, applications] = await Promise.all([hiring.postingsOf(view.company.id), hiring.applicationsOf(view.company.id)]);
    return companyOf(view, postings, applications, ownership);
  }

  async reloaded(companyId: string, viewerId: string): Promise<Outcome<Company>> {
    const view = await this.deps.store.companyById(companyId);
    return view ? ok(await this.present(view, viewerId)) : fail("not_in_company");
  }
}
