import { describe, expect, it } from "vitest";
import { AVATARS } from "../warroom/floor/assets/catalog.ts";
import { AVATAR_COUNT, avatarNumber, LookSchema, stepAvatar } from "./look.ts";

describe("looks", () => {
  it("defaults to no chosen body, standing idle", () => {
    expect(LookSchema.parse({})).toEqual({ avatar: null, pose: "idle" });
  });

  it("only takes catalog bodies and known poses", () => {
    expect(LookSchema.safeParse({ avatar: "Robot_9000" }).success).toBe(false);
    expect(LookSchema.safeParse({ pose: "dance" }).success).toBe(false);
  });

  it("walks the wardrobe both ways and wraps", () => {
    const first = AVATARS[0].id;
    const last = AVATARS[AVATARS.length - 1].id;
    expect(stepAvatar(last, 1)).toBe(first);
    expect(stepAvatar(first, -1)).toBe(last);
    expect(avatarNumber(stepAvatar(first, 1))).toBe(2);
    expect(AVATAR_COUNT).toBe(AVATARS.length);
  });
});
