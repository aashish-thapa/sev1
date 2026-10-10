/** What the account service needs from storage; D1 in production, memory in tests. */

export type User = { readonly id: string; readonly username: string; readonly passwordHash: string; readonly createdAt: number };
export type SavedProgress = { readonly body: string; readonly updatedAt: number };
/** One credit in the server's books. `sourceRef` identifies what earned it, so the same credit is never booked twice. */
export type LedgerRow = { readonly id: string; readonly amountCents: number; readonly reason: string; readonly sourceRef: string; readonly createdAt: number };

export interface AccountStore {
  findUser(username: string): Promise<User | null>;
  /** False when the username is taken. */
  createUser(user: User): Promise<boolean>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  /** The signed-in user, or null for an unknown or expired session. */
  findSessionUser(tokenHash: string, now: number): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  loadProgress(userId: string): Promise<SavedProgress | null>;
  /** Stores the progress and books its new credits together; credits already booked are skipped. */
  saveProgress(userId: string, progress: SavedProgress, credits: readonly LedgerRow[]): Promise<void>;
  /** The account's balance by the server's books. */
  ledgerBalance(userId: string): Promise<number>;
  /** Counts one attempt against `key` in the window starting at `windowStart`; returns the count so far. */
  countAttempt(key: string, windowStart: number): Promise<number>;
}
