/** The admin dashboard's reads. The server checks the admin tag on every request; the client only asks. */
import {
  ADMIN_GRANTS_PATH,
  ADMIN_STATS_PATH,
  ADMIN_USERS_PATH,
  AdminStatsSchema,
  AdminUsersSchema,
  GrantListSchema,
  GrantResponseSchema,
  type AdminStats,
  type AdminUser,
  type Grant,
  type GrantRequest,
} from "./admin-protocol.ts";

export type AdminRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: "forbidden" | "unreachable" };

export interface AdminApi {
  stats(signal: AbortSignal): Promise<AdminRead<AdminStats>>;
  users(query: string, signal: AbortSignal): Promise<AdminRead<readonly AdminUser[]>>;
  grant(request: GrantRequest): Promise<AdminRead<Grant>>;
  grants(username: string, signal: AbortSignal): Promise<AdminRead<readonly Grant[]>>;
}

export class HttpAdminApi implements AdminApi {
  async stats(signal: AbortSignal): Promise<AdminRead<AdminStats>> {
    const read = await get(ADMIN_STATS_PATH, signal);
    if (!read.ok) return read;
    const parsed = AdminStatsSchema.safeParse(read.value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: "unreachable" };
  }

  async users(query: string, signal: AbortSignal): Promise<AdminRead<readonly AdminUser[]>> {
    const read = await get(`${ADMIN_USERS_PATH}?query=${encodeURIComponent(query)}`, signal);
    if (!read.ok) return read;
    const parsed = AdminUsersSchema.safeParse(read.value);
    return parsed.success ? { ok: true, value: parsed.data.users } : { ok: false, problem: "unreachable" };
  }

  async grant(request: GrantRequest): Promise<AdminRead<Grant>> {
    try {
      const response = await fetch(ADMIN_GRANTS_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(request),
      });
      if (response.status === 401 || response.status === 403) return { ok: false, problem: "forbidden" };
      if (!response.ok) return { ok: false, problem: "unreachable" };
      const parsed = GrantResponseSchema.safeParse(await response.json());
      return parsed.success ? { ok: true, value: parsed.data.grant } : { ok: false, problem: "unreachable" };
    } catch {
      return { ok: false, problem: "unreachable" };
    }
  }

  async grants(username: string, signal: AbortSignal): Promise<AdminRead<readonly Grant[]>> {
    const read = await get(`${ADMIN_GRANTS_PATH}?username=${encodeURIComponent(username)}`, signal);
    if (!read.ok) return read;
    const parsed = GrantListSchema.safeParse(read.value);
    return parsed.success ? { ok: true, value: parsed.data.grants } : { ok: false, problem: "unreachable" };
  }
}

async function get(path: string, signal: AbortSignal): Promise<AdminRead<unknown>> {
  try {
    const response = await fetch(path, { signal, credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.status === 401 || response.status === 403) return { ok: false, problem: "forbidden" };
    if (!response.ok) return { ok: false, problem: "unreachable" };
    return { ok: true, value: await response.json() };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, problem: "unreachable" };
  }
}
