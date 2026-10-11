import { z } from "zod";
import { badgeById } from "../domain/achievements.ts";
import { AVATARS } from "../warroom/floor/assets/catalog.ts";
import { ROLE_IDS, type Role } from "../domain/incident.ts";
import type { Debrief } from "../warroom/incident.ts";
import type { CommsMessage } from "../warroom/scenario.ts";
import type { Tally } from "../warroom/scorecard.ts";
import { TEAMS, type LaneStanding, type MatchStage } from "../warroom/versus.ts";
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
/** Sized for a voice handshake (an audio-only SDP offer runs 1.5–3 KB); every field below is bounded on its own. */
export const MAX_INBOUND_BYTES = 8192;
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
  /** Seated players report their chair and the desk's heading, so others see them at the desk. */
  stance: z.enum(["standing", "seated"]).default("standing"),
  /** Laptop open: teammates see them working on it. */
  isOnLaptop: z.boolean().default(false),
  /** A coffee or a snack in hand, so teammates see the break; older clients send nothing. */
  holding: z.enum(["cup", "snack"]).nullable().default(null),
});
export type Position = z.output<typeof PositionSchema>;

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

/** The body a player chose to wear; only catalog bodies are taken. Older clients send none. */
const OfferedAvatarSchema = z
  .string()
  .refine((id) => AVATARS.some((avatar) => avatar.id === id), "unknown avatar")
  .nullable()
  .default(null);
/** Read back loosely, like the badge: an unknown body falls back to the seeded one on the floor. */
const ShownAvatarSchema = z.string().max(40).nullable().default(null);

/** One step of a voice call's WebRTC handshake, passed between two players by the room. */
export const SignalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("description"),
    description: z.object({ type: z.enum(["offer", "answer", "pranswer", "rollback"]), sdp: z.string().max(6000).optional() }),
  }),
  z.object({
    kind: z.literal("candidate"),
    candidate: z
      .object({
        candidate: z.string().max(512).optional(),
        sdpMid: z.string().max(32).nullable().optional(),
        sdpMLineIndex: z.int().min(0).max(16).nullable().optional(),
        usernameFragment: z.string().max(64).nullable().optional(),
      })
      .nullable(),
  }),
]);
export type Signal = z.output<typeof SignalSchema>;

/**
 * A company office starts "quiet": the floor is calm and nothing is paging until the pager goes off.
 * Every other room is an incident from the start, which is also what older servers mean by saying nothing.
 */
export const ROOM_PHASES = ["quiet", "incident"] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];
const RoomPhaseSchema = z.enum(ROOM_PHASES);

/** Public rooms are listed for anyone to join; private ones only open to people given the code. */
export const ROOM_VISIBILITIES = ["public", "private"] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

/** Co-op: one shared incident. Versus: two teams race their own copy of the same incident. */
export const ROOM_MODES = ["coop", "versus"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];
const RoomModeSchema = z.enum(ROOM_MODES);

export const TeamSchema = z.enum(TEAMS);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    scenarioId: z.string().min(1).max(64),
    name: PlayerNameSchema,
    role: RoleSchema,
    // Clients from before public rooms never send it; their rooms stay invite-only.
    visibility: z.enum(ROOM_VISIBILITIES).default("private"),
    mode: RoomModeSchema.default("coop"),
    badge: OfferedBadgeSchema,
    avatar: OfferedAvatarSchema,
  }),
  z.strictObject({
    type: z.literal("join"),
    roomCode: RoomCodeSchema,
    name: PlayerNameSchema,
    role: RoleSchema,
    badge: OfferedBadgeSchema,
    avatar: OfferedAvatarSchema,
    /** Reclaims a seat (and its shell history) after a dropped connection. */
    resume: ResumeSchema.optional(),
  }),
  z.strictObject({ type: z.literal("presence"), ...PositionSchema.shape }),
  z.strictObject({ type: z.literal("command"), line: z.string().max(MAX_COMMAND_LENGTH) }),
  z.strictObject({ type: z.literal("declare") }),
  /** A quiet office's "Page me": the incident starts now rather than when the pager would have gone off. */
  z.strictObject({ type: z.literal("page") }),
  z.strictObject({ type: z.literal("chat"), text: z.string().trim().min(1).max(MAX_CHAT_LENGTH) }),
  /** Sent by a client that can do voice: it joins the room's calls, and says whether its mic is open. */
  z.strictObject({ type: z.literal("voice"), isMicOn: z.boolean() }),
  z.strictObject({ type: z.literal("signal"), to: PlayerIdSchema, signal: SignalSchema }),
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
  /** The body they chose; null means the floor picks one from their id. */
  avatar: ShownAvatarSchema,
  /** Granted tags (e.g. "creator"), set by the server from the account, never by the client. */
  tags: z.array(z.string().max(40)).max(8).default([]),
  /** Null for a client without voice; it's never sent a handshake it couldn't read. */
  voice: z.object({ isMicOn: z.boolean() }).nullable().default(null),
});
export type Player = z.infer<typeof PlayerSchema>;

const CommsMessageSchema = z.object({ at: z.number(), from: z.string(), text: z.string(), kind: z.literal("chat").optional() }) satisfies z.ZodType<CommsMessage>;

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

const TallySchema = z.object({
  playerId: PlayerIdSchema,
  name: z.string(),
  role: RoleSchema,
  commands: z.int().nonnegative(),
  changes: z.int().nonnegative(),
  earlyDeclares: z.int().nonnegative(),
  isFixer: z.boolean(),
}) satisfies z.ZodType<Tally>;

const LaneStandingSchema = z.object({
  team: TeamSchema,
  players: z.int().nonnegative(),
  phase: z.enum(["waiting", "live", "monitoring", "closed"]),
  alertRate: z.number().min(0).max(1),
  reopenCount: z.int().nonnegative(),
  finish: z.object({ points: z.number(), closedAt: z.number() }).nullable(),
}) satisfies z.ZodType<LaneStanding>;

const MatchStageSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("lineup") }),
  z.object({ name: z.literal("racing") }),
  z.object({ name: z.literal("overtime"), msLeft: z.number().nonnegative() }),
  z.object({ name: z.literal("decided"), winner: z.union([TeamSchema, z.literal("draw")]) }),
]) satisfies z.ZodType<MatchStage>;

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
    phase: RoomPhaseSchema.default("incident"),
    /** The side this player is on in a versus match; null in a co-op room. */
    team: TeamSchema.nullable().default(null),
  }),
  /** The room went quiet, or the pager went off; a full `state` frame follows with the incident to show. */
  z.object({ type: z.literal("phase"), phase: RoomPhaseSchema }),
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
  z.object({ type: z.literal("signal"), from: PlayerIdSchema, signal: SignalSchema }),
  z.object({ type: z.literal("error"), code: z.enum(ERROR_CODES), message: z.string() }),
  z.object({
    type: z.literal("closed"),
    /** The postmortem answer is each player's own, so both outcomes are scored here. */
    debrief: z.object({ ifPostmortemCorrect: DebriefSchema, ifPostmortemWrong: DebriefSchema }),
    /** What each engineer did, including those who have since left; older servers send none. */
    scorecard: z.array(TallySchema).default([]),
  }),
  /** A versus match's standings: sent as they change, and about once a second while it's on. */
  z.object({ type: z.literal("match"), stage: MatchStageSchema, lanes: z.array(LaneStandingSchema) }),
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
  mode: RoomModeSchema.default("coop"),
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
