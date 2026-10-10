import type { Progress } from "../domain/progress.ts";
import type { SyncedProgress } from "./account-protocol.ts";
import type { AccountApi } from "./account-api.ts";
import type { ProgressStore } from "./progress-store.ts";

/**
 * local: not signed in · saving: a push is pending or in flight · saved: the account matches ·
 * offline: the last push got no answer · rejected: the server refused this copy and had none of its own to offer.
 */
export type SyncStatus = "local" | "saving" | "saved" | "offline" | "rejected";

/** `revision` bumps whenever the account's copy replaces what's on this device. */
export type SyncSnapshot = { readonly status: SyncStatus; readonly revision: number };

/** What the app needs to follow and steer syncing, apart from loading and saving. */
export interface ProgressSync {
  readonly snapshot: SyncSnapshot;
  subscribe(listener: () => void): () => void;
  signedIn(account: SyncedProgress | null): Promise<void>;
  signedOut(): void;
}

/** When this device's progress last changed (or last matched the account), in epoch ms; 0 when never. */
export interface ChangeClock {
  read(): number;
  write(at: number): void;
}

type Timers = { readonly set: (run: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };

export type SyncOptions = {
  readonly debounceMs?: number;
  readonly now?: () => number;
  readonly timers?: Timers;
};

/** Saves batch up: one push per burst of answers, not one per click. */
const DEFAULT_DEBOUNCE_MS = 4_000;

/**
 * Progress lives on the device first, so play never waits on the network. While signed in, changes
 * are pushed to the account after a short pause. When the two copies disagree the account wins,
 * unless this device changed more recently, in which case the server judges the device's copy.
 */
export class SyncingProgressStore implements ProgressStore, ProgressSync {
  private readonly local: ProgressStore;
  private readonly changedAt: ChangeClock;
  private readonly api: AccountApi;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly listeners = new Set<() => void>();
  private isSignedIn = false;
  private pending: unknown = null;
  private snapshotHeld: SyncSnapshot = { status: "local", revision: 0 };

  constructor(local: ProgressStore, changedAt: ChangeClock, api: AccountApi, options: SyncOptions = {}) {
    this.local = local;
    this.changedAt = changedAt;
    this.api = api;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  load(): Progress {
    return this.local.load();
  }

  save(progress: Progress): void {
    this.local.save(progress);
    this.changedAt.write(this.now());
    if (!this.isSignedIn) return;
    this.setStatus("saving");
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = this.timers.set(() => {
      this.pending = null;
      // push() settles every failure into the sync status, so nothing is left to await here.
      void this.push();
    }, this.debounceMs);
  }

  /** Called once signed in, with whatever the account already holds. */
  async signedIn(account: SyncedProgress | null): Promise<void> {
    this.isSignedIn = true;
    if (account && account.updatedAt >= this.changedAt.read()) {
      this.replace(account);
      this.setStatus("saved");
      return;
    }
    await this.push();
  }

  signedOut(): void {
    this.isSignedIn = false;
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = null;
    this.setStatus("local");
  }

  get snapshot(): SyncSnapshot {
    return this.snapshotHeld;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async push(): Promise<void> {
    this.setStatus("saving");
    const outcome = await this.api.saveProgress(this.local.load());
    if (!this.isSignedIn) return;
    if (outcome.ok) {
      this.changedAt.write(outcome.updatedAt);
      this.setStatus("saved");
    } else if ("current" in outcome) {
      // The server couldn't square this copy with the account's history; the account's copy stands.
      // With no copy of its own, nothing was saved: keep this device's progress and say so rather than claim "saved".
      if (outcome.current) {
        this.replace(outcome.current);
        this.setStatus("saved");
      } else {
        this.setStatus("rejected");
      }
    } else {
      this.setStatus("offline");
    }
  }

  private replace(account: SyncedProgress) {
    this.local.save(account.progress);
    this.changedAt.write(account.updatedAt);
    this.snapshotHeld = { ...this.snapshotHeld, revision: this.snapshotHeld.revision + 1 };
    this.notify();
  }

  private setStatus(status: SyncStatus) {
    if (status === this.snapshotHeld.status) return;
    this.snapshotHeld = { ...this.snapshotHeld, status };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

const CHANGED_AT_KEY = "sev1.progress.changedAt";

/** Browser storage can be missing or throw; the clock then lives for this session only. */
export class BrowserChangeClock implements ChangeClock {
  private readonly storage: Storage | undefined;
  private fallback = 0;

  constructor(storage: Storage | undefined) {
    this.storage = storage;
  }

  read(): number {
    try {
      const stored = Number(this.storage?.getItem(CHANGED_AT_KEY) ?? Number.NaN);
      return Number.isFinite(stored) ? stored : this.fallback;
    } catch (error) {
      if (error instanceof DOMException) return this.fallback;
      throw error;
    }
  }

  write(at: number): void {
    this.fallback = at;
    try {
      this.storage?.setItem(CHANGED_AT_KEY, String(at));
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }
}
