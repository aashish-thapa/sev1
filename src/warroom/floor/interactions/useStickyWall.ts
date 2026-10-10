import { useCallback, useMemo, useState } from "react";
import { BrowserNoteStore, pinNote, type NoteStore } from "./stickyNotes.ts";
import type { Usable } from "./usable.ts";

/** The note wall on the dev floor's west wall, beside the team's printed notes. */
export const NOTE_WALL = { x: -21.85, z: 6.6, y: 1.45 } as const;

function browserStore(): NoteStore {
  try {
    return new BrowserNoteStore(window.localStorage);
  } catch (error) {
    // Some browsers throw on merely touching localStorage when site data is blocked.
    if (!(error instanceof DOMException)) throw error;
    return new BrowserNoteStore(undefined);
  }
}

/** Reading the team's sticky notes, and pinning your own; yours stay on the wall between visits. */
export function useStickyWall() {
  const store = useMemo(() => browserStore(), []);
  const [notes, setNotes] = useState<readonly string[]>(() => store.load());
  const [isOpen, setOpen] = useState(false);

  const pin = useCallback(
    (text: string) => {
      setNotes((current) => {
        const next = pinNote(current, text);
        store.save(next);
        return next;
      });
    },
    [store],
  );

  const usables = useMemo<Usable[]>(
    () => [{ key: "sticky-wall", footprint: { x: NOTE_WALL.x, z: NOTE_WALL.z, width: 0.3, depth: 1.4 }, verb: "Read", label: "the sticky-note wall", use: () => setOpen(true) }],
    [],
  );

  return { notes, isOpen, close: useCallback(() => setOpen(false), []), pin, usables };
}
