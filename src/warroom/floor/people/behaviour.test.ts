import { describe, expect, it } from "vitest";
import { avatarFor } from "./avatars.ts";
import { motionFor } from "./behaviour.ts";

describe("motionFor", () => {
  it("walks calmly, then hurries once the floor panics", () => {
    expect(motionFor({ state: "walking", speed: 1.25 }, 0.1, false)).toEqual({ clip: "walk", speed: 1.25 });
    expect(motionFor({ state: "walking", speed: 1.25 }, 0.8, false).clip).toBe("hurry");
  });

  it("keeps panic body language off for reduced motion", () => {
    expect(motionFor({ state: "walking", speed: 1.25 }, 0.9, true).clip).toBe("walk");
    expect(motionFor({ state: "standing", activity: "waiting" }, 0.9, true).clip).toBe("idle");
  });

  it("gives standing people their activity's clip and seated people the desk", () => {
    expect(motionFor({ state: "standing", activity: "on-phone" }, 0, false).clip).toBe("phone");
    expect(motionFor({ state: "standing", activity: "presenting" }, 0, false).clip).toBe("talk");
    expect(motionFor({ state: "standing", activity: "waiting" }, 0.7, false).clip).toBe("talk-nervous");
    expect(motionFor({ state: "seated" }, 1, false).clip).toBe("desk");
  });
});

describe("avatarFor", () => {
  it("gives the same teammate the same look every time", () => {
    expect(avatarFor("ana-123")).toBe(avatarFor("ana-123"));
  });
});
