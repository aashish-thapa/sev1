import type { PendingGrant } from "../api/store.ts";
import type { GrantRow, GrantStore, NewGrant } from "./store.ts";

/** In-memory grants for tests; `applyClaims` does what grantClaimStatements does in D1. */
export class MemoryGrantStore implements GrantStore {
  readonly grants = new Map<string, GrantRow & { idempotencyKey: string | null }>();
  private readonly usernameOf: (userId: string) => string;

  constructor(usernameOf: (userId: string) => string) {
    this.usernameOf = usernameOf;
  }

  async create(grant: NewGrant): Promise<{ grant: GrantRow; isNew: boolean }> {
    const existing = grant.idempotencyKey === null ? undefined : [...this.grants.values()].find((stored) => stored.grantedBy === grant.grantedBy && stored.idempotencyKey === grant.idempotencyKey);
    if (existing) return { grant: existing, isNew: false };
    const stored = { ...grant, username: this.usernameOf(grant.userId), claimedAt: null };
    this.grants.set(grant.id, stored);
    return { grant: stored, isNew: true };
  }

  async pendingFor(userId: string): Promise<PendingGrant[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.userId === userId && grant.claimedAt === null)
      .map((grant) => ({ id: grant.id, amountCents: grant.amountCents, note: grant.note, grantedAt: grant.grantedAt }));
  }

  async historyFor(userId: string, limit: number): Promise<GrantRow[]> {
    return [...this.grants.values()].filter((grant) => grant.userId === userId).sort((a, b) => b.grantedAt - a.grantedAt).slice(0, limit);
  }

  applyClaims(userId: string, grantIds: readonly string[], at: number): void {
    for (const id of grantIds) {
      const grant = this.grants.get(id);
      if (grant && grant.userId === userId && grant.claimedAt === null) this.grants.set(id, { ...grant, claimedAt: at });
    }
  }
}
