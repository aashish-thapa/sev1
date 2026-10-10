import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { encodeServerMessage, ROOM_CODE_QUERY } from "../src/multiplayer/protocol.ts";
import { publicListing, type RoomListing } from "../server/listing.ts";
import { DEFAULT_ROOM_TIMING, Room, type Connection } from "../server/room.ts";
import { findScenario } from "../server/scenarios.ts";
import { openSession, type RoomDirectory } from "../server/session.ts";
import { IDENTITY_TAGS_HEADER } from "./rooms.ts";
import { DIRECTORY_NAME } from "./directory-object.ts";
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
  private room: Room | null = null;
  private listing: RoomListing | null = null;
  private claimedCode: string | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  /** Reserves this object for a new room; false when the code is already in use. */
  claim(code: string): boolean {
    if (this.claimedCode !== null || this.room !== null) return false;
    this.claimedCode = code;
    return true;
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
    const session = openSession({ connection, rooms: this.directory(code), findScenario, logger: workerLogger, identity: { tags: tagsOf(request) } });
    const bytes = new TextEncoder();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        connection.send(encodeServerMessage({ type: "error", code: "bad_message", message: "Send JSON text frames." }));
        return;
      }
      session.receive(event.data, bytes.encode(event.data).byteLength);
    });
    socket.addEventListener("close", () => session.end());
    socket.addEventListener("error", () => session.end());
    return new Response(null, { status: 101, webSocket: client });
  }

  /** This object holds at most one room: the one it was claimed for. */
  private directory(code: string): RoomDirectory {
    return {
      create: (scenario, visibility) => {
        if (this.room !== null || this.claimedCode !== code) return null;
        this.listing = { visibility, openedAt: Date.now() };
        this.room = new Room(code, scenario, DEFAULT_ROOM_TIMING, workerLogger, (room) => this.occupancyChanged(room));
        workerLogger("info", "room_created", { room: code, scenario: scenario.id, visibility });
        return this.room;
      },
      find: (candidate) => (this.room?.code === candidate ? this.room : undefined),
    };
  }

  private occupancyChanged(room: Room) {
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
