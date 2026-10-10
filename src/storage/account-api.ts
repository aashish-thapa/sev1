import type { z } from "zod";
import type { Progress } from "../domain/progress.ts";
import {
  AuthResponseSchema,
  ErrorResponseSchema,
  MeResponseSchema,
  NO_ENTITLEMENTS,
  RejectedSaveSchema,
  SaveResponseSchema,
  SyncedProgressSchema,
  type Account,
  type ApiError,
  type Entitlements,
  type PendingGrant,
  type SyncedProgress,
} from "./account-protocol.ts";

/** Why a call didn't succeed: an answer from the server, or no answer at all. */
export type AccountProblem = { readonly error: ApiError | "offline"; readonly message: string };
/** The signed-in account and its entitlements, as /api/me reports them. */
export type Me = { readonly account: Account; readonly entitlements: Entitlements; readonly pendingGrants: readonly PendingGrant[] };

export type Outcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: AccountProblem };
export type SignedIn = { readonly account: Account; readonly progress: SyncedProgress | null };
export type SaveOutcome = { readonly ok: true; readonly updatedAt: number } | { readonly ok: false; readonly current: SyncedProgress | null } | { readonly ok: false; readonly problem: AccountProblem };

/** The account server as the browser sees it. */
export interface AccountApi {
  /** Who's signed in and what they've paid for; null when signed out. */
  me(): Promise<Outcome<Me | null>>;
  signUp(username: string, password: string, progress: Progress): Promise<Outcome<SignedIn>>;
  signIn(username: string, password: string): Promise<Outcome<SignedIn>>;
  signOut(): Promise<Outcome<null>>;
  loadProgress(): Promise<Outcome<SyncedProgress | null>>;
  saveProgress(progress: Progress): Promise<SaveOutcome>;
}

const OFFLINE: AccountProblem = { error: "offline", message: "Can't reach the account server right now. You can keep playing; nothing is lost." };

/** Same-origin `/api`, so the session cookie rides along without any CORS. */
export class HttpAccountApi implements AccountApi {
  private readonly base: string;

  constructor(base = "/api") {
    this.base = base;
  }

  async me() {
    const result = await this.call("GET", "/me", MeResponseSchema);
    if (!result.ok) return result;
    const { account, entitlements, pendingGrants } = result.value;
    return { ok: true as const, value: account ? { account, entitlements: entitlements ?? NO_ENTITLEMENTS, pendingGrants } : null };
  }

  signUp(username: string, password: string, progress: Progress) {
    return this.call("POST", "/signup", AuthResponseSchema, { username, password, progress });
  }

  signIn(username: string, password: string) {
    return this.call("POST", "/login", AuthResponseSchema, { username, password });
  }

  async signOut() {
    const response = await this.send("POST", "/logout");
    if (!response) return { ok: false as const, problem: OFFLINE };
    return response.ok ? { ok: true as const, value: null } : { ok: false as const, problem: await problemOf(response) };
  }

  loadProgress() {
    return this.call("GET", "/progress", SyncedProgressSchema.nullable(), undefined, "progress");
  }

  async saveProgress(progress: Progress): Promise<SaveOutcome> {
    const response = await this.send("PUT", "/progress", { progress });
    if (!response) return { ok: false, problem: OFFLINE };
    const body: unknown = await response.json().catch(() => null);
    const saved = SaveResponseSchema.safeParse(body);
    if (response.ok && saved.success) return { ok: true, updatedAt: saved.data.updatedAt };
    const rejected = RejectedSaveSchema.safeParse(body);
    if (rejected.success) return { ok: false, current: rejected.data.current };
    return { ok: false, problem: parseProblem(body) };
  }

  /** Parses a JSON reply with `schema`; `field` picks one property of the body first. */
  private async call<Schema extends z.ZodType>(method: string, path: string, schema: Schema, body?: unknown, field?: string): Promise<Outcome<z.output<Schema>>> {
    const response = await this.send(method, path, body);
    if (!response) return { ok: false, problem: OFFLINE };
    if (!response.ok) return { ok: false, problem: await problemOf(response) };
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(field && isRecord(raw) ? raw[field] : raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: OFFLINE };
  }

  /** Null when the request never got an answer (offline, server down). */
  private async send(method: string, path: string, body?: unknown): Promise<Response | null> {
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }
}

async function problemOf(response: Response): Promise<AccountProblem> {
  return parseProblem(await response.json().catch(() => null));
}

function parseProblem(body: unknown): AccountProblem {
  const parsed = ErrorResponseSchema.safeParse(body);
  return parsed.success ? { error: parsed.data.error, message: parsed.data.message } : OFFLINE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
