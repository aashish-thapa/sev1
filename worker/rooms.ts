import { ROOM_CODE_QUERY, RoomCodeSchema } from "../src/multiplayer/protocol.ts";
import { generateRoomCode } from "../server/room-code.ts";
import type { Env } from "./env.ts";
import type { OfficeAccess } from "./company/office.ts";

/** Each claim is one subrequest; collisions are rare, so a few tries are plenty within the per-request cap. */
const CLAIM_ATTEMPTS = 8;

/** Header the worker sets on a room socket it forwards; any copy a client sends is replaced. */
export const IDENTITY_TAGS_HEADER = "x-sev1-tags";

/** Set on a socket the worker forwards into a company office: the scenario to open it with if nobody's in yet. */
export const OFFICE_SCENARIO_HEADER = "x-sev1-office";

/** Looks up the granted tags of whoever opened the socket, from their session; [] for guests. */
export type Identify = (request: Request) => Promise<readonly string[]>;

/** Whether this socket may enter the room at `code`: offices are members only. */
export type OfficeGate = (request: Request, code: string) => Promise<OfficeAccess>;

/** Sends a room socket to the object holding that room, or reserves a fresh code for a socket that's opening one. */
export async function routeRoomSocket(request: Request, env: Env, random: () => number, identify: Identify, office: OfficeGate, officeScenarioId: string): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426, headers: { upgrade: "websocket" } });
  if (!isAllowedOrigin(request, env)) return new Response("Origin not allowed", { status: 403 });

  const tags = await identify(request);
  const url = new URL(request.url);
  const requested = url.searchParams.get(ROOM_CODE_QUERY);
  if (requested !== null) {
    const code = RoomCodeSchema.safeParse(requested);
    if (!code.success) return new Response("Not a room code", { status: 400 });
    const access = await office(request, code.data);
    if (access.kind === "denied") return new Response("This office is for the company's members", { status: 403 });
    return forward(request, env, code.data, tags, access.kind === "member" ? officeScenarioId : null);
  }

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode(random, () => false);
    if (code && (await env.ROOMS.getByName(code).claim(code))) return forward(request, env, code, tags, null);
  }
  return new Response("No free room code right now", { status: 503 });
}

function forward(request: Request, env: Env, code: string, tags: readonly string[], officeScenarioId: string | null): Promise<Response> {
  const url = new URL(request.url);
  url.searchParams.set(ROOM_CODE_QUERY, code);
  const forwarded = new Request(url, request);
  forwarded.headers.set(IDENTITY_TAGS_HEADER, JSON.stringify(tags));
  // Only the worker decides what's an office; a client can't open one by sending the header itself.
  forwarded.headers.delete(OFFICE_SCENARIO_HEADER);
  if (officeScenarioId) forwarded.headers.set(OFFICE_SCENARIO_HEADER, officeScenarioId);
  return env.ROOMS.getByName(code).fetch(forwarded);
}

/** Browsers always send Origin on a WebSocket handshake; anything else is another site borrowing our rooms. */
function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = env.ALLOWED_ORIGINS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [new URL(request.url).origin];
  return allowed.includes(origin);
}
