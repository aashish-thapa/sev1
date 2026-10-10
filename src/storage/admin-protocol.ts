/** The admin dashboard's contract: read-only numbers about the game, served only to accounts tagged admin. */
import { z } from "zod";
import { TITLES } from "../domain/career.ts";

export const ADMIN_STATS_PATH = "/api/admin/stats";
export const ADMIN_USERS_PATH = "/api/admin/users";
/** How many accounts a user search returns at most. */
export const ADMIN_USERS_LIMIT = 50;
/** Days of history the signups chart covers. */
export const SIGNUP_DAYS = 30;

const Count = z.int().nonnegative();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AdminStatsSchema = z.object({
  /** Epoch ms the numbers were computed. */
  generatedAt: z.number(),
  accounts: z.object({
    total: Count,
    newToday: Count,
    new7d: Count,
    new30d: Count,
    /** One entry per day for the last SIGNUP_DAYS days, oldest first, zeros included. */
    signupsByDay: z.array(z.object({ day: Day, count: Count })).max(SIGNUP_DAYS + 1),
  }),
  /** Accounts whose progress was saved in the last day and week. Guests aren't counted: their progress never reaches the server. */
  activity: z.object({ active1d: Count, active7d: Count }),
  levels: z.array(z.object({ title: z.enum(TITLES), count: Count })),
  warRooms: z.array(
    z.object({
      scenarioId: z.string(),
      /** Accounts that played it at least once. */
      players: Count,
      plays: Count,
      /** Accounts whose best run passed (grade C or better). */
      passed: Count,
      sGrades: Count,
    }),
  ),
  cards: z.object({ correctTotal: Count }),
  economy: z.object({
    earnedCentsTotal: Count,
    byReason: z.object({ salary: Count, card: Count, incident: Count }),
    solutionsBought: Count,
  }),
  pro: z.object({ active: Count, everSubscribed: Count }),
  rooms: z.object({ publicLive: Count }),
  topPlayers: z.array(z.object({ rank: z.int().positive(), username: z.string(), title: z.enum(TITLES), experience: Count })).max(10),
});
export type AdminStats = z.output<typeof AdminStatsSchema>;

export const AdminUserSchema = z.object({
  username: z.string(),
  createdAt: z.number(),
  title: z.enum(TITLES),
  experience: Count,
  tags: z.array(z.string()),
  /** Epoch ms of the last saved progress; null if the account never saved any. */
  lastActive: z.number().nullable(),
});
export type AdminUser = z.output<typeof AdminUserSchema>;

export const AdminUsersSchema = z.object({ users: z.array(AdminUserSchema).max(ADMIN_USERS_LIMIT) });
export type AdminUsers = z.output<typeof AdminUsersSchema>;

export const ADMIN_GRANTS_PATH = "/api/admin/grants";
/** The most one grant can give: $100,000. Test money, not a lever for the leaderboard (grants never count toward badges or XP). */
export const MAX_GRANT_CENTS = 10_000_000;

/** POST /api/admin/grants: put money in a player's wallet. They claim it the next time their game loads. */
export const GrantRequestSchema = z.object({
  username: z.string().trim().min(1).max(24),
  amountCents: z.int().positive().max(MAX_GRANT_CENTS),
  note: z.string().trim().max(120).default(""),
});
export type GrantRequest = z.input<typeof GrantRequestSchema>;

export const GrantSchema = z.object({
  id: z.string(),
  username: z.string(),
  amountCents: z.int().positive(),
  note: z.string(),
  grantedBy: z.string(),
  grantedAt: z.number(),
  /** Null until the player's game has claimed it into their wallet. */
  claimedAt: z.number().nullable(),
});
export type Grant = z.output<typeof GrantSchema>;

export const GrantResponseSchema = z.object({ grant: GrantSchema });
/** GET /api/admin/grants?username=: one player's grants, newest first. */
export const GrantListSchema = z.object({ grants: z.array(GrantSchema).max(100) });
