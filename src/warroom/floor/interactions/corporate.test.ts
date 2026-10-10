import { describe, expect, it } from "vitest";
import { STANDUP, standupPhase, standupScript } from "./standup.ts";
import { BrowserNoteStore, NOTE_LIMIT, OWN_NOTES_KEPT, pinNote, TEAM_NOTES } from "./stickyNotes.ts";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe("sticky notes", () => {
  it("starts with the team's notes on the wall", () => {
    expect(TEAM_NOTES.length).toBeGreaterThanOrEqual(6);
  });

  it("pins a tidied, length-capped note and ignores blanks", () => {
    expect(pinNote([], "  ship   it  ")).toEqual(["ship it"]);
    expect(pinNote([], "x".repeat(200))[0]).toHaveLength(NOTE_LIMIT);
    expect(pinNote(["a"], "   ")).toEqual(["a"]);
  });

  it("keeps only your latest few notes", () => {
    let notes: readonly string[] = [];
    for (let index = 0; index < OWN_NOTES_KEPT + 3; index += 1) notes = pinNote(notes, `note ${index}`);
    expect(notes).toHaveLength(OWN_NOTES_KEPT);
    expect(notes.at(-1)).toBe(`note ${OWN_NOTES_KEPT + 2}`);
  });

  it("remembers your notes between visits, and copes with a missing or corrupt store", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    new BrowserNoteStore(storage).save(["mine"]);
    expect(new BrowserNoteStore(storage).load()).toEqual(["mine"]);
    storage.setItem("sev1.sticky-notes.v1", "{not json");
    expect(new BrowserNoteStore(storage).load()).toEqual([]);
    expect(new BrowserNoteStore(undefined).load()).toEqual([]);
  });
});

describe("stand-up", () => {
  it("pings, runs for a while, then it's over", () => {
    expect(standupPhase(STANDUP.pingAt - 1)).toBe("not-yet");
    expect(standupPhase(STANDUP.pingAt)).toBe("on");
    expect(standupPhase(STANDUP.pingAt + STANDUP.openFor)).toBe("over");
  });

  it("keeps it short when something is on fire, and names you", () => {
    const calm = standupScript(false, "Junior Engineer");
    const burning = standupScript(true, "Junior Engineer");
    expect(burning.length).toBeLessThan(calm.length);
    expect(calm.join(" ")).toContain("junior engineer");
  });
});
