import { useEffect, useState } from "react";
import { PUBLIC_ROOMS_PATH, PublicRoomListSchema, type PublicRoom } from "./protocol.ts";

/** How often the lobby refreshes the list while it's on screen. */
const REFRESH_MS = 5_000;

export type PublicRoomsView =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly rooms: readonly PublicRoom[] }
  | { readonly status: "unavailable" };

export type ListPublicRooms = (signal: AbortSignal) => Promise<readonly PublicRoom[]>;

/** Reads the public room list over HTTP; rejects when the server can't be reached or answers nonsense. */
export const fetchPublicRooms: ListPublicRooms = async (signal) => {
  const response = await fetch(PUBLIC_ROOMS_PATH, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`room list answered ${response.status}`);
  return PublicRoomListSchema.parse(await response.json()).rooms;
};

/** The public rooms open right now, refreshed every few seconds while `isActive`. */
export function usePublicRooms(list: ListPublicRooms, isActive: boolean): PublicRoomsView {
  const [view, setView] = useState<PublicRoomsView>({ status: "loading" });

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      try {
        const rooms = await list(controller.signal);
        setView({ status: "ready", rooms });
      } catch {
        if (controller.signal.aborted) return;
        setView({ status: "unavailable" });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), REFRESH_MS);
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [list, isActive]);

  return view;
}
