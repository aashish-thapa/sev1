/** The leaderboard contract, shared by the worker that ranks accounts and the lobby that shows them. */
import { z } from "zod";
import { TITLES } from "../domain/career.ts";

export const LEADERBOARD_PATH = "/api/leaderboard";
/** How many accounts the board lists. */
export const LEADERBOARD_SIZE = 20;

export const LeaderboardEntrySchema = z.object({
  rank: z.int().positive(),
  username: z.string(),
  title: z.enum(TITLES),
  experience: z.int().nonnegative(),
  /** The badge the player chose to show next to their name; a catalog id, or null. */
  featuredBadge: z.string().nullable(),
});
export type LeaderboardEntry = z.output<typeof LeaderboardEntrySchema>;

export const LeaderboardSchema = z.object({
  entries: z.array(LeaderboardEntrySchema).max(LEADERBOARD_SIZE),
  /** Where the signed-in caller stands, even outside the top; null for guests. */
  me: z.object({ rank: z.int().positive(), experience: z.int().nonnegative() }).nullable(),
});
export type Leaderboard = z.output<typeof LeaderboardSchema>;
