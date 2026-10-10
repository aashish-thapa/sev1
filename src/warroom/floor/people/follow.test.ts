import { describe, expect, it } from "vitest";
import { follow, STILL_SPEED, type Follower } from "./follow.ts";

const FRAME = 1 / 60;

/** A teammate walking +x at `speed`, reported every `intervalMs`, watched for `seconds` at 60 fps. */
function watch(speed: number, intervalMs: number, seconds: number): Follower {
  let body: Follower = { x: 0, z: 0, speed: 0 };
  let reported = { x: 0, z: 0 };
  for (let frame = 1; frame <= seconds / FRAME; frame += 1) {
    const time = frame * FRAME;
    if (Math.floor(time * 1000 / intervalMs) !== Math.floor((time - FRAME) * 1000 / intervalMs)) reported = { x: speed * time, z: 0 };
    body = follow(body, reported, FRAME);
  }
  return body;
}

describe("follow", () => {
  it("measures a walking teammate at roughly their real speed from 10 Hz presence", () => {
    const body = watch(2.6, 100, 3);
    expect(body.speed).toBeGreaterThan(2.0);
    expect(body.speed).toBeLessThan(3.2);
  });

  it("settles to standing once the reports stop moving", () => {
    let body = watch(2.6, 100, 2);
    for (let frame = 0; frame < 120; frame += 1) body = follow(body, { x: body.x, z: 0 }, FRAME);
    expect(body.speed).toBeLessThan(STILL_SPEED);
  });

  it("ignores frames with no elapsed time", () => {
    const body = { x: 1, z: 2, speed: 3 };
    expect(follow(body, { x: 9, z: 9 }, 0)).toBe(body);
  });
});
