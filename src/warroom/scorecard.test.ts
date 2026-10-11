import { describe, expect, it } from "vitest";
import { EMPTY_SCORECARD, mostValuable, recordCommand, recordEarlyDeclare, recordRootCause, rootCauseShift, type Engineer } from "./scorecard.ts";

const maya: Engineer = { playerId: "p1", name: "Maya", role: "infrastructure" };
const theo: Engineer = { playerId: "p2", name: "Theo", role: "security" };
const look = false;
const change = true;

describe("scorecard", () => {
  it("counts commands and changes per engineer", () => {
    const card = recordCommand(recordCommand(recordCommand(EMPTY_SCORECARD, maya, look), maya, change), theo, look);
    expect(card).toEqual([
      { ...maya, commands: 2, changes: 1, earlyDeclares: 0, isFixer: false },
      { ...theo, commands: 1, changes: 0, earlyDeclares: 0, isFixer: false },
    ]);
  });

  it("credits whoever last changed the cluster when the cause goes away, and nobody once it's back", () => {
    const fixedByMaya = recordRootCause(recordCommand(EMPTY_SCORECARD, maya, change), "fixed", maya);
    const fixedByTheo = recordRootCause(fixedByMaya, "fixed", theo);
    expect(fixedByTheo.filter((tally) => tally.isFixer).map((tally) => tally.name)).toEqual(["Theo"]);
    expect(recordRootCause(fixedByTheo, "unchanged", maya)).toBe(fixedByTheo);
    expect(recordRootCause(fixedByTheo, "reintroduced", maya).some((tally) => tally.isFixer)).toBe(false);
  });

  it("credits nobody when only colleagues touched the cluster", () => {
    expect(recordRootCause(recordCommand(EMPTY_SCORECARD, maya, look), "fixed", null).some((tally) => tally.isFixer)).toBe(false);
  });

  it("names the fixer most valuable, else the busiest hands, else nobody", () => {
    expect(mostValuable(EMPTY_SCORECARD)).toBeNull();
    const busy = recordCommand(recordCommand(recordCommand(EMPTY_SCORECARD, maya, look), maya, look), theo, change);
    expect(mostValuable(busy)?.name).toBe("Theo");
    expect(mostValuable(recordRootCause(busy, "fixed", maya))?.name).toBe("Maya");
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
