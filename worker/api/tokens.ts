import { newSecret } from "../../server/secrets.ts";

const TOKEN_BYTES = 32;

/** The cookie carries the token; the database only ever sees its hash, so a leaked table can't sign anyone in. */
export function newSessionToken(): string {
  return newSecret(TOKEN_BYTES);
}

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
