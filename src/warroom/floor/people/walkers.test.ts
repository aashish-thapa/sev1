import { describe, expect, it } from "vitest";
import { loopThrough } from "../navigation.ts";
import { PEOPLE, type Person } from "../office.ts";
import { carriedAt, isAtPantry, walkerPose } from "./walkers.ts";

const walker = PEOPLE.find((person): person is Extract<Person, { kind: "walker" }> => person.id === "walker-coffee");

describe("walkers carrying things", () => {
  it("picks up a cup at the machine, carries it back, and goes for the next one empty-handed", () => {
    if (!walker) throw new Error("no coffee walker");
    const loop = loopThrough(walker.stops);
    const seen = new Set<string>();
    for (let second = 0; second < loop.duration; second += 0.25) {
      const pose = walkerPose(walker, loop, second);
      const carried = carriedAt(walker, pose);
      if (isAtPantry(walker, pose)) {
        expect(carried).toBeNull();
        seen.add("at-machine");
      } else if (carried === "cup") seen.add(pose.isWalking ? "walking-with-cup" : "at-desk-with-cup");
      else if (pose.isWalking) seen.add("walking-empty");
    }
    expect([...seen].sort()).toEqual(["at-desk-with-cup", "at-machine", "walking-empty", "walking-with-cup"]);
  });
});
