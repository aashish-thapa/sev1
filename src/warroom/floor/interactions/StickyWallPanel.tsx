import { useState, type FormEvent, type KeyboardEvent } from "react";
import { NOTE_LIMIT, TEAM_NOTES } from "./stickyNotes.ts";

type Props = {
  notes: readonly string[];
  onPin: (text: string) => void;
  onClose: () => void;
};

/** Up close at the note wall: the team's notes, yours, and a pad to write a new one. */
export function StickyWallPanel({ notes, onPin, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onPin(draft);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") onClose();
  };
  return (
    <section className="notes-wall" role="dialog" aria-modal="true" aria-labelledby="notes-wall-title" onKeyDown={onKeyDown}>
      <header className="notes-wall__head">
        <h2 id="notes-wall-title">The team wall</h2>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Back to the floor
        </button>
      </header>
      <ul className="notes-wall__grid">
        {TEAM_NOTES.map((note) => (
          <li key={note} className="notes-wall__note">
            {note}
          </li>
        ))}
        {notes.map((note, index) => (
          <li key={`${index}:${note}`} className="notes-wall__note" data-mine="true">
            {note}
          </li>
        ))}
      </ul>
      <form className="notes-wall__pad" onSubmit={submit}>
        <label htmlFor="notes-wall-draft">Leave a note for the team</label>
        <div className="notes-wall__row">
          <input id="notes-wall-draft" value={draft} maxLength={NOTE_LIMIT} onChange={(event) => setDraft(event.target.value)} placeholder="Ship small, ship often" autoFocus />
          <button type="submit" className="button button--primary" disabled={!draft.trim()}>
            Pin it
          </button>
        </div>
      </form>
    </section>
  );
}
