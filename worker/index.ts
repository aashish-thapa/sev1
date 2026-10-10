import { findScenario } from "../server/scenarios.ts";
import { AccountService } from "./api/accounts.ts";
import { D1AccountStore } from "./api/d1-store.ts";
import { handleApi } from "./api/routes.ts";
import { PUBLIC_ROOMS_PATH, type PublicRoomList } from "../src/multiplayer/protocol.ts";
import { DIRECTORY_NAME } from "./directory-object.ts";
import type { Env } from "./env.ts";
import { routeRoomSocket } from "./rooms.ts";

export { DirectoryObject } from "./directory-object.ts";
export { RoomObject } from "./room-object.ts";

/** Composition root: rooms, the account API, and everything else from the built site. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rooms") return routeRoomSocket(request, env, Math.random);
    if (pathname === PUBLIC_ROOMS_PATH && request.method === "GET") {
      const list: PublicRoomList = { rooms: await env.DIRECTORY.getByName(DIRECTORY_NAME).list() };
      return Response.json(list, { headers: { "cache-control": "no-store" } });
    }
    if (pathname.startsWith("/api/")) return handleApi(request, new AccountService(new D1AccountStore(env.DB), Date.now, (id) => findScenario(id)?.tier));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
