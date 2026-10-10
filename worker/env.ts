import type { RoomObject } from "./room-object.ts";

/** Bindings declared in wrangler.jsonc. */
export interface Env {
  readonly ASSETS: Fetcher;
  readonly ROOMS: DurableObjectNamespace<RoomObject>;
  readonly DB: D1Database;
  /** Comma-separated origins allowed to open room sockets; unset means the site's own origin only. */
  readonly ALLOWED_ORIGINS?: string;
}
