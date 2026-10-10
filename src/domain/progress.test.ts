import { describe, expect, it } from "vitest";
import { emptyProgress, recordWarRoomRun, warRoomPlays } from "./progress.ts";

describe("warRoomPlays", () => {
  it("counts every finished War Room across scenarios, so solo incidents rotate", () => {
    expect(warRoomPlays(emptyProgress())).toBe(0);
    const played = recordWarRoomRun(recordWarRoomRun(recordWarRoomRun(emptyProgress(), "a", 40, "C"), "a", 80, "A"), "b", 60, "B");
    expect(warRoomPlays(played)).toBe(3);
  });
});
