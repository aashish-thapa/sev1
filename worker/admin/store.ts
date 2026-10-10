/** What the admin dashboard needs from storage: aggregate counts, never anyone's raw saved game. */
import type { Title } from "../../src/domain/career.ts";

export type WarRoomTotals = { readonly scenarioId: string; readonly players: number; readonly plays: number; readonly passed: number; readonly sGrades: number };

export type RawStats = {
  readonly accounts: { readonly total: number; readonly newToday: number; readonly new7d: number; readonly new30d: number };
  /** Signups per UTC day that had any; days with none are absent. */
  readonly signupDays: readonly { readonly day: string; readonly count: number }[];
  readonly activity: { readonly active1d: number; readonly active7d: number };
  readonly levels: readonly { readonly title: Title; readonly count: number }[];
  readonly warRooms: readonly WarRoomTotals[];
  readonly correctCards: number;
  readonly earnedCents: { readonly salary: number; readonly card: number; readonly incident: number };
  readonly solutionsBought: number;
  readonly pro: { readonly active: number; readonly everSubscribed: number };
};

export type AdminUserRow = {
  readonly username: string;
  readonly createdAt: number;
  readonly tags: readonly string[];
  readonly title: Title | null;
  readonly experience: number | null;
  readonly lastActive: number | null;
};

export interface AdminStore {
  /** `passingPoints`: the best score that counts a War Room as passed. */
  stats(now: number, signupsSince: number, passingPoints: number): Promise<RawStats>;
  /** Accounts whose username starts with `prefix` (case-insensitive), alphabetically. */
  searchUsers(prefix: string, limit: number): Promise<AdminUserRow[]>;
}
