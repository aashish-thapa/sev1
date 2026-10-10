import { DurableObject } from "cloudflare:workers";
import { PublicRoomSchema, type PublicRoom } from "../src/multiplayer/protocol.ts";
import { newestFirst } from "../server/listing.ts";
import type { Env } from "./env.ts";

/** The one directory every room reports to. */
export const DIRECTORY_NAME = "directory";

/**
 * A room that stops reporting (its object was evicted mid-incident) drops out after this long.
 * Rooms report on every join and leave, and a whole incident with monitoring runs well under it.
 */
const STALE_AFTER_MS = 2 * 60 * 60_000;

type Entry = { readonly room: PublicRoom; readonly reportedAt: number };

/**
 * The public room list. Rooms report here when they change (open, join, leave) and withdraw
 * when they close or go private-only, so reading the list never touches the rooms themselves.
 * Entries live in the object's storage, so the list survives the object being evicted.
 */
export class DirectoryObject extends DurableObject<Env> {
  /** Lists `room`, or withdraws it when `room` is null. */
  async report(code: string, room: PublicRoom | null): Promise<void> {
    if (room === null) await this.ctx.storage.delete(code);
    else await this.ctx.storage.put<Entry>(code, { room, reportedAt: Date.now() });
  }

  async list(): Promise<PublicRoom[]> {
    const entries = await this.ctx.storage.list<Entry>();
    const cutoff = Date.now() - STALE_AFTER_MS;
    const stale = [...entries].filter(([, entry]) => entry.reportedAt < cutoff).map(([code]) => code);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    // Parse on the way out: an entry written by an older deploy must not reach the lobby malformed.
    const fresh = [...entries.values()].filter((entry) => entry.reportedAt >= cutoff).flatMap((entry) => {
      const parsed = PublicRoomSchema.safeParse(entry.room);
      return parsed.success ? [parsed.data] : [];
    });
    return newestFirst(fresh);
  }
}
