import { describe, expect, it } from "vitest";
import { bite, BITES_PER_SNACK, grab, NO_SNACK, snackAt } from "./snack.ts";

describe("snack", () => {
  it("lasts BITES_PER_SNACK bites, then the hand is empty", () => {
    let snack = grab("apple");
    for (let index = 1; index < BITES_PER_SNACK; index += 1) snack = bite(snack);
    expect(snack).toEqual({ kind: "holding", item: "apple", bitesLeft: 1 });
    expect(bite(snack)).toBe(NO_SNACK);
    expect(bite(NO_SNACK)).toBe(NO_SNACK);
  });

  it("hands out the shelf's snacks in turn", () => {
    expect([0, 1, 2, 3].map(snackAt)).toEqual(["granola-bar", "apple", "chips", "granola-bar"]);
  });
});
