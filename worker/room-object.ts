import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { encodeServerMessage, ROOM_CODE_QUERY } from "../src/multiplayer/protocol.ts";
import { publicListing, type RoomListing } from "../server/listing.ts";
import { DEFAULT_ROOM_TIMING, Room, type Connection } from "../server/room.ts";
import { openVenue, type Venue } from "../server/venue.ts";
import { officePaging } from "../server/paging.ts";
import { findScenario } from "../server/scenarios.ts";
import { openSession, type RoomDirectory } from "../server/session.ts";
import { IDENTITY_TAGS_HEADER, IDENTITY_USER_HEADER, OFFICE_SCENARIO_HEADER, VISITOR_HEADER } from "./rooms.ts";
import { DIRECTORY_NAME } from "./directory-object.ts";
import { MATCHMAKER_NAME } from "./matchmaker-object.ts";
import type { Matchmaking, MatchmakingOutcome } from "../server/matchmaking.ts";
import type { Env } from "./env.ts";
import { workerLogger } from "./log.ts";

const OPEN = 1;
/** How long a room with nobody connected is kept for people to reconnect. */
const ROOM_GRACE_MS = 5 * 60_000;

/**
 * One war room per object, addressed by its code. Sockets use the standard (non-hibernating)
 * API: a live room ticks every second, so it would never hibernate anyway, and once the last
 * socket closes the runtime is free to evict the object.
 */
export class RoomObject extends DurableObject<Env> {
  private room: Venue | null = null;
  private listing: RoomListing | null = null;
  private claimedCode: string | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  /** Signed-in players with a socket open here, by user id, one count per socket. */
  private readonly present = new Map<string, number>();

  /** Reserves this object for a new room; false when the code is already in use. */
  claim(code: string): boolean {
    if (this.claimedCode !== null || this.room !== null) return false;
    this.claimedCode = code;
    return true;
  }

  /** The matchmaker's answer to this room's search for opponents. */
  matchmaking(outcome: MatchmakingOutcome): void {
    this.room?.onMatchmaking?.(outcome);
  }

  /** Who's connected right now, by user id; the worker asks before letting a deal close in a meeting. */
  presentUsers(): string[] {
    return [...this.present.keys()];
  }

  override fetch(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const code = new URL(request.url).searchParams.get(ROOM_CODE_QUERY) ?? "";
    const pair = new WebSocketPair();
    const [client, socket] = [pair[0], pair[1]];
    socket.accept();

    const connection: Connection = {
      send: (payload) => {
        if (socket.readyState === OPEN) socket.send(payload);
      },
      close: (closeCode, reason) => socket.close(closeCode, reason),
    };
    const officeScenario = request.headers.get(OFFICE_SCENARIO_HEADER);
    const session = openSession({ connection, rooms: this.directory(code, officeScenario), findScenario, logger: workerLogger, identity: { tags: tagsOf(request), isVisitor: request.headers.get(VISITOR_HEADER) === "1" } });
    const bytes = new TextEncoder();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        connection.send(encodeServerMessage({ type: "error", code: "bad_message", message: "Send JSON text frames." }));
        return;
      }
      session.receive(event.data, bytes.encode(event.data).byteLength);
    });
    const userId = request.headers.get(IDENTITY_USER_HEADER) ?? "";
    if (userId) this.present.set(userId, (this.present.get(userId) ?? 0) + 1);
    let isGone = false;
    const leave = () => {
      session.end();
      if (isGone || !userId) return;
      isGone = true;
      const count = (this.present.get(userId) ?? 1) - 1;
      if (count > 0) this.present.set(userId, count);
      else this.present.delete(userId);
    };
    socket.addEventListener("close", leave);
    socket.addEventListener("error", leave);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * This object holds at most one room: the one it was claimed for. A company office (the worker vouches with
   * `officeScenario`) opens on the first member's join, and again after it empties out and closes.
   */
  private directory(code: string, officeScenario: string | null): RoomDirectory {
    return {
      create: (scenario, visibility, mode) => {
        if (this.room !== null || this.claimedCode !== code) return null;
        this.listing = { visibility, openedAt: Date.now() };
        this.room = openVenue(mode, { code, scenario, timing: DEFAULT_ROOM_TIMING, logger: workerLogger, onOccupancyChange: (room) => this.occupancyChanged(room), matchmaking: this.matchmaker() });
        workerLogger("info", "room_created", { room: code, scenario: scenario.id, visibility, mode });
        return this.room;
      },
      find: (candidate) => {
        if (this.room?.code === candidate) return this.room;
        const scenario = officeScenario && candidate === code && this.room === null ? findScenario(officeScenario) : undefined;
        if (!scenario) return undefined;
        this.listing = { visibility: "private", openedAt: Date.now() };
        // An office is calm when members walk in; the pager goes off a few minutes later.
        this.room = new Room(code, scenario, DEFAULT_ROOM_TIMING, workerLogger, (room) => this.occupancyChanged(room), { paging: officePaging(Math.random) });
        workerLogger("info", "office_opened", { room: code, scenario: scenario.id });
        return this.room;
      },
    };
  }

  /** Calls to the matchmaker don't hold up the room; one that fails is logged, and the room's safety net takes over. */
  private matchmaker(): Matchmaking {
    const matchmaker = () => this.env.MATCHMAKER.getByName(MATCHMAKER_NAME);
    const send = (event: string, call: Promise<void>) =>
      this.ctx.waitUntil(call.catch((error: unknown) => workerLogger("warn", event, { message: error instanceof Error ? error.message : String(error) })));
    return {
      seek: (ticket) => send("matchmaking_seek_failed", matchmaker().seek(ticket)),
      withdraw: (code) => send("matchmaking_withdraw_failed", matchmaker().withdraw(code)),
    };
  }

  private occupancyChanged(room: Venue) {
    this.reportToDirectory(room.code, this.listing && publicListing(room, this.listing));
    if (room.connectedCount > 0) {
      if (this.expiry) clearTimeout(this.expiry);
      this.expiry = null;
    } else if (!this.expiry) {
      this.expiry = setTimeout(() => this.close(), ROOM_GRACE_MS);
    }
  }

  /** Keeps the lobby's list current; a private room never reports anything but its absence. */
  private reportToDirectory(code: string, entry: ReturnType<typeof publicListing>) {
    if (this.listing?.visibility !== "public") return;
    const report = this.env.DIRECTORY.getByName(DIRECTORY_NAME)
      .report(code, entry)
      .catch((error: unknown) => workerLogger("warn", "directory_report_failed", { room: code, message: error instanceof Error ? error.message : String(error) }));
    this.ctx.waitUntil(report);
  }

  private close() {
    if (this.room) this.reportToDirectory(this.room.code, null);
    this.room?.dispose();
    workerLogger("info", "room_expired", { room: this.room?.code ?? null });
    this.room = null;
    this.listing = null;
    this.claimedCode = null;
    this.expiry = null;
  }
}

const TagsSchema = z.array(z.string().min(1).max(40)).max(8);

/** The worker resolved these from the session cookie before forwarding; a missing or bad header means none. */
function tagsOf(request: Request): readonly string[] {
  try {
    const parsed = TagsSchema.safeParse(JSON.parse(request.headers.get(IDENTITY_TAGS_HEADER) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
