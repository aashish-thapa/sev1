import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../src/multiplayer/protocol.ts";

/** 23⁴ ≈ 280k codes against a few hundred live rooms: collisions are rare, so a short retry budget suffices. */
const MAX_ATTEMPTS = 32;

/** A code not yet taken, or null when the retry budget runs out. */
export function generateRoomCode(random: () => number, isTaken: (code: string) => boolean): string | null {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]).join("");
    if (!isTaken(code)) return code;
  }
  return null;
}
