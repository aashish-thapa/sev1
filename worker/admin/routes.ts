import { isAdmin } from "../../src/domain/tags.ts";
import type { z } from "zod";
import { ADMIN_GRANTS_PATH, ADMIN_STATS_PATH, ADMIN_USERS_PATH, GrantRequestSchema, type GrantListSchema, type GrantResponseSchema } from "../../src/storage/admin-protocol.ts";
import type { AccountService } from "../api/accounts.ts";
import { failure, idempotencyKeyOf, isSameOrigin, json, readBody, sessionTokenOf } from "../api/http.ts";
import type { GrantDesk } from "../grants/service.ts";
import type { AdminService } from "./service.ts";

export const ADMIN_PREFIX = "/api/admin/";
/** A few refreshes in a row shouldn't each rescan every save. */
const CACHE = { "cache-control": "private, max-age=30" } as const;

type GrantResponse = z.output<typeof GrantResponseSchema>;
type GrantList = z.output<typeof GrantListSchema>;

/** Every admin route checks the caller's server-held tags; anyone else gets the same 403, signed in or not. */
export async function handleAdmin(request: Request, accounts: Pick<AccountService, "userFor">, admin: AdminService, grants: GrantDesk): Promise<Response> {
  const user = await accounts.userFor(sessionTokenOf(request));
  if (!user || !isAdmin(user.tags)) return failure("forbidden", "Admins only.", 403);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === ADMIN_GRANTS_PATH) {
    if (!isSameOrigin(request)) return failure("forbidden", "Cross-site requests are not allowed.", 403);
    const body = await readBody(request, GrantRequestSchema);
    if (!body.ok) return body.response;
    const outcome = await grants.grant(user, body.data, idempotencyKeyOf(request));
    if (!outcome.ok) {
      return outcome.problem === "unknown_user" ? failure("unknown_user", "No player has that username.", 404) : failure("rate_limited", "Too many grants in a row. Try again in a few minutes.", 429);
    }
    const response: GrantResponse = { grant: outcome.grant };
    // A retried request (same idempotency key) returns the grant it already made.
    return json(response, outcome.isNew ? 201 : 200);
  }
  if (request.method !== "GET") return failure("not_found", "No such admin route.", 404);

  switch (url.pathname) {
    case ADMIN_STATS_PATH:
      return json(await admin.stats(), 200, CACHE);
    case ADMIN_USERS_PATH:
      return json(await admin.users(url.searchParams.get("query") ?? ""), 200, CACHE);
    case ADMIN_GRANTS_PATH: {
      const history = await grants.history(url.searchParams.get("username") ?? "");
      if (history === null) return failure("unknown_user", "No player has that username.", 404);
      const list: GrantList = { grants: history };
      return json(list);
    }
    default:
      return failure("not_found", "No such admin route.", 404);
  }
}
