import { z } from "zod";
import type { ApiError } from "../../src/storage/account-protocol.ts";

/** Saved progress tops out well under this; anything bigger isn't ours. */
const MAX_BODY_BYTES = 256 * 1024;
export const SESSION_COOKIE = "sev1_session";

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function failure(error: ApiError, message: string, status: number, headers: HeadersInit = {}): Response {
  return json({ error, message }, status, headers);
}

/** The parsed body, or the 400 to send back. */
export async function readBody<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<{ ok: true; data: z.output<Schema> } | { ok: false; response: Response }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false, response: failure("invalid", "Request body is too large.", 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, response: failure("invalid", "Send a JSON body.", 400) };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: failure("invalid", parsed.error.issues[0]?.message ?? "Invalid request.", 400) };
}

export function sessionTokenOf(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

/** HttpOnly keeps scripts away from it; SameSite=Lax keeps other sites from riding it on writes. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Writes must come from our own pages; a missing Origin (curl, server-to-server) carries no ambient cookie risk. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

const IDEMPOTENCY_HEADER = "idempotency-key";
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** The client's key for a write it may retry; a missing or malformed key just means no deduplication. */
export function idempotencyKeyOf(request: Request): string | null {
  const key = IdempotencyKeySchema.safeParse(request.headers.get(IDEMPOTENCY_HEADER));
  return key.success ? key.data : null;
}
