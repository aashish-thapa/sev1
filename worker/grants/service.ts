/** Issuing admin grants: who gets the money is the admin's call; that only admins may call this is the router's. */
import type { Grant, GrantRequest } from "../../src/storage/admin-protocol.ts";
import type { User } from "../api/store.ts";
import type { GrantRow, GrantStore } from "./store.ts";

/** How many past grants a player's history shows. */
export const GRANT_HISTORY_LIMIT = 100;

export type GrantDeps = {
  readonly store: GrantStore;
  readonly findUser: (username: string) => Promise<User | null>;
  readonly now: () => number;
  readonly newId: () => string;
  /** Counts one write against `key` and says whether the caller is over the window's allowance. */
  readonly isOverLimit: (key: string) => Promise<boolean>;
};

export type GrantProblem = "unknown_user" | "rate_limited";
export type GrantOutcome = { readonly ok: true; readonly grant: Grant; readonly isNew: boolean } | { readonly ok: false; readonly problem: GrantProblem };

const toGrant = (row: GrantRow): Grant => ({
  id: row.id,
  username: row.username,
  amountCents: row.amountCents,
  note: row.note,
  grantedBy: row.grantedBy,
  grantedAt: row.grantedAt,
  claimedAt: row.claimedAt,
});

export class GrantDesk {
  private readonly deps: GrantDeps;

  constructor(deps: GrantDeps) {
    this.deps = deps;
  }

  /** `request` is already parsed (GrantRequestSchema); `idempotencyKey` makes a retried POST grant once. */
  async grant(admin: User, request: Required<GrantRequest>, idempotencyKey: string | null): Promise<GrantOutcome> {
    if (await this.deps.isOverLimit(`grant:${admin.id}`)) return { ok: false, problem: "rate_limited" };
    const player = await this.deps.findUser(request.username);
    if (!player) return { ok: false, problem: "unknown_user" };
    const stored = await this.deps.store.create({
      id: this.deps.newId(),
      userId: player.id,
      amountCents: request.amountCents,
      note: request.note,
      grantedBy: admin.username,
      grantedAt: this.deps.now(),
      idempotencyKey,
    });
    return { ok: true, grant: toGrant(stored.grant), isNew: stored.isNew };
  }

  /** A player's grants, newest first; null if there's no such player. */
  async history(username: string): Promise<Grant[] | null> {
    const player = await this.deps.findUser(username);
    if (!player) return null;
    return (await this.deps.store.historyFor(player.id, GRANT_HISTORY_LIMIT)).map(toGrant);
  }
}
