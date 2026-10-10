import { describe, expect, it } from "vitest";
import { payRef } from "../../src/domain/economy.ts";
import { earn, emptyProgress, type Progress } from "../../src/domain/progress.ts";
import { AccountService } from "./accounts.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import type { AccountStore, LedgerRow, SavedProgress, User } from "./store.ts";

/** Fewer rounds keep the suite fast; the production count is exercised once below. */
const FAST_ITERATIONS = 1_000;

class MemoryAccountStore implements AccountStore {
  readonly users = new Map<string, User>();
  readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  readonly progress = new Map<string, SavedProgress>();
  readonly attempts = new Map<string, { windowStart: number; count: number }>();
  readonly ledger = new Map<string, LedgerRow & { userId: string }>();

  async findUser(username: string) {
    return this.users.get(username) ?? null;
  }
  async createUser(user: User) {
    if (this.users.has(user.username)) return false;
    this.users.set(user.username, user);
    return true;
  }
  async createSession(tokenHash: string, userId: string, expiresAt: number) {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }
  async findSessionUser(tokenHash: string, now: number) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= now) return null;
    return [...this.users.values()].find((user) => user.id === session.userId) ?? null;
  }
  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async loadProgress(userId: string) {
    return this.progress.get(userId) ?? null;
  }
  async saveProgress(userId: string, saved: SavedProgress, credits: readonly LedgerRow[]) {
    this.progress.set(userId, saved);
    for (const credit of credits) {
      const key = `${userId}:${credit.sourceRef}`;
      if (!this.ledger.has(key)) this.ledger.set(key, { ...credit, userId });
    }
  }
  async ledgerBalance(userId: string) {
    return [...this.ledger.values()].filter((row) => row.userId === userId).reduce((sum, row) => sum + row.amountCents, 0);
  }
  async countAttempt(key: string, windowStart: number) {
    const current = this.attempts.get(key);
    const count = current?.windowStart === windowStart ? current.count + 1 : 1;
    this.attempts.set(key, { windowStart, count });
    return count;
  }
}

function setup(start = Date.UTC(2026, 9, 10, 12)) {
  let now = start;
  const store = new MemoryAccountStore();
  const accounts = new AccountService(store, () => now);
  return { store, accounts, advance: (ms: number) => (now += ms), now: () => now };
}

const salary = (progress: Progress, minutes: number, at: number) => earn(progress, { kind: "salary", ref: payRef.salary(at), minutes, level: 0 }, at);

describe("passwords", () => {
  it("verifies the right password and rejects others, salting each hash", async () => {
    const first = await hashPassword("correct horse", FAST_ITERATIONS);
    const second = await hashPassword("correct horse", FAST_ITERATIONS);
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse", first)).toBe(true);
    expect(await verifyPassword("correct horsf", first)).toBe(false);
  });

  it("uses the production iteration count by default and rejects malformed hashes", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.split("$")[1]).toBe("100000");
    expect(await verifyPassword("correct horse", "plaintext")).toBe(false);
  });
});

describe("AccountService", () => {
  it("signs up, signs in by session, and signs out", async () => {
    const { accounts } = setup();
    const signedUp = await accounts.signUp("maya", "correct horse", null, "1.2.3.4");
    if (!signedUp.ok) throw new Error(signedUp.failure);
    expect((await accounts.userFor(signedUp.value.token))?.username).toBe("maya");
    await accounts.signOut(signedUp.value.token);
    expect(await accounts.userFor(signedUp.value.token)).toBeNull();
  });

  it("refuses a taken username and a wrong password", async () => {
    const { accounts } = setup();
    await accounts.signUp("maya", "correct horse", null, "1.2.3.4");
    expect(await accounts.signUp("maya", "other password", null, "5.6.7.8")).toEqual({ ok: false, failure: "username_taken" });
    expect(await accounts.signIn("maya", "wrong password", "1.2.3.4")).toEqual({ ok: false, failure: "bad_credentials" });
    expect(await accounts.signIn("nobody", "wrong password", "1.2.3.4")).toEqual({ ok: false, failure: "bad_credentials" });
  });

  it("expires sessions after thirty days", async () => {
    const { accounts, advance } = setup();
    const signedUp = await accounts.signUp("maya", "correct horse", null, "1.2.3.4");
    if (!signedUp.ok) throw new Error(signedUp.failure);
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await accounts.userFor(signedUp.value.token)).toBeNull();
  });

  it("rate-limits repeated failed logins for one username", async () => {
    const { accounts } = setup();
    await accounts.signUp("maya", "correct horse", null, "1.2.3.4");
    for (let attempt = 0; attempt < 10; attempt += 1) await accounts.signIn("maya", "wrong password", `10.0.0.${attempt}`);
    expect(await accounts.signIn("maya", "correct horse", "10.0.0.99")).toEqual({ ok: false, failure: "rate_limited" });
  });

  it("keeps plausible anonymous progress on sign-up", async () => {
    const { accounts, now } = setup();
    const earned = salary(emptyProgress(), 10, now() - 15 * 60_000);
    const signedUp = await accounts.signUp("maya", "correct horse", earned, "1.2.3.4");
    if (!signedUp.ok) throw new Error(signedUp.failure);
    expect(signedUp.value.progress?.progress.wallet.balanceCents).toBe(earned.wallet.balanceCents);
  });

  it("accepts honest saves and hands back the stored copy for forged ones", async () => {
    const { accounts, store, advance, now } = setup();
    await accounts.signUp("maya", "correct horse", null, "1.2.3.4");
    const user = (await store.findUser("maya"))!;
    advance(5 * 60_000);
    const honest = salary(emptyProgress(), 5, now());
    expect((await accounts.saveProgress(user, honest)).ok).toBe(true);

    advance(60_000);
    const forged = { ...honest, wallet: { ...honest.wallet, balanceCents: 99_999_999 } };
    const refused = await accounts.saveProgress(user, forged);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.current?.progress.wallet.balanceCents).toBe(honest.wallet.balanceCents);
    expect(await accounts.balanceOf(user)).toBe(honest.wallet.balanceCents);
  });

  it("books each wallet credit once, even when the same save is retried", async () => {
    const { accounts, store, advance, now } = setup();
    await accounts.signUp("maya", "correct horse", salary(emptyProgress(), 2, now() - 5 * 60_000), "1.2.3.4");
    const user = (await store.findUser("maya"))!;
    advance(5 * 60_000);
    const saved = (await accounts.progressOf(user))!.progress;
    const next = salary(saved, 3, now());
    await accounts.saveProgress(user, next);
    advance(1_000);
    await accounts.saveProgress(user, next);
    expect(store.ledger.size).toBe(2);
    expect(await accounts.balanceOf(user)).toBe(next.wallet.balanceCents);
  });
});
