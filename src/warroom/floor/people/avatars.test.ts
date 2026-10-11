import { describe, expect, it } from "vitest";
import { avatarFor, wornAvatar } from "./avatars.ts";

describe("wornAvatar", () => {
  it("wears the chosen body, and falls back to the seeded one for none or a body this build doesn't have", () => {
    expect(wornAvatar("Female_Adult_05", "p1")).toBe("Female_Adult_05");
    expect(wornAvatar(null, "p1")).toBe(avatarFor("p1"));
    expect(wornAvatar("Robot_9000", "p1")).toBe(avatarFor("p1"));
  });
});
