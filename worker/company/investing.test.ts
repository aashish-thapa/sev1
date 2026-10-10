import { describe, expect, it } from "vitest";
import { FOUNDING_MINIMUM_CENTS } from "../../src/domain/company/rules.ts";
import { payRef } from "../../src/domain/economy.ts";
import { earn, emptyProgress, type Progress } from "../../src/domain/progress.ts";
import { earnDividend, fundCompany, invest } from "../../src/domain/purchases.ts";
import { MyCompanySchema } from "../../src/storage/company-protocol.ts";
import { AccountService } from "../api/accounts.ts";
import type { AccountStore, LedgerRow, RankedAccount, SavedProgress, SaveMoves, Standing, User } from "../api/store.ts";
import { ACCEPTED_OFFER_MS, InvestingService } from "./investing.ts";
import { MemoryInvestorStore } from "./memory-investor-store.ts";
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
  const accounts = new AccountService(accountStore, () => now, undefined, store, undefined, investors);
  const newId = () => `id-${(ids += 1)}`;
  const companies = new CompanyService({ store, now: () => now, newId, isOverLimit: async () => false, investors });
  const investing = new InvestingService({
    investors,
    companies: store,
    company: companies,
    now: () => now,
    newId,
    isOverLimit: async () => false,
    balanceOf: async (userId) => wallets.get(userId)?.wallet.balanceCents ?? 0,
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
  return { store, investors, accounts, companies, investing, user, save, wallets, advance: (ms: number) => (now += ms), now: () => now };
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

async function offerTo(setup: World, founder: User, investor: string, amountCents: number, equityBps: number) {
  const made = await setup.investing.offer(founder, { investor, amountCents, equityBps }, null);
  if (!made.ok) throw new Error(made.problem);
  const offer = made.value.investmentOffers.find((candidate) => candidate.investor === investor);
  if (!offer) throw new Error("offer missing");
  return offer;
}

describe("offers", () => {
  it("lets only the founder offer, and enforces the minimum, the per-offer cap and the founder's control", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    await investorWith(setup, "u3", "ana", 0);
    const offer = (investor: string, amountCents: number, equityBps: number) => setup.investing.offer(founder, { investor, amountCents, equityBps }, null);

    expect(await offer("maya", 50_000, 1_000)).toEqual({ ok: false, problem: "self_offer" });
    expect(await offer("sam", 49_999, 1_000)).toEqual({ ok: false, problem: "below_minimum_investment" });
    expect(await offer("sam", 50_000, 4_901)).toEqual({ ok: false, problem: "too_much_equity" });
    expect(await offer("nobody", 50_000, 1_000)).toEqual({ ok: false, problem: "unknown_user" });
    expect(await setup.investing.offer(sam, { investor: "ana", amountCents: 50_000, equityBps: 1_000 }, null)).toEqual({ ok: false, problem: "not_in_company" });

    expect((await offer("sam", 50_000, 3_000)).ok).toBe(true);
    // 30% already out dilutes the founder to 70%; another 30% would take them to 49%, 25% leaves 52.5%.
    expect(await offer("ana", 50_000, 3_000)).toEqual({ ok: false, problem: "founder_control" });
    expect((await offer("ana", 50_000, 2_500)).ok).toBe(true);
  });

  it("makes a retried offer once", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    await investorWith(setup, "u2", "sam", 0);
    const request = { investor: "sam", amountCents: 50_000, equityBps: 1_000 };
    await setup.investing.offer(founder, request, "retry-key-1");
    const again = await setup.investing.offer(founder, request, "retry-key-1");
    expect(again.ok && again.value.investmentOffers).toHaveLength(1);
  });

  it("shows the offer to the investor with the company's implied valuation, and only the founder sees offers out", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 0);
    await offerTo(setup, founder, "sam", 50_000, 1_000);
    const mine = MyCompanySchema.parse(await setup.companies.mine(sam));
    expect(mine.company).toBeNull();
    expect(mine.investmentOffers).toMatchObject([{ companyId, companyName: "Acme Ops", founder: "maya", amountCents: 50_000, equityBps: 1_000, valuationCents: 500_000 }]);
  });
});

describe("investing", () => {
  it("moves the money and the stake together when the investor's save pays", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const companyId = await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const fundsBefore = (await setup.store.companyById(companyId))?.fundsCents ?? 0;
    const offer = await offerTo(setup, founder, "sam", 50_000, 1_000);

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
    await investIn(setup, sam, (await offerTo(setup, founder, "sam", 50_000, 1_000)).id);
    await investIn(setup, ana, (await offerTo(setup, founder, "ana", 50_000, 2_000)).id);
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
    await foundedCompany(setup, founder);
    const poor = await investorWith(setup, "u2", "sam", 0);
    const offer = await offerTo(setup, founder, "sam", 50_000, 1_000);
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
    await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const offer = await offerTo(setup, founder, "sam", 50_000, 1_000);
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
    await foundedCompany(setup, founder);
    const sam = await investorWith(setup, "u2", "sam", 60_000);
    const cancelled = await offerTo(setup, founder, "sam", 50_000, 1_000);
    expect((await setup.investing.cancel(founder, cancelled.id)).ok).toBe(true);
    expect(await setup.investing.accept(sam, cancelled.id)).toEqual({ ok: false, problem: "offer_not_found" });

    const declined = await offerTo(setup, founder, "sam", 50_000, 1_000);
    expect(await setup.investing.decline(founder, declined.id)).toEqual({ ok: false, problem: "offer_not_found" });
    expect((await setup.investing.decline(sam, declined.id)).ok).toBe(true);

    const paying = await offerTo(setup, founder, "sam", 50_000, 1_000);
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
    await investIn(setup, sam, (await offerTo(setup, founder, "sam", 50_000, 1_000)).id);
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
