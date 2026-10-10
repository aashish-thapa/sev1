/** The admin dashboard's numbers, assembled from aggregate queries; only the router decides who may ask. */
import { TITLES } from "../../src/domain/career.ts";
import { INCIDENT_MIN_POINTS } from "../../src/domain/economy.ts";
import { ADMIN_USERS_LIMIT, SIGNUP_DAYS, type AdminStats, type AdminUsers } from "../../src/storage/admin-protocol.ts";
import type { RankedAccount } from "../api/store.ts";
import type { AdminStore } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdminSources = {
  readonly store: AdminStore;
  /** The leaderboard's top accounts, already ranked. */
  topAccounts(limit: number): Promise<RankedAccount[]>;
  /** How many public rooms are listed right now. */
  publicRooms(): Promise<number>;
  readonly now: () => number;
};

/** One entry per UTC day, oldest first, zeros where nobody signed up. */
export function signupSeries(days: readonly { day: string; count: number }[], now: number, span: number): { day: string; count: number }[] {
  const counts = new Map(days.map((entry) => [entry.day, entry.count]));
  return Array.from({ length: span }, (_, index) => {
    const day = new Date(now - (span - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
}

export class AdminService {
  private readonly sources: AdminSources;

  constructor(sources: AdminSources) {
    this.sources = sources;
  }

  async stats(): Promise<AdminStats> {
    const now = this.sources.now();
    const firstDay = Date.parse(`${new Date(now - (SIGNUP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)}T00:00:00Z`);
    const [raw, top, publicLive] = await Promise.all([
      // A War Room counts as passed at the same score that pays a bonus and earns experience.
      this.sources.store.stats(now, firstDay, INCIDENT_MIN_POINTS),
      this.sources.topAccounts(10),
      this.sources.publicRooms(),
    ]);
    const levelCounts = new Map(raw.levels.map((level) => [level.title, level.count]));
    return {
      generatedAt: now,
      accounts: { ...raw.accounts, signupsByDay: signupSeries(raw.signupDays, now, SIGNUP_DAYS) },
      activity: raw.activity,
      levels: TITLES.map((title) => ({ title, count: levelCounts.get(title) ?? 0 })),
      warRooms: [...raw.warRooms],
      cards: { correctTotal: raw.correctCards },
      economy: {
        earnedCentsTotal: raw.earnedCents.salary + raw.earnedCents.card + raw.earnedCents.incident,
        byReason: raw.earnedCents,
        solutionsBought: raw.solutionsBought,
      },
      pro: raw.pro,
      rooms: { publicLive },
      topPlayers: top.map((account, index) => ({ rank: index + 1, username: account.username, title: account.title, experience: account.experience })),
    };
  }

  async users(query: string): Promise<AdminUsers> {
    const rows = await this.sources.store.searchUsers(query.trim().slice(0, 40), ADMIN_USERS_LIMIT);
    return {
      users: rows.map((row) => ({
        username: row.username,
        createdAt: row.createdAt,
        title: row.title ?? TITLES[0],
        experience: row.experience ?? 0,
        tags: [...row.tags],
        lastActive: row.lastActive,
      })),
    };
  }
}
