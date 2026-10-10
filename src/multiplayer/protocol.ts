import { z } from "zod";
import { badgeById } from "../domain/achievements.ts";
import { ROLE_IDS, type Role } from "../domain/incident.ts";
import type { Debrief } from "../warroom/incident.ts";
import type { CommsMessage } from "../warroom/scenario.ts";
import type { OutputLine } from "../warroom/shell/types.ts";
import { IncidentFrameSchema } from "./frame.ts";

/** Letters only, minus I, L and O, which read as 1 and 0 when a code is said aloud or typed from a screen share. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 4;
export const MAX_PLAYERS_PER_ROOM = 5;
/**
 * Query parameter naming the room a socket is for. A host that keeps each room on its own machine
 * routes by it before any message arrives; a socket without it is opening a new room.
 */
export const ROOM_CODE_QUERY = "room";
/** Larger inbound frames get an error reply; the socket's hard `maxPayload` sits above this. */
export const MAX_INBOUND_BYTES = 2048;
export const MAX_COMMAND_LENGTH = 500;
export const MAX_CHAT_LENGTH = 280;
export const MAX_NAME_LENGTH = 24;
/** Generous bound on the office floor; anything outside is a buggy or hostile client. */
const MAX_COORDINATE = 1000;

export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`), "not a room code");

export const RoleSchema = z.enum(ROLE_IDS);
export const PlayerNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const PlayerIdSchema = z.string().min(1).max(64);

export const PositionSchema = z.object({
  x: z.number().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  z: z.number().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  yaw: z.number().min(-4 * Math.PI).max(4 * Math.PI),
});
export type Position = z.infer<typeof PositionSchema>;

const ResumeSchema = z.object({ playerId: PlayerIdSchema, token: z.string().min(1).max(128) });
export type Resume = z.infer<typeof ResumeSchema>;

/**
 * The badge a player shows by their name. The server only takes catalog ids; it can't check a
 * guest has earned one, so in rooms the badge is cosmetic. Older clients send none.
 */
const OfferedBadgeSchema = z
  .string()
  .refine((id) => badgeById(id) !== undefined, "unknown badge")
  .nullable()
  .default(null);
/** What clients accept back: any short id, so a client older than the catalog still parses the room. */
const ShownBadgeSchema = z.string().max(40).nullable().default(null);

/** Public rooms are listed for anyone to join; private ones only open to people given the code. */
export const ROOM_VISIBILITIES = ["public", "private"] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    scenarioId: z.string().min(1).max(64),
    name: PlayerNameSchema,
    role: RoleSchema,
    // Clients from before public rooms never send it; their rooms stay invite-only.
    visibility: z.enum(ROOM_VISIBILITIES).default("private"),
    badge: OfferedBadgeSchema,
  }),
  z.strictObject({
    type: z.literal("join"),
    roomCode: RoomCodeSchema,
    name: PlayerNameSchema,
    role: RoleSchema,
    badge: OfferedBadgeSchema,
    /** Reclaims a seat (and its shell history) after a dropped connection. */
    resume: ResumeSchema.optional(),
  }),
  z.strictObject({ type: z.literal("presence"), ...PositionSchema.shape }),
  z.strictObject({ type: z.literal("command"), line: z.string().max(MAX_COMMAND_LENGTH) }),
  z.strictObject({ type: z.literal("declare") }),
  z.strictObject({ type: z.literal("chat"), text: z.string().trim().min(1).max(MAX_CHAT_LENGTH) }),
  z.strictObject({ type: z.literal("leave") }),
  z.strictObject({ type: z.literal("ping"), nonce: z.int().nonnegative().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
/** What callers hand to `encodeClientMessage`; trimming and upper-casing happen on parse. */
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;

export const ERROR_CODES = [
  "bad_message",
  "too_large",
  "unknown_scenario",
  "room_not_found",
  "room_full",
  "server_full",
  "already_in_room",
  "not_in_room",
  "incident_not_live",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const PlayerSchema = z.object({
  id: PlayerIdSchema,
  name: z.string(),
  role: RoleSchema,
  position: PositionSchema.nullable(),
  /** False while a dropped player's seat is held for them to reconnect. */
  isConnected: z.boolean(),
  badge: ShownBadgeSchema,
});
export type Player = z.infer<typeof PlayerSchema>;

const CommsMessageSchema = z.object({ at: z.number(), from: z.string(), text: z.string() }) satisfies z.ZodType<CommsMessage>;

const OutputLineSchema = z.object({ text: z.string(), tone: z.enum(["out", "err", "dim"]) }) satisfies z.ZodType<OutputLine>;

const DebriefSchema = z.object({
  points: z.number(),
  grade: z.enum(["S", "A", "B", "C", "D"]),
  failedCheckouts: z.number(),
  minutesToResolve: z.number(),
  reopenCount: z.int(),
  crashLoopsCaused: z.int(),
  isRootCauseFixed: z.boolean(),
  isPostmortemCorrect: z.boolean(),
  objectives: z.array(z.object({ role: z.enum(ROLE_IDS as [Role, ...Role[]]), label: z.string(), isMet: z.boolean() })).readonly().optional(),
}) satisfies z.ZodType<Debrief>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    roomCode: RoomCodeSchema,
    playerId: PlayerIdSchema,
    /** Secret that lets this player reclaim their seat with `join.resume`. */
    resumeToken: z.string(),
    /** True when `join.resume` reattached an existing seat rather than creating a new one. */
    isResumed: z.boolean(),
    scenarioId: z.string(),
    players: z.array(PlayerSchema),
    comms: z.array(CommsMessageSchema),
    /** This player's own shell history, so ↑ and `history` survive a reconnect. */
    history: z.array(z.string()),
  }),
  z.object({ type: z.literal("players"), players: z.array(PlayerSchema) }),
  z.object({ type: z.literal("presence"), playerId: PlayerIdSchema, position: PositionSchema }),
  z.object({ type: z.literal("state"), frame: IncidentFrameSchema }),
  z.object({
    type: z.literal("terminal"),
    line: z.string(),
    output: z.array(OutputLineSchema),
    isClearScreen: z.boolean(),
  }),
  z.object({
    type: z.literal("activity"),
    at: z.number(),
    playerId: PlayerIdSchema,
    name: z.string(),
    role: RoleSchema,
    /** Possibly shortened; for a feed line, not for replay. */
    line: z.string(),
    didChangeCluster: z.boolean(),
  }),
  z.object({ type: z.literal("comms"), message: CommsMessageSchema }),
  z.object({ type: z.literal("error"), code: z.enum(ERROR_CODES), message: z.string() }),
  z.object({
    type: z.literal("closed"),
    /** The postmortem answer is each player's own, so both outcomes are scored here. */
    debrief: z.object({ ifPostmortemCorrect: DebriefSchema, ifPostmortemWrong: DebriefSchema }),
  }),
  z.object({ type: z.literal("pong"), nonce: z.int().nonnegative().optional() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
export type ServerMessageOf<Type extends ServerMessageType> = Extract<ServerMessage, { type: Type }>;

export type ParseResult<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly code: ErrorCode; readonly reason: string };

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, raw, MAX_INBOUND_BYTES);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw, Number.POSITIVE_INFINITY);
}

/** Where the lobby reads the public rooms that are open to join. */
export const PUBLIC_ROOMS_PATH = "/api/rooms";

/** A public room as the lobby lists it. */
export const PublicRoomSchema = z.object({
  code: RoomCodeSchema,
  host: z.string(),
  players: z.int().nonnegative(),
  maxPlayers: z.int().positive(),
  scenarioTitle: z.string(),
  /** Epoch milliseconds the room opened. */
  openedAt: z.number(),
});
export type PublicRoom = z.infer<typeof PublicRoomSchema>;

export const PublicRoomListSchema = z.object({ rooms: z.array(PublicRoomSchema) });
export type PublicRoomList = z.infer<typeof PublicRoomListSchema>;

export function encodeClientMessage(message: ClientMessageInput): string {
  return JSON.stringify(message);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

function parseWith<T>(schema: z.ZodType<T>, raw: string, maxBytes: number): ParseResult<T> {
  // String length bounds UTF-8 bytes from below, so the cheap check runs first.
  if (raw.length > maxBytes || new TextEncoder().encode(raw).length > maxBytes) {
    return { ok: false, code: "too_large", reason: `messages are limited to ${maxBytes} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, code: "bad_message", reason: "message is not JSON" };
    throw error;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "bad_message", reason: z.prettifyError(parsed.error) };
  return { ok: true, message: parsed.data };
}
