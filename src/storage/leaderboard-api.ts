import { useEffect, useState } from "react";
import { LEADERBOARD_PATH, LeaderboardSchema, type Leaderboard } from "./leaderboard-protocol.ts";

export type FetchLeaderboard = (signal: AbortSignal) => Promise<Leaderboard>;

export type LeaderboardView = { readonly status: "loading" } | { readonly status: "ready"; readonly board: Leaderboard } | { readonly status: "unavailable" };

/** Reads the board; the session cookie rides along, so a signed-in player also learns their own rank. */
export const fetchLeaderboard: FetchLeaderboard = async (signal) => {
  const response = await fetch(LEADERBOARD_PATH, { signal, credentials: "same-origin", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`leaderboard answered ${response.status}`);
  return LeaderboardSchema.parse(await response.json());
};

/** The board, fetched again whenever `freshness` changes (e.g. the player signs in or out). */
export function useLeaderboard(fetchBoard: FetchLeaderboard, freshness: string): LeaderboardView {
  const [view, setView] = useState<LeaderboardView>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetchBoard(controller.signal).then(
      (board) => setView({ status: "ready", board }),
      () => {
        if (!controller.signal.aborted) setView({ status: "unavailable" });
      },
    );
    return () => controller.abort();
  }, [fetchBoard, freshness]);
  return view;
}
