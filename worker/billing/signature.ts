/**
 * Stripe webhook signatures: `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]`, where each v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`) in hex. Only v1 counts (v0 is a test decoy; anything else is a downgrade).
 */

/** Stripe's own libraries accept this much clock skew or replay delay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The v1 signature Stripe would send for this body at this time. */
export function signPayload(secret: string, timestampSeconds: number, rawBody: string): Promise<string> {
  return hmacHex(secret, `${timestampSeconds}.${rawBody}`);
}

function isSameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function parseHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator < 0) continue;
    const scheme = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (scheme === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (scheme === "v1") signatures.push(value);
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

/** True only for a body Stripe signed with `secret`, delivered within the tolerance of `nowSeconds`. */
export async function isAuthenticStripeEvent(rawBody: string, header: string | null, secret: string, nowSeconds: number): Promise<boolean> {
  if (!header) return false;
  const parsed = parseHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = await signPayload(secret, parsed.timestamp, rawBody);
  // Every candidate is compared in full, so timing doesn't reveal which one (if any) matched.
  return parsed.signatures.reduce((matched, candidate) => isSameText(candidate, expected) || matched, false);
}
