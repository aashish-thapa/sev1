import { isAdmin } from "../../src/domain/tags.ts";
import { ADMIN_STATS_PATH, ADMIN_USERS_PATH } from "../../src/storage/admin-protocol.ts";
import type { AccountService } from "../api/accounts.ts";
import { failure, json, sessionTokenOf } from "../api/http.ts";
import type { AdminService } from "./service.ts";

export const ADMIN_PREFIX = "/api/admin/";
/** A few refreshes in a row shouldn't each rescan every save. */
const CACHE = { "cache-control": "private, max-age=30" } as const;

/** Every admin route checks the caller's server-held tags; anyone else gets the same 403, signed in or not. */
export async function handleAdmin(request: Request, accounts: Pick<AccountService, "userFor">, admin: AdminService): Promise<Response> {
  const user = await accounts.userFor(sessionTokenOf(request));
  if (!user || !isAdmin(user.tags)) return failure("forbidden", "Admins only.", 403);
  if (request.method !== "GET") return failure("not_found", "Admin routes are read-only.", 404);
  const url = new URL(request.url);
  switch (url.pathname) {
    case ADMIN_STATS_PATH:
      return json(await admin.stats(), 200, CACHE);
    case ADMIN_USERS_PATH:
      return json(await admin.users(url.searchParams.get("query") ?? ""), 200, CACHE);
    default:
      return failure("not_found", "No such admin route.", 404);
  }
}
