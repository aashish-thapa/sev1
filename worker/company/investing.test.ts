import { describe, expect, it } from "vitest";
import { FOUNDING_MINIMUM_CENTS } from "../../src/domain/company/rules.ts";
import { payRef } from "../../src/domain/economy.ts";
import { earn, emptyProgress, type Progress } from "../../src/domain/progress.ts";
import { earnDividend, fundCompany, invest } from "../../src/domain/purchases.ts";
import { MyCompanySchema, type DealWire } from "../../src/storage/company-protocol.ts";
import { AccountService } from "../api/accounts.ts";
import type { AccountStore, LedgerRow, RankedAccount, SavedProgress, SaveMoves, Standing, User } from "../api/store.ts";
import { dealOfferId } from "./deal-store.ts";
import { DealService } from "./deals.ts";
import { ACCEPTED_OFFER_MS, InvestingService, investRefOf } from "./investing.ts";
import type { OfferRow } from "./investor-store.ts";
import { MemoryDealStore } from "./memory-deal-store.ts";
import { CompanyDirectory } from "./directory.ts";
import { MemoryCompanyDirectory, MemoryHiringStore } from "./memory-hiring-store.ts";
import { MemoryInvestorStore } from "./memory-investor-store.ts";
import { MemoryProposalStore } from "./memory-proposal-store.ts";
import { ProposalService } from "./proposals.ts";
import { MemoryCompanyStore } from "./memory-store.ts";
import { CompanyService } from "./service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 10, 9);
const SEED = FOUNDING_MINIMUM_CENTS + 50_000;

function richProgress(cents: number): Progress {
  let progress = emptyProgress();
  for (let index = 0; progress.wallet.balanceCents < cents; index += 1) {
    progress = earn(progress, { kind: "incident", ref: payRef.incident(`seed-run-${index}`, START + index), points: 100, title: "x", isTeam: false }, START);
  }
  return progress;
}

/** Saves through AccountService, applying company and investor moves like the D1 save batch does. */
class MemoryAccounts implements AccountStore {
  readonly saved = new Map<string, SavedProgress>();
  private readonly apply: (userId: string, moves: SaveMoves, at: number) => void;
  constructor(apply: (userId: string, moves: SaveMoves, at: number) => void) {
    this.apply = apply;
  }
  async findUser() {
    return null;
  }
  async createUser() {
    return true;
  }
  async createSession() {}
  async findSessionUser() {
    return null;
  }
  async deleteSession() {}
  async loadProgress(userId: string) {
    return this.saved.get(userId) ?? null;
  }
  async saveProgress(userId: string, progress: SavedProgress, _standing: Standing, _credits: readonly LedgerRow[], moves?: SaveMoves) {
    this.saved.set(userId, progress);
    if (moves) this.apply(userId, moves, progress.updatedAt);
  }
  async topAccounts(): Promise<RankedAccount[]> {
    return [];
  }
  async rankOf() {
    return null;
  }
  async ledgerBalance() {
    return 0;
  }
  async countAttempt() {
    return 1;
  }
}

function world() {
  let now = START;
  let ids = 0;
  const store = new MemoryCompanyStore();
  const investors = new MemoryInvestorStore(store);
  const wallets = new Map<string, Progress>();
  const accountStore = new MemoryAccounts((userId, moves, at) => {
    store.applyMoves(userId, moves, at);
    investors.applyMoves(userId, moves, at);
  });
  const accounts = new AccountService(accountStore, () => now, { bank: store, investors });
  const newId = () => `id-${(ids += 1)}`;
  const proposalStore = new MemoryProposalStore((companyId) => store.companies.get(companyId)?.name ?? "");
  let dealsOf: (userId: string) => Promise<DealWire[]> = async () => [];
  const companies = new CompanyService({ store, now: () => now, newId, isOverLimit: async () => false, investors, proposals: proposalStore, dealsOf: (userId) => dealsOf(userId) });
  const investing = new InvestingService({
    investors,
    companies: store,
    company: companies,
    now: () => now,
    isOverLimit: async () => false,
    balanceOf: async (userId) => wallets.get(userId)?.wallet.balanceCents ?? 0,
  });
  /** Who's in the company's office right now, by user id. */
  const inOffice = new Set<string>();
  const dealStore = new MemoryDealStore(store, investors);
  const deals = new DealService({
    deals: dealStore,
    companies: store,
    company: companies,
    investing,
    investors,
    meetingRoomOf: async () => "OFFC",
    presence: async (code) => (code === "OFFC" ? inOffice : new Set()),
    balanceOf: async (userId) => wallets.get(userId)?.wallet.balanceCents ?? 0,
    now: () => now,
    newId,
    isOverLimit: async () => false,
  });
  dealsOf = (userId) => deals.dealsOf(userId);
  const proposals = new ProposalService({
    proposals: proposalStore,
    investors,
    companies: store,
    company: companies,
    deals,
    now: () => now,
    newId,
    isOverLimit: async () => false,
  });
  const user = (id: string, username: string): User => {
    store.addUser(id, username);
    return { id, username, passwordHash: "", createdAt: START - DAY_MS, tags: [] };
  };
  /** Saves a player's progress and remembers it as their wallet of record. */
  const save = async (player: User, progress: Progress) => {
    now += 30_000;
    const saved = await accounts.saveProgress(player, progress);
    if (saved.ok) wallets.set(player.id, progress);
    return saved;
  };
  return { store, investors, accounts, companies, investing, deals, dealStore, inOffice, proposals, user, save, wallets, advance: (ms: number) => (now += ms), now: () => now };
}

type World = ReturnType<typeof world>;

async function foundedCompany(setup: World, founder: User) {
  const before = richProgress(SEED);
  await setup.save(founder, before);
  const founded = await setup.companies.found(founder, { name: "Acme Ops", category: "ecommerce", role: "infrastructure", seedCents: SEED });
  if (!founded.ok) throw new Error(founded.problem);
  const spent = fundCompany(before.wallet, founded.value.fundingRef, SEED, setup.now());
  if (!spent.ok) throw new Error("couldn't spend the seed");
  await setup.save(founder, { ...before, wallet: spent.wallet });
  return founded.value.companyId;
}

/** A player with a saved wallet holding at least `cents`. */
async function investorWith(setup: World, id: string, username: string, cents: number) {
  const player = setup.user(id, username);
  await setup.save(player, richProgress(cents));
  return player;
}

/** The investor accepts, then pays in their next save; returns that save's outcome. */
async function investIn(setup: World, investor: User, offerId: string) {
  const accepted = await setup.investing.accept(investor, offerId);
  if (!accepted.ok) throw new Error(accepted.problem);
  const progress = setup.wallets.get(investor.id) as Progress;
  const spent = invest(progress.wallet, accepted.value.investRef, accepted.value.amountCents, setup.now());
  if (!spent.ok) throw new Error("couldn't spend");
  return setup.save(investor, { ...progress, wallet: spent.wallet });
}

/** An offer made before investments were agreed in meetings: open, for the investor to accept from anywhere. */
async function legacyOffer(setup: World, companyId: string, investor: User, amountCents: number, equityBps: number): Promise<OfferRow> {
  const id = `legacy-${setup.investors.offers.size + 1}`;
  const offer: OfferRow = { id, companyId, investorId: investor.id, investor: investor.username, amountCents, equityBps, status: "open", investRef: investRefOf(id), expiresAt: null, createdAt: setup.now() };
  await setup.investors.createOffer(offer, null);
  return offer;
}

/** The founder offers, both meet in the office and agree: the deal is booked as an accepted offer for the investor's save to pay. */
async function offerTo(setup: World, founder: User, investor: User, amountCents: number, equityBps: number) {
  const made = await setup.deals.offer(founder, { investor: investor.username, amountCents, equityBps }, null);
  if (!made.ok) throw new Error(made.problem);
  const [deal] = (await setup.deals.dealsOf(investor.id)).filter((candidate) => candidate.stage === "talking");
  setup.inOffice.add(founder.id).add(investor.id);
  for (const party of [founder, investor]) {
    const agreed = await setup.deals.agree(party, deal.id, { amountCents, equityBps });
    if (!agreed.ok) throw new Error(agreed.problem);
  }
  setup.inOffice.clear();
  return { id: dealOfferId(deal.id), dealId: deal.id };
}

describe("offers", () => {
  it("lets only the founder offer, and enforces the minimum, the per-offer cap and the founder's control", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    await investorWith(setup, "u3", "ana", 0);
    const offer = (investor: string, amountCents: number, equityBps: number) => setup.deals.offer(founder, { investor, amountCents, equityBps }, null);

    expect(await offer("maya", 50_000, 1_000)).toEqual({ ok: false, problem: "self_offer" });
    expect(await offer("sam", 49_999, 1_000)).toEqual({ ok: false, problem: "below_minimum_investment" });
    expect(await offer("sam", 50_000, 4_901)).toEqual({ ok: false, problem: "too_much_equity" });
    expect(await offer("nobody", 50_000, 1_000)).toEqual({ ok: false, problem: "unknown_user" });
    expect(await setup.deals.offer(sam, { investor: "ana", amountCents: 50_000, equityBps: 1_000 }, null)).toEqual({ ok: false, problem: "not_in_company" });

    // 30% already out dilutes the founder to 70%; another 30% would take them to 49%, 25% leaves 52.5%.
    await legacyOffer(setup, companyId, sam, 50_000, 3_000);
    expect(await offer("ana", 50_000, 3_000)).toEqual({ ok: false, problem: "founder_control" });
    expect((await offer("ana", 50_000, 2_500)).ok).toBe(true);
    // One deal on the table per investor.
    expect(await offer("ana", 50_000, 1_000)).toEqual({ ok: false, problem: "already_invited" });
  });

  it("opens a retried offer once", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    await investorWith(setup, "u2", "sam", 0);
    const request = { investor: "sam", amountCents: 50_000, equityBps: 1_000 };
    await setup.deals.offer(founder, request, "retry-key-1");
    expect((await setup.deals.offer(founder, request, "retry-key-1")).ok).toBe(true);
    expect(MyCompanySchema.parse(await setup.companies.mine(founder)).deals).toHaveLength(1);
  });

  it("shows an offer made before meetings to the investor with the company's implied valuation", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    await legacyOffer(setup, companyId, sam, 50_000, 1_000);
    const mine = MyCompanySchema.parse(await setup.companies.mine(sam));
    expect(mine.company).toBeNull();
    expect(mine.investmentOffers).toMatchObject([{ companyId, companyName: "Acme Ops", founder: "maya", amountCents: 50_000, equityBps: 1_000, valuationCents: 500_000 }]);
  });
});

describe("deals in person", () => {
  async function talking(setup: World) {
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 200_000);
    const made = await setup.proposals.propose(sam, companyId, { amountCents: 50_000, equityBps: 1_000 }, null);
    if (!made.ok) throw new Error(made.problem);
    const accepted = await setup.proposals.accept(founder, made.value.proposals[0].id);
    if (!accepted.ok) throw new Error(accepted.problem);
    const [deal] = await setup.deals.dealsOf(sam.id);
    return { founder, sam, companyId, deal };
  }

  it("takes an accepted proposal to a meeting, where new terms are tabled and both agree together before the investor pays", async () => {
    const setup = world();
    const { founder, sam, companyId, deal } = await talking(setup);
    expect(deal).toMatchObject({ companyId, companyName: "Acme Ops", founder: "maya", investor: "sam", terms: { amountCents: 50_000, equityBps: 1_000 }, stage: "talking", agreed: [], investRef: null });
    expect(MyCompanySchema.parse(await setup.companies.mine(founder)).deals.map((candidate) => candidate.id)).toEqual([deal.id]);
    expect(await setup.deals.meeting(sam, deal.id)).toEqual({ ok: true, value: { code: "OFFC" } });

    const counter = { amountCents: 100_000, equityBps: 1_500 };
    expect((await setup.deals.terms(sam, deal.id, counter)).ok).toBe(true);
    // Agreeing to what you read before the new terms binds you to nothing.
    expect(await setup.deals.agree(founder, deal.id, { amountCents: 50_000, equityBps: 1_000 })).toEqual({ ok: false, problem: "terms_changed" });
    // Apart, nobody can agree; together, the first agreement waits for the second.
    expect(await setup.deals.agree(founder, deal.id, counter)).toEqual({ ok: false, problem: "not_together" });
    setup.inOffice.add(founder.id);
    expect(await setup.deals.agree(founder, deal.id, counter)).toEqual({ ok: false, problem: "not_together" });
    setup.inOffice.add(sam.id);
    const first = await setup.deals.agree(founder, deal.id, counter);
    expect(first.ok && first.value.deals[0]).toMatchObject({ stage: "talking", agreed: ["founder"] });
    const second = await setup.deals.agree(sam, deal.id, counter);
    const agreed = second.ok ? second.value.deals[0] : null;
    expect(agreed).toMatchObject({ stage: "agreed", investRef: `company:invest:deal:${deal.id}`, terms: counter });
    expect(await setup.deals.terms(founder, deal.id, counter)).toEqual({ ok: false, problem: "deal_closed" });

    const progress = setup.wallets.get(sam.id) as Progress;
    const spent = invest(progress.wallet, agreed?.investRef ?? "", counter.amountCents, setup.now());
    if (!spent.ok) throw new Error("couldn't spend");
    expect((await setup.save(sam, { ...progress, wallet: spent.wallet })).ok).toBe(true);
    const company = MyCompanySchema.parse(await setup.companies.mine(founder)).company;
    expect(company?.capTable?.holders).toEqual([{ username: "sam", bps: 1_500, investedCents: 100_000 }]);
    // Paid: off both parties' lists.
    expect(MyCompanySchema.parse(await setup.companies.mine(sam)).deals).toEqual([]);
  });

  it("refuses to close what the investor's saved wallet can't cover, or what would cost the founder control", async () => {
    const setup = world();
    const { founder, sam, companyId, deal } = await talking(setup);
    setup.inOffice.add(founder.id).add(sam.id);
    const big = { amountCents: 500_000, equityBps: 1_000 };
    await setup.deals.terms(founder, deal.id, big);
    await setup.deals.agree(founder, deal.id, big);
    expect(await setup.deals.agree(sam, deal.id, big)).toEqual({ ok: false, problem: "not_enough_money" });

    const ana = await investorWith(setup, "u3", "ana", 0);
    await legacyOffer(setup, companyId, ana, 50_000, 4_500);
    const control = { amountCents: 50_000, equityBps: 1_000 };
    await setup.deals.terms(sam, deal.id, control);
    await setup.deals.agree(founder, deal.id, control);
    expect(await setup.deals.agree(sam, deal.id, control)).toEqual({ ok: false, problem: "founder_control" });
  });

  it("lets either side walk away, and only the two of them touch the deal", async () => {
    const setup = world();
    const { founder, sam, deal } = await talking(setup);
    const ana = await investorWith(setup, "u3", "ana", 0);
    expect(await setup.deals.walkAway(ana, deal.id)).toEqual({ ok: false, problem: "deal_not_found" });
    expect(await setup.deals.meeting(ana, deal.id)).toEqual({ ok: false, problem: "deal_not_found" });
    expect((await setup.deals.walkAway(sam, deal.id)).ok).toBe(true);
    expect(await setup.deals.walkAway(founder, deal.id)).toEqual({ ok: false, problem: "deal_closed" });
    expect(await setup.deals.meeting(founder, deal.id)).toEqual({ ok: false, problem: "deal_closed" });
    expect(MyCompanySchema.parse(await setup.companies.mine(founder)).deals).toEqual([]);
  });

  it("shows the last closed round on the company list, and a public office layout without money", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const directory = new CompanyDirectory(new MemoryCompanyDirectory(setup.store, new MemoryHiringStore(setup.store), setup.investors), (id) => setup.store.companyById(id));
    expect((await directory.top())[0].lastRound).toBeNull();
    await investIn(setup, sam, (await offerTo(setup, founder, sam, 50_000, 1_000)).id);
    expect((await directory.top())[0].lastRound).toEqual({ valuationCents: 500_000, workDay: 0, at: setup.now() });
    const layout = await directory.layout(companyId);
    expect(layout).toMatchObject({ name: "Acme Ops", category: "ecommerce", rooms: ["bay"], members: [{ username: "maya", isFounder: true }] });
    expect(JSON.stringify(layout)).not.toMatch(/Cents/);
  });

  it("gives the investor a pass into the office only while their deal is on the table", async () => {
    const setup = world();
    const { founder, sam, companyId, deal } = await talking(setup);
    expect(await setup.dealStore.isTalkingWith(companyId, sam.id)).toBe(true);
    expect(await setup.dealStore.isTalkingWith(companyId, founder.id)).toBe(false);
    await setup.deals.walkAway(founder, deal.id);
    expect(await setup.dealStore.isTalkingWith(companyId, sam.id)).toBe(false);
  });
});

describe("investing", () => {
  it("moves the money and the stake together when the investor's save pays", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const fundsBefore = (await setup.store.companyById(companyId))?.fundsCents ?? 0;
    const offer = await offerTo(setup, founder, sam, 50_000, 1_000);

    expect((await investIn(setup, sam, offer.id)).ok).toBe(true);

    const company = MyCompanySchema.parse(await setup.companies.mine(founder)).company;
    expect(company?.capTable).toEqual({ founder: "maya", founderBps: 9_000, holders: [{ username: "sam", bps: 1_000, investedCents: 50_000 }] });
    expect(company?.fundsCents).toBe(fundsBefore + 50_000);
    expect(company?.investmentOffers).toEqual([]);
    expect(company?.trackers?.investedCents).toBe(50_000);
    expect(company?.ledger.at(-1)).toMatchObject({ reason: "investment", amountCents: 50_000, note: "sam" });
    const investorView = MyCompanySchema.parse(await setup.companies.mine(sam));
    expect(investorView.holdings).toEqual([{ companyId, companyName: "Acme Ops", bps: 1_000, investedCents: 50_000 }]);
    expect(investorView.investmentOffers).toEqual([]);
  });

  it("dilutes earlier investors pro rata", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const ana = await investorWith(setup, "u3", "ana", 60_000);
    await investIn(setup, sam, (await offerTo(setup, founder, sam, 50_000, 1_000)).id);
    await investIn(setup, ana, (await offerTo(setup, founder, ana, 50_000, 2_000)).id);
    const table = MyCompanySchema.parse(await setup.companies.mine(founder)).company?.capTable;
    expect(table?.holders).toEqual([
      { username: "ana", bps: 2_000, investedCents: 50_000 },
      { username: "sam", bps: 800, investedCents: 50_000 },
    ]);
    expect(table?.founderBps).toBe(7_200);
  });

  it("refuses to accept what the investor's saved wallet can't cover, and renews the same ref on a retry", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const poor = await investorWith(setup, "u2", "sam", 0);
    const offer = await legacyOffer(setup, companyId, poor, 50_000, 1_000);
    expect(await setup.investing.accept(poor, offer.id)).toEqual({ ok: false, problem: "not_enough_money" });

    await setup.save(poor, richProgress(60_000));
    const first = await setup.investing.accept(poor, offer.id);
    const again = await setup.investing.accept(poor, offer.id);
    expect(first.ok && again.ok && first.value).toEqual(again.ok && again.value);
    expect(first.ok && first.value).toEqual({ investRef: `company:invest:${offer.id}`, amountCents: 50_000 });
  });

  it("refuses an investment spend the server never agreed to, or one whose window closed", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const offer = await legacyOffer(setup, companyId, sam, 50_000, 1_000);
    const progress = setup.wallets.get(sam.id) as Progress;
    const unaccepted = invest(progress.wallet, `company:invest:${offer.id}`, 50_000, setup.now());
    if (!unaccepted.ok) throw new Error("couldn't spend");
    expect((await setup.save(sam, { ...progress, wallet: unaccepted.wallet })).ok).toBe(false);

    await setup.investing.accept(sam, offer.id);
    setup.advance(ACCEPTED_OFFER_MS);
    expect((await setup.save(sam, { ...progress, wallet: unaccepted.wallet })).ok).toBe(false);
    expect(MyCompanySchema.parse(await setup.companies.mine(founder)).company?.capTable?.holders).toEqual([]);
  });

  it("lets the founder cancel and the investor decline an open offer, but not one being paid", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const cancelled = await legacyOffer(setup, companyId, sam, 50_000, 1_000);
    expect((await setup.investing.cancel(founder, cancelled.id)).ok).toBe(true);
    expect(await setup.investing.accept(sam, cancelled.id)).toEqual({ ok: false, problem: "offer_not_found" });

    const declined = await legacyOffer(setup, companyId, sam, 50_000, 1_000);
    expect(await setup.investing.decline(founder, declined.id)).toEqual({ ok: false, problem: "offer_not_found" });
    expect((await setup.investing.decline(sam, declined.id)).ok).toBe(true);

    const paying = await legacyOffer(setup, companyId, sam, 50_000, 1_000);
    await setup.investing.accept(sam, paying.id);
    expect(await setup.investing.cancel(founder, paying.id)).toEqual({ ok: false, problem: "offer_not_found" });
    expect(await setup.investing.decline(sam, paying.id)).toEqual({ ok: false, problem: "offer_not_found" });
  });
});

describe("dividends", () => {
  it("pays investors their share of the week's profit on the seventh work day, claimed once in a save", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    await investIn(setup, sam, (await offerTo(setup, founder, sam, 50_000, 1_000)).id);
    // Six good days already on the books; day seven closes the week.
    const company = setup.store.companies.get(companyId);
    if (!company) throw new Error("no company");
    setup.store.companies.set(companyId, { ...company, workDay: 6 });
    for (let day = 1; day <= 6; day += 1) {
      setup.store.ledger.push({ companyId, ref: `test:revenue:${day}`, reason: "revenue", amountCents: 100_000, at: START, workDay: day, note: null });
    }

    const settled = await setup.companies.settle(founder);
    if (!settled.ok) throw new Error(settled.problem);
    const operating = setup.store.ledger.filter((line) => line.companyId === companyId && line.workDay >= 1 && ["revenue", "room-upkeep", "server-upkeep", "contractor", "pantry", "payroll"].includes(line.reason));
    const profit = operating.reduce((sum, line) => sum + line.amountCents, 0);
    const expected = Math.floor((profit * 1_000) / 10_000);
    expect(settled.value.lines.filter((line) => line.reason === "dividend")).toMatchObject([{ amountCents: -expected, note: "sam" }]);

    const [dividend] = MyCompanySchema.parse(await setup.companies.mine(sam)).dividends;
    expect(dividend).toMatchObject({ companyId, companyName: "Acme Ops", workDay: 7, amountCents: expected });
    const progress = setup.wallets.get(sam.id) as Progress;
    const claimed = { ...progress, wallet: earnDividend(progress.wallet, dividend, setup.now()) };
    expect((await setup.save(sam, claimed)).ok).toBe(true);
    expect(MyCompanySchema.parse(await setup.companies.mine(sam)).dividends).toEqual([]);
    // Claiming it again under a fresh line is refused: it's no longer owed.
    const twice = { ...claimed, wallet: earnDividend({ ...claimed.wallet, ledger: claimed.wallet.ledger.slice(0, -1) }, dividend, setup.now()) };
    expect((await setup.save(sam, twice)).ok).toBe(false);
  });

  it("pays nothing on other days, or without investors", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const settled = await setup.companies.settle(founder);
    expect(settled.ok && settled.value.lines.some((line) => line.reason === "dividend")).toBe(false);
    expect(setup.store.dividendPayouts.size).toBe(0);
  });
});

describe("proposals", () => {
  it("lets anyone but the founder propose, on terms the founder could offer, one at a time", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    const propose = (player: User, amountCents: number, equityBps: number, key: string | null = null) =>
      setup.proposals.propose(player, companyId, { amountCents, equityBps }, key);

    expect(await propose(founder, 50_000, 1_000)).toEqual({ ok: false, problem: "self_offer" });
    expect(await propose(sam, 49_999, 1_000)).toEqual({ ok: false, problem: "below_minimum_investment" });
    expect(await propose(sam, 50_000, 4_901)).toEqual({ ok: false, problem: "too_much_equity" });
    expect(await setup.proposals.propose(sam, "no-such-company", { amountCents: 50_000, equityBps: 1_000 }, null)).toEqual({ ok: false, problem: "not_active" });

    const made = await propose(sam, 50_000, 1_000, "key-1");
    expect(made.ok && made.value.proposals).toMatchObject([{ companyId, companyName: "Acme Ops", investor: "sam", amountCents: 50_000, equityBps: 1_000 }]);
    // A retried request is the same proposal; a fresh one while it's pending is refused.
    expect((await propose(sam, 50_000, 1_000, "key-1")).ok).toBe(true);
    expect(await propose(sam, 60_000, 1_000, "key-2")).toEqual({ ok: false, problem: "already_proposed" });

    const company = MyCompanySchema.parse(await setup.companies.mine(founder)).company;
    expect(company?.investmentProposals).toMatchObject([{ investor: "sam", amountCents: 50_000, equityBps: 1_000 }]);
  });

  it("turns an accepted proposal into a deal to settle in a meeting, accepted once", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const made = await setup.proposals.propose(sam, companyId, { amountCents: 50_000, equityBps: 1_000 }, null);
    const proposalId = made.ok ? made.value.proposals[0].id : "";

    const accepted = await setup.proposals.accept(founder, proposalId);
    expect(accepted.ok && accepted.value.investmentProposals).toEqual([]);
    expect(await setup.proposals.accept(founder, proposalId)).toEqual({ ok: false, problem: "proposal_not_found" });

    const mine = MyCompanySchema.parse(await setup.companies.mine(sam));
    expect(mine.proposals).toEqual([]);
    expect(mine.investmentOffers).toEqual([]);
    expect(mine.deals).toMatchObject([{ companyId, stage: "talking", terms: { amountCents: 50_000, equityBps: 1_000 } }]);
  });

  it("re-checks founder control against the offers already out when accepting", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    const ana = await investorWith(setup, "u3", "ana", 0);
    const made = await setup.proposals.propose(sam, companyId, { amountCents: 50_000, equityBps: 3_000 }, null);
    await legacyOffer(setup, companyId, ana, 50_000, 3_000);
    expect(await setup.proposals.accept(founder, made.ok ? made.value.proposals[0].id : "")).toEqual({ ok: false, problem: "founder_control" });
  });

  it("lets the founder decline and the proposer withdraw, while it's pending, and nobody else", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    const ana = await investorWith(setup, "u3", "ana", 0);
    const proposalOf = async (player: User) => {
      const made = await setup.proposals.propose(player, companyId, { amountCents: 50_000, equityBps: 1_000 }, null);
      if (!made.ok) throw new Error(made.problem);
      return made.value.proposals[0].id;
    };

    const fromSam = await proposalOf(sam);
    expect(await setup.proposals.withdraw(ana, fromSam)).toEqual({ ok: false, problem: "proposal_not_found" });
    expect(await setup.proposals.decline(sam, fromSam)).toEqual({ ok: false, problem: "not_in_company" });
    const declined = await setup.proposals.decline(founder, fromSam);
    expect(declined.ok && declined.value.investmentProposals).toEqual([]);
    expect(await setup.proposals.withdraw(sam, fromSam)).toEqual({ ok: false, problem: "proposal_not_found" });

    const fromAna = await proposalOf(ana);
    const withdrawn = await setup.proposals.withdraw(ana, fromAna);
    expect(withdrawn.ok && withdrawn.value.proposals).toEqual([]);
    expect(await setup.proposals.accept(founder, fromAna)).toEqual({ ok: false, problem: "proposal_not_found" });
    // Once answered, a new proposal may go in.
    expect((await setup.proposals.propose(ana, companyId, { amountCents: 50_000, equityBps: 1_000 }, null)).ok).toBe(true);
  });
});

describe("staffing", () => {
  async function withMember(setup: World, founder: User, id: string, username: string) {
    const member = await investorWith(setup, id, username, 0);
    const invited = await setup.companies.invite(founder, { username, role: "frontend", payCents: 20_000 });
    if (!invited.ok) throw new Error(invited.problem);
    const invitation = invited.value.pendingInvitations.find((candidate) => candidate.username === username);
    const joined = await setup.companies.accept(member, invitation?.id ?? "");
    if (!joined.ok) throw new Error(joined.problem);
    return member;
  }

  it("lets only the founder fire, never the founder, and frees the desk while booked pay and stakes stay", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const sam = await withMember(setup, founder, "u2", "sam");
    const ana = await withMember(setup, founder, "u3", "ana");
    expect((await setup.companies.settle(founder)).ok).toBe(true);
    await setup.save(sam, richProgress(60_000));
    const offer = await offerTo(setup, founder, sam, 50_000, 1_000);
    expect((await investIn(setup, sam, offer.id)).ok).toBe(true);
    const payoutsBefore = await setup.store.pendingPayouts(sam.id);
    expect(payoutsBefore.length).toBeGreaterThan(0);

    expect(await setup.companies.fire(ana, "sam")).toEqual({ ok: false, problem: "not_founder" });
    expect(await setup.companies.fire(founder, "maya")).toEqual({ ok: false, problem: "cannot_fire_founder" });
    expect(await setup.companies.fire(founder, "nobody")).toEqual({ ok: false, problem: "not_in_company" });

    const fired = await setup.companies.fire(founder, "sam");
    expect(fired.ok && fired.value.members.map((member) => member.username)).toEqual(["maya", "ana"]);
    expect(fired.ok && fired.value.capTable?.holders).toEqual([{ username: "sam", bps: 1_000, investedCents: 50_000 }]);
    const samNow = MyCompanySchema.parse(await setup.companies.mine(sam));
    expect(samNow.company).toBeNull();
    expect(samNow.payouts).toEqual(payoutsBefore);
    expect(samNow.holdings).toHaveLength(1);
  });

  it("lets a member leave and found their own, but not the founder", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const sam = await withMember(setup, founder, "u2", "sam");

    expect(await setup.companies.leave(founder)).toEqual({ ok: false, problem: "founder_cannot_leave" });
    const left = await setup.companies.leave(sam);
    expect(left.ok && left.value.company).toBeNull();
    expect(await setup.companies.leave(sam)).toEqual({ ok: false, problem: "not_in_company" });
    const company = MyCompanySchema.parse(await setup.companies.mine(founder)).company;
    expect(company?.members.map((member) => member.username)).toEqual(["maya"]);
    // Out of a company, they're free to found one.
    expect((await setup.companies.found(sam, { name: "Sam Co", category: "saas", role: "frontend", seedCents: FOUNDING_MINIMUM_CENTS })).ok).toBe(true);
  });
});
