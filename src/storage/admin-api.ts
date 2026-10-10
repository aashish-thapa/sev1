/** The admin dashboard's reads. The server checks the admin tag on every request; the client only asks. */
import { ADMIN_STATS_PATH, ADMIN_USERS_PATH, AdminStatsSchema, AdminUsersSchema, type AdminStats, type AdminUser } from "./admin-protocol.ts";

export type AdminRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: "forbidden" | "unreachable" };

export interface AdminApi {
  stats(signal: AbortSignal): Promise<AdminRead<AdminStats>>;
  users(query: string, signal: AbortSignal): Promise<AdminRead<readonly AdminUser[]>>;
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
