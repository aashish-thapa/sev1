import { describe, expect, it } from "vitest";
import { AdminStatsSchema, AdminUsersSchema } from "../../src/storage/admin-protocol.ts";
import { AdminService, signupSeries } from "./service.ts";
import type { AdminStore, RawStats } from "./store.ts";

const NOW = Date.UTC(2026, 9, 10, 15);

const RAW: RawStats = {
  accounts: { total: 3, newToday: 3, new7d: 3, new30d: 3 },
  signupDays: [{ day: "2026-10-10", count: 3 }],
  activity: { active1d: 1, active7d: 1 },
  levels: [{ title: "Intern", count: 1 }],
  warRooms: [{ scenarioId: "checkout-meltdown", players: 1, plays: 4, passed: 1, sGrades: 0 }],
  correctCards: 7,
  earnedCents: { salary: 1_840, card: 0, incident: 91_200 },
  solutionsBought: 0,
  pro: { active: 0, everSubscribed: 0 },
};

const store: AdminStore = {
  stats: async () => RAW,
  searchUsers: async () => [{ username: "aashish", createdAt: NOW, tags: ["creator", "admin"], title: null, experience: null, lastActive: null }],
};

const service = new AdminService({ store, topAccounts: async () => [], publicRooms: async () => 2, now: () => NOW });

describe("admin stats", () => {
  it("fills every signup day, oldest first, ending today", () => {
    const series = signupSeries([{ day: "2026-10-10", count: 3 }], NOW, 30);
    expect(series).toHaveLength(30);
    expect(series[0].day).toBe("2026-09-11");
    expect(series.at(-1)).toEqual({ day: "2026-10-10", count: 3 });
    expect(series.slice(0, -1).every((day) => day.count === 0)).toBe(true);
  });

  it("matches the shared dashboard schema, with every level listed and money totalled", async () => {
    const stats = AdminStatsSchema.parse(await service.stats());
    expect(stats.levels.map((level) => level.title)).toEqual(["Intern", "Junior Engineer", "Engineer", "Senior Engineer", "Staff Engineer"]);
    expect(stats.economy.earnedCentsTotal).toBe(93_040);
    expect(stats.rooms.publicLive).toBe(2);
  });

  it("lists users with their full tags, defaulting accounts that never saved", async () => {
    const { users } = AdminUsersSchema.parse(await service.users("  aa "));
    expect(users[0]).toMatchObject({ username: "aashish", title: "Intern", experience: 0, tags: ["creator", "admin"], lastActive: null });
  });
});

describe("admin gate", () => {
  const userWith = (tags: string[]) => ({ userFor: async () => ({ id: "u", username: "x", passwordHash: "", createdAt: NOW, tags }) });
  const statsRequest = () => new Request("https://sev1.test/api/admin/stats", { headers: { cookie: "sev1_session=t" } });

  it("refuses guests and signed-in players without the admin tag alike", async () => {
    const { handleAdmin } = await import("./routes.ts");
    expect((await handleAdmin(statsRequest(), { userFor: async () => null }, service)).status).toBe(403);
    expect((await handleAdmin(statsRequest(), userWith(["creator"]), service)).status).toBe(403);
  });

  it("serves admins", async () => {
    const { handleAdmin } = await import("./routes.ts");
    const response = await handleAdmin(statsRequest(), userWith(["admin"]), service);
    expect(response.status).toBe(200);
    expect(AdminStatsSchema.safeParse(await response.json()).success).toBe(true);
  });
});
