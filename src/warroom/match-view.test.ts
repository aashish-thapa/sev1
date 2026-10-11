import { describe, expect, it } from "vitest";
import { formatAlertRate, formatCountdown, outcomeFor } from "./match-view.ts";

describe("match view", () => {
  it("reads a decided match from the player's side", () => {
    expect(outcomeFor("red", "red")).toBe("won");
    expect(outcomeFor("red", "blue")).toBe("lost");
    expect(outcomeFor("draw", "blue")).toBe("draw");
    expect(outcomeFor("blue", null)).toBe("watched");
  });

  it("shows overtime as m:ss, rounding a part-second up", () => {
    expect(formatCountdown(180_000)).toBe("3:00");
    expect(formatCountdown(61_001)).toBe("1:02");
    expect(formatCountdown(400)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-50)).toBe("0:00");
  });

  it("shows the alert rate as a whole percentage", () => {
    expect(formatAlertRate(0.274)).toBe("27%");
    expect(formatAlertRate(1)).toBe("100%");
  });
});
