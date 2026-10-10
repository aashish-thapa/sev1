import { describe, expect, it } from "vitest";
import { payRef } from "../domain/economy.ts";
import { earn, emptyProgress, type Progress } from "../domain/progress.ts";
import type { AccountApi, SaveOutcome } from "./account-api.ts";
import type { SyncedProgress } from "./account-protocol.ts";
import { MemoryProgressStore } from "./progress-store.ts";
import { SyncingProgressStore, type ChangeClock } from "./syncing-progress-store.ts";

const T0 = Date.UTC(2026, 9, 10, 12);
const paid = (minutes: number) => earn(emptyProgress(), { kind: "salary", ref: payRef.salary(T0), minutes, level: 0 }, T0);

class FakeApi implements AccountApi {
  saves: Progress[] = [];
  answer: (progress: Progress) => SaveOutcome = () => ({ ok: true, updatedAt: T0 + 99 });
  me = async () => ({ ok: true as const, value: null });
  signUp = async () => ({ ok: false as const, problem: { error: "offline" as const, message: "" } });
  signIn = this.signUp;
  signOut = async () => ({ ok: true as const, value: null });
  loadProgress = async () => ({ ok: true as const, value: null });
  async saveProgress(progress: Progress) {
    this.saves.push(progress);
    return this.answer(progress);
  }
}

function setup(changedAt = 0) {
  let clock = changedAt;
  const changed: ChangeClock = { read: () => clock, write: (at) => (clock = at) };
  const timers: (() => void)[] = [];
  const api = new FakeApi();
  const local = new MemoryProgressStore();
  const store = new SyncingProgressStore(local, changed, api, {
    now: () => T0,
    timers: { set: (run) => timers.push(run), clear: () => timers.splice(0) },
  });
  return { store, api, local, flush: async () => { for (const run of timers.splice(0)) run(); await Promise.resolve(); await Promise.resolve(); } };
}

describe("SyncingProgressStore", () => {
  it("only saves locally while signed out", async () => {
    const { store, api, flush } = setup();
    store.save(paid(1));
    await flush();
    expect(api.saves).toHaveLength(0);
    expect(store.snapshot.status).toBe("local");
  });

  it("adopts the account's copy when it is newer, bumping the revision", async () => {
    const { store, local } = setup(T0 - 10_000);
    const account: SyncedProgress = { progress: paid(3), updatedAt: T0 };
    await store.signedIn(account);
    expect(local.load().wallet.balanceCents).toBe(paid(3).wallet.balanceCents);
    expect(store.snapshot).toEqual({ status: "saved", revision: 1 });
  });

  it("pushes this device's copy when it changed after the account's", async () => {
    const { store, api, local } = setup(T0);
    local.save(paid(2));
    await store.signedIn({ progress: paid(1), updatedAt: T0 - 60_000 });
    expect(api.saves).toHaveLength(1);
    expect(store.snapshot.status).toBe("saved");
  });

  it("debounces saves while signed in into one push", async () => {
    const { store, api, flush } = setup();
    await store.signedIn(null);
    api.saves = [];
    store.save(paid(1));
    store.save(paid(2));
    expect(store.snapshot.status).toBe("saving");
    await flush();
    expect(api.saves).toHaveLength(1);
  });

  it("takes the account's copy when the server rejects a save", async () => {
    const { store, api, local } = setup(T0);
    const kept: SyncedProgress = { progress: paid(1), updatedAt: T0 - 1 };
    api.answer = () => ({ ok: false, current: kept });
    local.save(paid(500));
    await store.signedIn(kept);
    expect(local.load().wallet.balanceCents).toBe(kept.progress.wallet.balanceCents);
    expect(store.snapshot.revision).toBe(1);
  });

  it("reports offline when a push gets no answer", async () => {
    const { store, api } = setup(T0);
    api.answer = () => ({ ok: false, problem: { error: "offline", message: "" } });
    await store.signedIn(null);
    expect(store.snapshot.status).toBe("offline");
  });
});
