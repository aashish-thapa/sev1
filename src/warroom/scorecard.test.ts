import { describe, expect, it } from "vitest";
import { EMPTY_SCORECARD, mostValuable, recordCommand, recordEarlyDeclare, rootCauseShift, type Engineer } from "./scorecard.ts";

const maya: Engineer = { playerId: "p1", name: "Maya", role: "infrastructure" };
const theo: Engineer = { playerId: "p2", name: "Theo", role: "security" };
const look = { didChangeCluster: false, rootCause: "unchanged" } as const;
const change = { didChangeCluster: true, rootCause: "unchanged" } as const;
const fix = { didChangeCluster: true, rootCause: "fixed" } as const;

describe("scorecard", () => {
  it("counts commands and changes per engineer", () => {
    const card = recordCommand(recordCommand(recordCommand(EMPTY_SCORECARD, maya, look), maya, change), theo, look);
    expect(card).toEqual([
      { ...maya, commands: 2, changes: 1, earlyDeclares: 0, isFixer: false },
      { ...theo, commands: 1, changes: 0, earlyDeclares: 0, isFixer: false },
    ]);
  });

  it("credits whoever fixed the root cause last, and nobody once it's back", () => {
    const fixedByMaya = recordCommand(EMPTY_SCORECARD, maya, fix);
    const fixedByTheo = recordCommand(fixedByMaya, theo, fix);
    expect(fixedByTheo.filter((tally) => tally.isFixer).map((tally) => tally.name)).toEqual(["Theo"]);
    const broken = recordCommand(fixedByTheo, maya, { didChangeCluster: true, rootCause: "reintroduced" });
    expect(broken.some((tally) => tally.isFixer)).toBe(false);
  });

  it("names the fixer most valuable, else the busiest hands, else nobody", () => {
    expect(mostValuable(EMPTY_SCORECARD)).toBeNull();
    const busy = recordCommand(recordCommand(recordCommand(EMPTY_SCORECARD, maya, look), maya, look), theo, change);
    expect(mostValuable(busy)?.name).toBe("Theo");
    expect(mostValuable(recordCommand(busy, maya, fix))?.name).toBe("Maya");
  });

  it("counts a turned-down resolve against the engineer who called it", () => {
    expect(recordEarlyDeclare(EMPTY_SCORECARD, maya)[0]?.earlyDeclares).toBe(1);
  });

  it("reads a shift from the scenario's verdict before and after", () => {
    expect(rootCauseShift(false, true)).toBe("fixed");
    expect(rootCauseShift(true, false)).toBe("reintroduced");
    expect(rootCauseShift(true, true)).toBe("unchanged");
  });
});
