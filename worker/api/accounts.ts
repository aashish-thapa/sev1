import { z } from "zod";
import { featuredBadge } from "../../src/domain/achievements.ts";
import { isPlausibleProgress, NO_PROMISED_MONEY, type PromisedMoney, type TierOf } from "../../src/domain/audit.ts";
import { careerLevel } from "../../src/domain/career.ts";
import { payRef } from "../../src/domain/economy.ts";
import { shownTags } from "../../src/domain/tags.ts";
import { emptyProgress, ProgressSchema, type Progress } from "../../src/domain/progress.ts";
import type { Account, SyncedProgress } from "../../src/storage/account-protocol.ts";
import { LEADERBOARD_SIZE, type Leaderboard } from "../../src/storage/leaderboard-protocol.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import type { AccountStore, CompanyBank, GrantBank, InvestorBank, LedgerRow, PendingGrant, SaveMoves, Standing, User } from "./store.ts";
import { hashToken, newSessionToken } from "./tokens.ts";

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
/** Per username and per address, per window: enough for typos, too few to guess a password. */
const LOGIN_ATTEMPTS_PER_USER = 10;
const LOGIN_ATTEMPTS_PER_ADDRESS = 40;
const SIGNUPS_PER_ADDRESS = 5;
/** Anonymous play has no server clock; its ledger's first entry stands in, capped so a backdated ledger buys little. */
const MAX_ANONYMOUS_SECONDS = 30 * 24 * 60 * 60;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{3,24}$/, "3–24 letters, numbers, - or _");
export const PasswordSchema = z.string().min(8, "at least 8 characters").max(128, "at most 128 characters");
export const CredentialsSchema = z.object({ username: UsernameSchema, password: PasswordSchema });

export type SignedIn = { readonly account: Account; readonly token: string; readonly progress: SyncedProgress | null };

export type AuthFailure = "username_taken" | "bad_credentials" | "rate_limited";
export type AuthResult = { readonly ok: true; readonly value: SignedIn } | { readonly ok: false; readonly failure: AuthFailure };
export type SaveResult = { readonly ok: true; readonly updatedAt: number } | { readonly ok: false; readonly current: SyncedProgress | null };

type Clock = () => number;

/** Seeds, payroll and grant claims new in this save, for the server's books to settle alongside it. */
function saveMovesOf(previous: Progress, next: Progress): SaveMoves {
  const fresh = next.wallet.ledger.filter((entry) => entry.seq >= previous.wallet.nextSeq);
  return {
    fundingRefs: fresh.filter((entry) => entry.reason === "company").map((entry) => entry.ref),
    payoutIds: fresh.filter((entry) => entry.reason === "payroll").map((entry) => entry.ref.slice(PAYROLL_REF_PREFIX.length)),
    grantIds: fresh.filter((entry) => entry.reason === "grant").map((entry) => entry.ref.slice(GRANT_REF_PREFIX.length)),
    investRefs: fresh.filter((entry) => entry.reason === "invest").map((entry) => entry.ref),
    dividendIds: fresh.filter((entry) => entry.reason === "dividend").map((entry) => entry.ref.slice(DIVIDEND_REF_PREFIX.length)),
  };
}

const PAYROLL_REF_PREFIX = payRef.payroll("");
const GRANT_REF_PREFIX = payRef.grant("");
const DIVIDEND_REF_PREFIX = payRef.dividend("");

/** What the client may know about an account. */
export function accountOf(user: User): Account {
  return { username: user.username, tags: [...user.tags] };
}

/** What the leaderboard publishes for a save: only a badge the player has actually earned is shown. */
function standingOf(progress: Progress): Standing {
  const career = careerLevel(progress);
  return { experience: career.experience, title: career.title, featuredBadge: featuredBadge(progress)?.id ?? null };
}

/** Sign-up, sign-in and saved progress; storage and HTTP live elsewhere. */
export class AccountService {
  private readonly store: AccountStore;
  private readonly now: Clock;
  /** Prices solutions bought in a synced save; without it, purchases are refused. */
  private readonly tierOf: TierOf | undefined;
  /** What companies are waiting for from or owe each player; without it, company money in a save is refused. */
  private readonly bank: CompanyBank | undefined;
  /** Admin grants issued to each player; without it, grant money in a save is refused. */
  private readonly grants: GrantBank | undefined;
  /** Investments each player agreed to and dividends booked for them; without it, both are refused. */
  private readonly investors: InvestorBank | undefined;

  constructor(store: AccountStore, now: Clock, tierOf?: TierOf, bank?: CompanyBank, grants?: GrantBank, investors?: InvestorBank) {
    this.store = store;
    this.now = now;
    this.tierOf = tierOf;
    this.bank = bank;
    this.grants = grants;
    this.investors = investors;
  }

  /** Creates the account and, when it's plausible, keeps the progress earned before signing up. */
  async signUp(username: string, password: string, anonymous: Progress | null, address: string): Promise<AuthResult> {
    if (await this.isOverLimit(`signup:${address}`, SIGNUPS_PER_ADDRESS)) return { ok: false, failure: "rate_limited" };
    const user: User = { id: crypto.randomUUID(), username, passwordHash: await hashPassword(password), createdAt: this.now(), tags: [] };
    if (!(await this.store.createUser(user))) return { ok: false, failure: "username_taken" };

    let progress: SyncedProgress | null = null;
    if (anonymous && isPlausibleProgress(emptyProgress(), anonymous, this.anonymousSeconds(anonymous), this.tierOf)) {
      progress = { progress: anonymous, updatedAt: this.now() };
      await this.store.saveProgress(user.id, { body: JSON.stringify(anonymous), updatedAt: progress.updatedAt }, standingOf(anonymous), this.creditsSince(emptyProgress(), anonymous));
    }
    return { ok: true, value: { account: accountOf(user), token: await this.startSession(user), progress } };
  }

  async signIn(username: string, password: string, address: string): Promise<AuthResult> {
    // Both limits count every attempt, so neither one username nor one address can grind through guesses.
    const isUserLimited = await this.isOverLimit(`login:${username}`, LOGIN_ATTEMPTS_PER_USER);
    const isAddressLimited = await this.isOverLimit(`login-ip:${address}`, LOGIN_ATTEMPTS_PER_ADDRESS);
    if (isUserLimited || isAddressLimited) return { ok: false, failure: "rate_limited" };
    const user = await this.store.findUser(username);
    if (!user) {
      // Unknown users still pay for a hash, so response time doesn't reveal which usernames exist.
      await hashPassword(password);
      return { ok: false, failure: "bad_credentials" };
    }
    if (!(await verifyPassword(password, user.passwordHash))) return { ok: false, failure: "bad_credentials" };
    return { ok: true, value: { account: accountOf(user), token: await this.startSession(user), progress: await this.progressOf(user) } };
  }

  async signOut(token: string): Promise<void> {
    await this.store.deleteSession(await hashToken(token));
  }

  async userFor(token: string | null): Promise<User | null> {
    if (!token) return null;
    return this.store.findSessionUser(await hashToken(token), this.now());
  }

  async progressOf(user: User): Promise<SyncedProgress | null> {
    const saved = await this.store.loadProgress(user.id);
    if (!saved) return null;
    const parsed = ProgressSchema.safeParse(JSON.parse(saved.body));
    return parsed.success ? { progress: parsed.data, updatedAt: saved.updatedAt } : null;
  }

  /** Accepts the save only if its wallet could have been earned since the last one; otherwise hands back what's stored. */
  async saveProgress(user: User, next: Progress): Promise<SaveResult> {
    const current = await this.progressOf(user);
    const since = current?.updatedAt ?? user.createdAt;
    const elapsedSeconds = Math.max(0, (this.now() - since) / 1000);
    const previous = current?.progress ?? emptyProgress();
    const promised = await this.promisedTo(user);
    if (!isPlausibleProgress(previous, next, elapsedSeconds, this.tierOf, promised)) return { ok: false, current };
    const updatedAt = this.now();
    await this.store.saveProgress(user.id, { body: JSON.stringify(next), updatedAt }, standingOf(next), this.creditsSince(previous, next), saveMovesOf(previous, next));
    return { ok: true, updatedAt };
  }

  /** Admin grants waiting for this player's game to claim them. */
  pendingGrants(user: User): Promise<readonly PendingGrant[]> {
    return this.grants ? this.grants.pendingFor(user.id) : Promise.resolve([]);
  }

  /** Everything the server has promised this player's wallet and not yet seen claimed. */
  private async promisedTo(user: User): Promise<PromisedMoney> {
    const [company, grants, investing] = await Promise.all([
      this.bank ? this.bank.claimsFor(user.id, this.now()) : NO_PROMISED_MONEY,
      this.pendingGrants(user),
      this.investors ? this.investors.claimsFor(user.id, this.now()) : NO_PROMISED_MONEY,
    ]);
    return {
      fundings: company.fundings,
      payouts: company.payouts,
      grants: new Map(grants.map((grant) => [payRef.grant(grant.id), grant.amountCents])),
      investments: investing.investments,
      dividends: investing.dividends,
    };
  }

  /** The account's balance by the server's books, which startup-mode spending will draw on. */
  balanceOf(user: User): Promise<number> {
    return this.store.ledgerBalance(user.id);
  }

  /**
   * Wallet entries new since `previous`, as rows for the books. A wallet numbers its entries with a
   * sequence it never reuses, so the sequence is a stable reference: a retried save books nothing twice.
   */
  /** The top accounts by experience, and where the caller stands if signed in with saved progress. */
  async leaderboard(user: User | null): Promise<Leaderboard> {
    const top = await this.store.topAccounts(LEADERBOARD_SIZE);
    // Public: only tags meant to be seen; permissions like admin never leave the server this way.
    const entries = top.map((account, index) => ({ rank: index + 1, ...account, tags: shownTags(account.tags) }));
    return { entries, me: user ? await this.store.rankOf(user.id) : null };
  }

  private creditsSince(previous: Progress, next: Progress): LedgerRow[] {
    return next.wallet.ledger
      .filter((entry) => entry.seq >= previous.wallet.nextSeq)
      .map((entry) => ({ id: crypto.randomUUID(), amountCents: entry.amountCents, reason: entry.reason, sourceRef: `wallet:${entry.seq}`, createdAt: this.now() }));
  }

  private async startSession(user: User): Promise<string> {
    const token = newSessionToken();
    await this.store.createSession(await hashToken(token), user.id, this.now() + SESSION_SECONDS * 1000);
    return token;
  }

  private async isOverLimit(key: string, limit: number): Promise<boolean> {
    const windowStart = Math.floor(this.now() / ATTEMPT_WINDOW_MS) * ATTEMPT_WINDOW_MS;
    return (await this.store.countAttempt(key, windowStart)) > limit;
  }

  private anonymousSeconds(progress: Progress): number {
    const first = Math.min(...progress.wallet.ledger.map((entry) => entry.at), this.now());
    return Math.min(MAX_ANONYMOUS_SECONDS, Math.max(0, (this.now() - first) / 1000));
  }
}
