/** What the account service needs from storage; D1 in production, memory in tests. */
import type { PromisedMoney } from "../../src/domain/audit.ts";
import type { Title } from "../../src/domain/career.ts";

/** `tags` are granted marks (e.g. "creator"), written only by operators on the server. */
export type User = { readonly id: string; readonly username: string; readonly passwordHash: string; readonly createdAt: number; readonly tags: readonly string[] };
export type SavedProgress = { readonly body: string; readonly updatedAt: number };
/** What the leaderboard shows for an account, derived from its progress at save time. */
export type Standing = { readonly experience: number; readonly title: Title; readonly featuredBadge: string | null };
export type RankedAccount = Standing & { readonly username: string; readonly tags: readonly string[] };
/** One credit in the server's books. `sourceRef` identifies what earned it, so the same credit is never booked twice. */
export type LedgerRow = { readonly id: string; readonly amountCents: number; readonly reason: string; readonly sourceRef: string; readonly createdAt: number };

/**
 * Server-side money a save just moved, booked in the same batch as the save: seeds that fund a waiting
 * company (by funding ref), payouts the player claimed (by payout id), admin grants claimed (by grant id),
 * investments paid for (by invest ref) and dividends claimed (by payout id).
 */
export type SaveMoves = {
  readonly fundingRefs: readonly string[];
  readonly payoutIds: readonly string[];
  readonly grantIds: readonly string[];
  readonly investRefs: readonly string[];
  readonly dividendIds: readonly string[];
};
export const NO_SAVE_MOVES: SaveMoves = { fundingRefs: [], payoutIds: [], grantIds: [], investRefs: [], dividendIds: [] };

/** The company share of what the server promised a player's wallet. */
export type CompanyPromises = Pick<PromisedMoney, "fundings" | "payouts">;

/** What companies are waiting for from, or owe to, a player's wallet; the save audit checks against it. */
export interface CompanyBank {
  claimsFor(userId: string, now: number): Promise<CompanyPromises>;
}

/** What investing has promised a player's wallet: accepted offers to pay for, and dividends to claim. */
export interface InvestorBank {
  claimsFor(userId: string, now: number): Promise<Pick<PromisedMoney, "investments" | "dividends">>;
}

/** Admin grants issued to a player and not yet claimed, by wallet ref → amount. */
export interface GrantBank {
  pendingFor(userId: string): Promise<readonly PendingGrant[]>;
}

export type PendingGrant = { readonly id: string; readonly amountCents: number; readonly note: string; readonly grantedAt: number };

export interface AccountStore {
  findUser(username: string): Promise<User | null>;
  /** False when the username is taken. */
  createUser(user: User): Promise<boolean>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  /** The signed-in user, or null for an unknown or expired session. */
  findSessionUser(tokenHash: string, now: number): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  loadProgress(userId: string): Promise<SavedProgress | null>;
  /** Stores the progress, its standing and its new credits together; credits already booked are skipped. */
  saveProgress(userId: string, progress: SavedProgress, standing: Standing, credits: readonly LedgerRow[], moves?: SaveMoves): Promise<void>;
  /** The top `limit` accounts by experience; earlier saves win ties. */
  topAccounts(limit: number): Promise<RankedAccount[]>;
  /** 1-based rank and experience of an account with saved progress, else null. */
  rankOf(userId: string): Promise<{ rank: number; experience: number } | null>;
  /** The account's balance by the server's books. */
  ledgerBalance(userId: string): Promise<number>;
  /** Counts one attempt against `key` in the window starting at `windowStart`; returns the count so far. */
  countAttempt(key: string, windowStart: number): Promise<number>;
}
