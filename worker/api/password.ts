/**
 * Password hashing with PBKDF2-SHA256 from Web Crypto. 100,000 iterations is the most workerd
 * allows, and about 9 ms of CPU — inside the free plan's 10 ms per request, which tolerates
 * an occasional overrun from a login.
 */

import { isSameBytes } from "../../server/secrets.ts";

const ALGORITHM = "pbkdf2-sha256";
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return [ALGORITHM, iterations, toBase64(salt), toBase64(hash)].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationText);
  if (algorithm !== ALGORITHM || !Number.isInteger(iterations) || !saltText || !hashText) return false;
  const actual = await derive(password, fromBase64(saltText), iterations);
  return isSameBytes(actual, fromBase64(hashText));
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS));
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
