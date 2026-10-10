import { AccountService } from "./api/accounts.ts";
import { D1AccountStore } from "./api/d1-store.ts";
import { handleApi } from "./api/routes.ts";
import type { Env } from "./env.ts";
import { routeRoomSocket } from "./rooms.ts";

export { RoomObject } from "./room-object.ts";

/** Composition root: rooms, the account API, and everything else from the built site. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rooms") return routeRoomSocket(request, env, Math.random);
    if (pathname.startsWith("/api/")) return handleApi(request, new AccountService(new D1AccountStore(env.DB), Date.now));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
