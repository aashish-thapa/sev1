import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskLibrary } from "../../content/task-library.ts";
import { ROLE_IDS } from "../incident.ts";
import { gradeCodeFix, gradeReview, isDone, presentFixes, tasksForDay, type CodeFixTask, type PrReviewTask } from "./task.ts";

const dir = join(import.meta.dirname, "..", "..", "content", "tasks");
const tasks = createTaskLibrary(
  Object.fromEntries(readdirSync(dir).map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown])),
  ({ path, message }) => {
    throw new Error(`${path}: ${message}`);
  },
);
const fix = tasks.find((task): task is CodeFixTask => task.kind === "code-fix")!;
const flawed = tasks.find((task): task is PrReviewTask => task.kind === "pr-review" && task.verdict === "request-changes")!;
const clean = tasks.find((task): task is PrReviewTask => task.kind === "pr-review" && task.verdict === "approve")!;

describe("daily work tasks", () => {
  it("gives every role both kinds of task, and every role a clean PR to approve", () => {
    for (const role of ROLE_IDS) {
      const mine = tasks.filter((task) => task.role === role);
      expect(mine.some((task) => task.kind === "code-fix"), role).toBe(true);
      expect(mine.some((task) => task.kind === "pr-review" && task.verdict === "approve"), role).toBe(true);
      expect(mine.some((task) => task.kind === "pr-review" && task.verdict === "request-changes"), role).toBe(true);
    }
  });

  it("ships a fix only for the right line and the right patch", () => {
    expect(gradeCodeFix(fix, fix.bugLine, fix.fixAnswer)).toBe("shipped");
    expect(gradeCodeFix(fix, fix.bugLine + 1, fix.fixAnswer)).toBe("wrong-line");
    expect(gradeCodeFix(fix, fix.bugLine, (fix.fixAnswer + 1) % fix.fixes.length)).toBe("wrong-fix");
  });

  it("grades reviews on the verdict, and on the line for a requested change", () => {
    expect(gradeReview(flawed, "request-changes", flawed.flaw)).toBe("correct");
    expect(gradeReview(flawed, "approve", null)).toBe("shipped-a-bug");
    expect(gradeReview(flawed, "request-changes", (flawed.flaw ?? 0) + 1)).toBe("wrong-line");
    expect(gradeReview(clean, "approve", null)).toBe("correct");
    expect(gradeReview(clean, "request-changes", 0)).toBe("blocked-a-good-pr");
    expect(isDone("correct") && isDone("shipped") && !isDone("wrong-line")).toBe(true);
  });

  it("doesn't always put the right fix first", () => {
    const firsts = new Set(tasks.filter((task): task is CodeFixTask => task.kind === "code-fix").map((task) => presentFixes(task, "2026-10-10").order.indexOf(task.fixAnswer)));
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("plans the same tasks all day, unfinished ones first, and only for the company's category", () => {
    const today = tasksForDay(tasks, "frontend", "social", "2026-10-10", new Set(), 3);
    expect(tasksForDay(tasks, "frontend", "social", "2026-10-10", new Set(), 3)).toEqual(today);
    expect(today.every((task) => task.role === "frontend" && (task.categories.length === 0 || task.categories.includes("social")))).toBe(true);
    const afterOne = tasksForDay(tasks, "frontend", "social", "2026-10-10", new Set([today[0].id]), 3);
    expect(afterOne[0].id).not.toBe(today[0].id);
  });
});
