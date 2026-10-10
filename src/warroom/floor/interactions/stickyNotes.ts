/** The team's sticky-note wall on the dev floor: what's already up there, and the notes you add. */

export const TEAM_NOTES: readonly string[] = [
  "No deploys after 4pm Friday. Yes, you.",
  "Who owns the orders-db alerts? → Infra",
  "Retro: fewer pages, more sleep",
  "Runbooks live in /docs/runbooks — update them!",
  "Coffee machine descale: Mondays",
  "Q4 OKR: p99 checkout < 400 ms",
  "Rotate on-call keys before the sale",
  "Thank you Lena for the 3am save!",
];

export const NOTE_LIMIT = 60;
export const OWN_NOTES_KEPT = 6;

/** Where your own notes are kept between visits; this browser only. */
export interface NoteStore {
  load(): readonly string[];
  save(notes: readonly string[]): void;
}

/** A trimmed, length-capped note at the end; the oldest of yours comes down once the wall is full. */
export function pinNote(notes: readonly string[], text: string): readonly string[] {
  const note = text.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMIT);
  if (!note) return notes;
  return [...notes, note].slice(-OWN_NOTES_KEPT);
}

const STORAGE_KEY = "sev1.sticky-notes.v1";

/** localStorage can be missing or refuse writes (private windows); notes then last for the visit only. */
export class BrowserNoteStore implements NoteStore {
  private readonly storage: Storage | undefined;
  private memory: readonly string[] = [];

  constructor(storage: Storage | undefined) {
    this.storage = storage;
  }

  load(): readonly string[] {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) this.memory = parsed.filter((item): item is string => typeof item === "string").slice(-OWN_NOTES_KEPT);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof DOMException)) throw error;
    }
    return this.memory;
  }

  save(notes: readonly string[]): void {
    this.memory = notes;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }
}
