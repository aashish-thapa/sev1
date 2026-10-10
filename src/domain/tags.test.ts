import { describe, expect, it } from "vitest";
import { isAdmin, knownTags, shownTags } from "./tags.ts";

describe("granted tags", () => {
  it("shows Creator but never a permission or an unknown id", () => {
    expect(knownTags(["admin", "creator", "made-up"]).map((tag) => tag.label)).toEqual(["Creator"]);
    expect(shownTags(["admin", "creator", "made-up"])).toEqual(["creator"]);
    expect(shownTags(["admin"])).toEqual([]);
  });

  it("recognises admin from the account's own tags", () => {
    expect(isAdmin(["creator", "admin"])).toBe(true);
    expect(isAdmin(["creator"])).toBe(false);
  });
});
