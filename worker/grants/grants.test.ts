import { describe, expect, it } from "vitest";
import { isPlausibleProgress, NO_PROMISED_MONEY } from "../../src/domain/audit.ts";
import { payRef } from "../../src/domain/economy.ts";
import { emptyProgress, type Progress } from "../../src/domain/progress.ts";
import { earnGrant } from "../../src/domain/purchases.ts";
import { GrantResponseSchema } from "../../src/storage/admin-protocol.ts";
import { AccountService } from "../api/accounts.ts";
import type { AccountStore, LedgerRow, RankedAccount, SaveMoves, SavedProgress, Standing, User } from "../api/store.ts";
import { handleAdmin } from "../admin/routes.ts";
import type { AdminService } from "../admin/service.ts";
import { MemoryGrantStore } from "./memory-store.ts";
import { GrantDesk } from "./service.ts";

const NOW = Date.UTC(2026, 9, 10, 18);
const admin: User = { id: "admin-1", username: "aashish", passwordHash: "", createdAt: NOW, tags: ["admin"] };
const player: User = { id: "player-1", username: "maya", passwordHash: "", createdAt: NOW, tags: [] };
const users = new Map([admin, player].map((user) => [user.username, user]));

/** Just enough of an account store to run saves through AccountService, claiming grants like D1 does. */
class MemoryAccounts implements AccountStore {
  readonly saved = new Map<string, SavedProgress>();
  private readonly grants: MemoryGrantStore;
  constructor(grants: MemoryGrantStore) {
    this.grants = grants;
  }
  async findUser(username: string) {
    return users.get(username) ?? null;
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
    if (moves) this.grants.applyClaims(userId, moves.grantIds, progress.updatedAt);
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

function setup() {
  let ids = 0;
  const store = new MemoryGrantStore((userId) => [...users.values()].find((user) => user.id === userId)?.username ?? "");
  const desk = new GrantDesk({ store, findUser: async (username) => users.get(username) ?? null, now: () => NOW, newId: () => `grant-${(ids += 1)}`, isOverLimit: async () => false });
  const accounts = new AccountService(new MemoryAccounts(store), () => NOW + 60_000, { grants: store });
  return { store, desk, accounts };
}

const claimed = (progress: Progress, grant: { id: string; amountCents: number; note: string }): Progress => ({ ...progress, wallet: earnGrant(progress.wallet, grant, NOW) });

describe("granting money", () => {
  it("gives the player a pending grant, once per idempotency key", async () => {
    const { desk, store } = setup();
    const first = await desk.grant(admin, { username: "maya", amountCents: 500_000, note: "seed for testing" }, "retry-key-123");
    const retry = await desk.grant(admin, { username: "maya", amountCents: 500_000, note: "seed for testing" }, "retry-key-123");
    expect(first).toMatchObject({ ok: true, isNew: true });
    expect(retry).toMatchObject({ ok: true, isNew: false });
    expect(first.ok && retry.ok && retry.grant.id === first.grant.id).toBe(true);
    expect(await store.pendingFor(player.id)).toHaveLength(1);
    // Without a key, each request is its own grant.
    await desk.grant(admin, { username: "maya", amountCents: 100, note: "" }, null);
    await desk.grant(admin, { username: "maya", amountCents: 100, note: "" }, null);
    expect(await store.pendingFor(player.id)).toHaveLength(3);
  });

  it("refuses unknown players and lists history newest first", async () => {
    const { desk } = setup();
    expect(await desk.grant(admin, { username: "nobody", amountCents: 100, note: "" }, null)).toEqual({ ok: false, problem: "unknown_user" });
    expect(await desk.history("nobody")).toBeNull();
    await desk.grant(admin, { username: "maya", amountCents: 100, note: "a" }, null);
    expect((await desk.history("maya"))?.[0]).toMatchObject({ username: "maya", grantedBy: "aashish", claimedAt: null });
  });
});

describe("claiming a grant in a save", () => {
  it("accepts the exact grant once, marks it claimed, and refuses forged, wrong-sized or replayed claims", async () => {
    const { desk, accounts, store } = setup();
    const outcome = await desk.grant(admin, { username: "maya", amountCents: 250_000, note: "testing" }, null);
    if (!outcome.ok) throw new Error("grant failed");
    const grant = { id: outcome.grant.id, amountCents: 250_000, note: "testing" };

    expect((await accounts.saveProgress(player, claimed(emptyProgress(), { ...grant, amountCents: 999_999 }))).ok).toBe(false);
    expect((await accounts.saveProgress(player, claimed(emptyProgress(), { ...grant, id: "made-up" }))).ok).toBe(false);

    const withGrant = claimed(emptyProgress(), grant);
    expect((await accounts.saveProgress(player, withGrant)).ok).toBe(true);
    expect(withGrant.wallet.earnedCents.grant).toBe(250_000);
    expect(await store.pendingFor(player.id)).toHaveLength(0);
    expect(await accounts.pendingGrants(player)).toEqual([]);

    // The same money claimed again under a fresh line is refused: the grant is no longer pending.
    const replay = { ...withGrant, wallet: earnGrant({ ...withGrant.wallet, ledger: [] }, grant, NOW) };
    expect((await accounts.saveProgress(player, replay)).ok).toBe(false);
  });

  it("is refused by the audit when the server promised nothing", () => {
    const forged = claimed(emptyProgress(), { id: "x", amountCents: 100, note: "" });
    expect(isPlausibleProgress(emptyProgress(), forged, 60, undefined, NO_PROMISED_MONEY)).toBe(false);
    expect(isPlausibleProgress(emptyProgress(), forged, 60, undefined, { ...NO_PROMISED_MONEY, grants: new Map([[payRef.grant("x"), 100]]) })).toBe(true);
  });
});

describe("grant routes", () => {
  const unused = {} as AdminService;
  const post = (body: unknown, key?: string) =>
    new Request("https://sev1.test/api/admin/grants", {
      method: "POST",
      headers: { cookie: "sev1_session=t", origin: "https://sev1.test", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });

  it("lets admins grant (201, then 200 for a retried key) and refuses everyone else", async () => {
    const { desk } = setup();
    const asAdmin = { userFor: async () => admin };
    const created = await handleAdmin(post({ username: "maya", amountCents: 1_000 }, "key-abcdef12"), asAdmin, unused, desk);
    expect(created.status).toBe(201);
    expect(GrantResponseSchema.safeParse(await created.json()).success).toBe(true);
    expect((await handleAdmin(post({ username: "maya", amountCents: 1_000 }, "key-abcdef12"), asAdmin, unused, desk)).status).toBe(200);
    expect((await handleAdmin(post({ username: "ghost", amountCents: 1_000 }), asAdmin, unused, desk)).status).toBe(404);
    expect((await handleAdmin(post({ username: "maya", amountCents: 1_000 }), { userFor: async () => player }, unused, desk)).status).toBe(403);
  });
});
