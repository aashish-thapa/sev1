import { ROOM_CODE_QUERY, RoomCodeSchema } from "../src/multiplayer/protocol.ts";
import { generateRoomCode } from "../server/room-code.ts";
import type { Env } from "./env.ts";

/** Each claim is one subrequest; collisions are rare, so a few tries are plenty within the per-request cap. */
const CLAIM_ATTEMPTS = 8;

/** Sends a room socket to the object holding that room, or reserves a fresh code for a socket that's opening one. */
export async function routeRoomSocket(request: Request, env: Env, random: () => number): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426, headers: { upgrade: "websocket" } });
  if (!isAllowedOrigin(request, env)) return new Response("Origin not allowed", { status: 403 });

  const url = new URL(request.url);
  const requested = url.searchParams.get(ROOM_CODE_QUERY);
  if (requested !== null) {
    const code = RoomCodeSchema.safeParse(requested);
    if (!code.success) return new Response("Not a room code", { status: 400 });
    return forward(request, env, code.data);
  }

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode(random, () => false);
    if (code && (await env.ROOMS.getByName(code).claim(code))) return forward(request, env, code);
  }
  return new Response("No free room code right now", { status: 503 });
}

function forward(request: Request, env: Env, code: string): Promise<Response> {
  const url = new URL(request.url);
  url.searchParams.set(ROOM_CODE_QUERY, code);
  return env.ROOMS.getByName(code).fetch(new Request(url, request));
}

/** Browsers always send Origin on a WebSocket handshake; anything else is another site borrowing our rooms. */
function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = env.ALLOWED_ORIGINS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [new URL(request.url).origin];
  return allowed.includes(origin);
}
