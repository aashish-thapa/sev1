import { describe, expect, it } from "vitest";
import { trackLoading } from "./boot.ts";

describe("tracking what the first screen waits on", () => {
  it("reports the share settled after each task", async () => {
    const seen: number[] = [];
    await trackLoading([Promise.resolve(), Promise.resolve(), Promise.resolve(), Promise.resolve()], (fraction) => seen.push(fraction));
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("counts a failed task as done, so loading never hangs on it", async () => {
    const seen: number[] = [];
    await trackLoading([Promise.reject(new Error("chunk missing")), Promise.resolve()], (fraction) => seen.push(fraction));
    expect(seen.at(-1)).toBe(1);
  });

  it("is complete at once with nothing to wait on", async () => {
    const seen: number[] = [];
    await trackLoading([], (fraction) => seen.push(fraction));
    expect(seen).toEqual([1]);
  });
});
