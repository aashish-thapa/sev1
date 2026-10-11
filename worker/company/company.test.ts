import { describe, expect, it } from "vitest";
import { isPlausibleProgress, NO_PROMISED_MONEY } from "../../src/domain/audit.ts";
import { FOUNDING_MINIMUM_CENTS } from "../../src/domain/company/rules.ts";
import { payRef } from "../../src/domain/economy.ts";
import { earn, emptyProgress, type Progress } from "../../src/domain/progress.ts";
import { earnPayroll, fundCompany } from "../../src/domain/purchases.ts";
import { MyCompanySchema } from "../../src/storage/company-protocol.ts";
import { AccountService } from "../api/accounts.ts";
import type { AccountStore, SaveMoves, LedgerRow, RankedAccount, SavedProgress, Standing, User } from "../api/store.ts";
import { MemoryCompanyStore } from "./memory-store.ts";
import { CompanyService, FUNDING_WINDOW_MS } from "./service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 10, 9);
const SEED = FOUNDING_MINIMUM_CENTS + 50_000;

/** A player with enough earned money to found a company: one perfect incident per $600. */
function richProgress(cents: number): Progress {
  let progress = emptyProgress();
  for (let index = 0; progress.wallet.balanceCents < cents; index += 1) {
    progress = earn(progress, { kind: "incident", ref: payRef.incident(`seed-run-${index}`, START + index), points: 100, tier: 1, title: "x", isTeam: false }, START);
  }
  return progress;
}

/** Just enough of an account store to run saves through AccountService, applying company moves like D1 does. */
class MemoryAccounts implements AccountStore {
  readonly saved = new Map<string, SavedProgress>();
  private readonly companies: MemoryCompanyStore;
  constructor(companies: MemoryCompanyStore) {
    this.companies = companies;
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
    if (moves) this.companies.applyMoves(userId, moves, progress.updatedAt);
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

function world(pantryOf?: (userId: string, day: string) => Promise<number>, discussedOn?: (userId: string, day: string) => Promise<boolean>) {
  let now = START;
  let ids = 0;
  const store = new MemoryCompanyStore();
  // Every seed run is a tier-1 War Room, so the audit can price its pay.
  const accounts = new AccountService(new MemoryAccounts(store), () => now, { bank: store, tierOf: () => 1 });
  const companies = new CompanyService({ store, now: () => now, newId: () => `id-${(ids += 1)}`, isOverLimit: async () => false, pantryOf, discussedOn });
  const user = (id: string, username: string): User => {
    store.addUser(id, username);
    return { id, username, passwordHash: "", createdAt: START - DAY_MS, tags: [] };
  };
  return { store, accounts, companies, user, advance: (ms: number) => (now += ms), now: () => now };
}

/** Founds and funds a company the way a client would: found, spend the seed, save. */
async function foundedCompany(setup: ReturnType<typeof world>, founder: User) {
  const before = richProgress(SEED);
  await setup.accounts.saveProgress(founder, before);
  const founded = await setup.companies.found(founder, { name: "Acme Ops", category: "ecommerce", role: "infrastructure", seedCents: SEED });
  if (!founded.ok) throw new Error(founded.problem);
  const spent = fundCompany(before.wallet, founded.value.fundingRef, SEED, setup.now());
  if (!spent.ok) throw new Error("couldn't spend the seed");
  setup.advance(30_000);
  const saved = await setup.accounts.saveProgress(founder, { ...before, wallet: spent.wallet });
  return { founded: founded.value, saved, progress: { ...before, wallet: spent.wallet } };
}

describe("founding", () => {
  it("activates the company when the seed spend lands in a save, crediting the seed and buying the first bay", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const { saved } = await foundedCompany(setup, founder);
    expect(saved.ok).toBe(true);
    const mine = MyCompanySchema.parse(await setup.companies.mine(founder));
    expect(mine.company?.state).toBe("active");
    expect(mine.company?.rooms).toEqual(["bay"]);
    // The starter server comes free, so day one can earn; only the bay is paid from the seed.
    expect(mine.company?.servers).toEqual(["small"]);
    expect(mine.company?.fundsCents).toBe(SEED - 80_000);
    expect(mine.company?.members).toMatchObject([{ username: "maya", isFounder: true }]);
  });

  it("refuses a seed below the founding minimum, and a second company for the same player", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    expect(await setup.companies.found(founder, { name: "Tiny", category: "saas", role: "frontend", seedCents: 100 })).toEqual({ ok: false, problem: "below_founding_minimum" });
    await foundedCompany(setup, founder);
    expect(await setup.companies.found(founder, { name: "Again", category: "saas", role: "frontend", seedCents: SEED })).toEqual({ ok: false, problem: "already_in_company" });
  });

  it("rejects a save whose seed is for an expired intent or the wrong amount, and drops the expired company", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const before = richProgress(SEED * 2);
    await setup.accounts.saveProgress(founder, before);
    const founded = await setup.companies.found(founder, { name: "Late", category: "fintech", role: "security", seedCents: SEED });
    if (!founded.ok) throw new Error(founded.problem);
    const wrongAmount = fundCompany(before.wallet, founded.value.fundingRef, SEED - 1, setup.now());
    if (!wrongAmount.ok) throw new Error("spend failed");
    expect((await setup.accounts.saveProgress(founder, { ...before, wallet: wrongAmount.wallet })).ok).toBe(false);

    setup.advance(FUNDING_WINDOW_MS + 1);
    const late = fundCompany(before.wallet, founded.value.fundingRef, SEED, setup.now());
    if (!late.ok) throw new Error("spend failed");
    expect((await setup.accounts.saveProgress(founder, { ...before, wallet: late.wallet })).ok).toBe(false);
    expect((await setup.companies.mine(founder)).company).toBeNull();
  });
});

describe("staff", () => {
  it("lets only the founder invite, at or above the role minimum, and the invitee accept or decline", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const sam = setup.user("u2", "sam");
    const lena = setup.user("u3", "lena");
    await foundedCompany(setup, founder);

    expect((await setup.companies.invite(founder, { username: "sam", role: "frontend", payCents: 1 })).ok).toBe(false);
    expect(await setup.companies.invite(founder, { username: "nobody", role: "frontend", payCents: 20_000 })).toEqual({ ok: false, problem: "unknown_user" });
    expect((await setup.companies.invite(founder, { username: "sam", role: "frontend", payCents: 20_000 })).ok).toBe(true);
    expect(await setup.companies.invite(founder, { username: "sam", role: "frontend", payCents: 20_000 })).toEqual({ ok: false, problem: "already_invited" });
    expect((await setup.companies.invite(founder, { username: "lena", role: "security", payCents: 20_000 })).ok).toBe(true);

    const [offer] = (await setup.companies.mine(sam)).invitations;
    expect(offer).toMatchObject({ companyName: "Acme Ops", from: "maya", role: "frontend", payCents: 20_000 });
    expect((await setup.companies.accept(sam, offer.id)).ok).toBe(true);
    expect(await setup.companies.invite(sam, { username: "lena", role: "data", payCents: 20_000 })).toEqual({ ok: false, problem: "not_founder" });
    // Sam works here now: a new offer to him means nothing until he leaves.
    expect(await setup.companies.invite(founder, { username: "sam", role: "data", payCents: 20_000 })).toEqual({ ok: false, problem: "already_in_company" });

    const [lenaOffer] = (await setup.companies.mine(lena)).invitations;
    expect((await setup.companies.decline(lena, lenaOffer.id)).ok).toBe(true);
    expect((await setup.companies.mine(lena)).company).toBeNull();
    expect(await setup.companies.accept(lena, lenaOffer.id)).toEqual({ ok: false, problem: "invitation_not_found" });
  });
});

describe("work days and payroll", () => {
  it("settles once per real day, and pays each member through a payout their save claims exactly once", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const { progress } = await foundedCompany(setup, founder);

    const settled = await setup.companies.settle(founder);
    expect(settled.ok).toBe(true);
    expect(await setup.companies.settle(founder)).toEqual({ ok: false, problem: "already_settled_today" });

    const [payout] = (await setup.companies.mine(founder)).payouts;
    expect(payout.amountCents).toBeGreaterThan(0);
    setup.advance(30_000);
    const paid = { ...progress, wallet: earnPayroll(progress.wallet, payout, setup.now()) };
    expect((await setup.accounts.saveProgress(founder, paid)).ok).toBe(true);
    expect((await setup.companies.mine(founder)).payouts).toEqual([]);

    // The same payout claimed again under a fresh wallet line is refused: it's no longer owed.
    setup.advance(30_000);
    const twice = { ...paid, wallet: earnPayroll({ ...paid.wallet, ledger: paid.wallet.ledger.slice(0, -1) }, payout, setup.now()) };
    expect((await setup.accounts.saveProgress(founder, twice)).ok).toBe(false);

    setup.advance(DAY_MS);
    expect((await setup.companies.settle(founder)).ok).toBe(true);
  });

  it("lets only the founder close the day", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    const sam = setup.user("u2", "sam");
    await foundedCompany(setup, founder);
    expect((await setup.companies.invite(founder, { username: "sam", role: "frontend", payCents: 20_000 })).ok).toBe(true);
    const [offer] = (await setup.companies.mine(sam)).invitations;
    expect((await setup.companies.accept(sam, offer.id)).ok).toBe(true);

    expect(await setup.companies.settle(sam)).toEqual({ ok: false, problem: "not_founder" });
    expect((await setup.companies.settle(founder)).ok).toBe(true);
  });

  it("charges the company for what its members took from the pantry that day", async () => {
    const asked: string[] = [];
    const setup = world(async (userId, day) => (asked.push(`${userId}:${day}`), 235));
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    const settled = await setup.companies.settle(founder);
    if (!settled.ok) throw new Error("settle failed");
    expect(settled.value.lines.filter((line) => line.reason === "pantry").map((line) => line.amountCents)).toEqual([-235]);
    expect(asked).toEqual([`u1:${new Date(setup.now()).toISOString().slice(0, 10)}`]);
  });

  it("pays half to a member who answered no discussion card that day", async () => {
    const full = world();
    const skipped = world(undefined, async () => false);
    const [fullDay, skippedDay] = await Promise.all(
      [full, skipped].map(async (setup) => {
        const founder = setup.user("u1", "maya");
        await foundedCompany(setup, founder);
        return setup.companies.settle(founder);
      }),
    );
    if (!fullDay.ok || !skippedDay.ok) throw new Error("settle failed");
    const payroll = (day: typeof fullDay.value) => day.lines.find((line) => line.reason === "payroll")?.amountCents ?? 0;
    expect(payroll(skippedDay.value)).toBe(-Math.floor(-payroll(fullDay.value) / 2));
    expect(skippedDay.value.undiscussed).toEqual(["maya"]);
    expect(fullDay.value.undiscussed).toEqual([]);
  });

  it("refuses payroll the server never booked, or for the wrong amount", () => {
    const start = richProgress(1);
    const forged = { ...start, wallet: earnPayroll(start.wallet, { id: "made-up", amountCents: 50_000, workDay: 1 }, START) };
    expect(isPlausibleProgress(start, forged, 60, undefined, NO_PROMISED_MONEY)).toBe(false);
    const claims = { ...NO_PROMISED_MONEY, payouts: new Map([[payRef.payroll("made-up"), 40_000]]) };
    expect(isPlausibleProgress(start, forged, 60, undefined, claims)).toBe(false);
    expect(isPlausibleProgress(start, forged, 60, undefined, { ...claims, payouts: new Map([[payRef.payroll("made-up"), 50_000]]) })).toBe(true);
  });
});

describe("purchases", () => {
  it("lets the founder buy only what the funds cover, and a retried request with the same key buys once", async () => {
    const setup = world();
    const founder = setup.user("u1", "maya");
    await foundedCompany(setup, founder);
    expect(await setup.companies.buyServer(founder, "small", "key-00000001")).toEqual({ ok: false, problem: "no_free_rack" });
    const room = await setup.companies.buyRoom(founder, "server-room", "key-00000002");
    expect(room.ok).toBe(false);
    if (!room.ok) expect(room.problem).toBe("not_enough_funds");
    const bay = await setup.companies.buyRoom(founder, "bay", "key-00000003");
    const again = await setup.companies.buyRoom(founder, "bay", "key-00000003");
    expect(bay.ok).toBe(true);
    expect(again.ok).toBe(true);
    const mine = await setup.companies.mine(founder);
    expect(mine.company?.rooms).toEqual(["bay", "bay"]);
  });
});
