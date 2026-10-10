/** Web Crypto helpers the room core shares between Node and Workers. */

export function newSecret(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Touches every byte whatever the inputs, so timing reveals nothing about where they differ. */
export function isSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export function isSameSecret(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  return isSameBytes(encoder.encode(expected), encoder.encode(actual));
}
