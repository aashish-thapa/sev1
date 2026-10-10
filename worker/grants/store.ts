/** Admin grants: money an admin issues to a player, which the player's save then claims exactly once. */
import type { GrantBank } from "../api/store.ts";

export type GrantRow = {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly amountCents: number;
  readonly note: string;
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly claimedAt: number | null;
};

export type NewGrant = Omit<GrantRow, "username" | "claimedAt"> & {
  /** From the admin's request; the same key from the same admin never grants twice. Null: no deduplication. */
  readonly idempotencyKey: string | null;
};

export interface GrantStore extends GrantBank {
  /** Stores the grant unless this admin already used the key; returns the stored grant and whether it's new. */
  create(grant: NewGrant): Promise<{ grant: GrantRow; isNew: boolean }>;
  /** A player's grants, newest first. */
  historyFor(userId: string, limit: number): Promise<GrantRow[]>;
}
