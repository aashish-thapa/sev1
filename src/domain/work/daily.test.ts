import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskLibrary } from "../../content/task-library.ts";
import { difficultiesFor } from "../company/levels.ts";
import { gradeWork, TASKS_PER_DAY, todaysWork, workQuestion } from "./daily.ts";
import { presentFixes, type CodeFixTask, type PrReviewTask } from "./task.ts";

const dir = join(import.meta.dirname, "..", "..", "content", "tasks");
const tasks = createTaskLibrary(Object.fromEntries(readdirSync(dir).map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown])));
const context = { role: "infrastructure", category: "ecommerce", level: 1, day: "2026-10-11", finishedIds: new Set<string>() } as const;

describe("daily work", () => {
  it("deals the day's tasks at the company level's difficulty, the same all day", () => {
    const board = todaysWork(tasks, context);
    expect(board).toHaveLength(TASKS_PER_DAY);
    expect(board.every((task) => task.role === "infrastructure" && difficultiesFor(1).includes(task.difficulty))).toBe(true);
    expect(todaysWork(tasks, context)).toEqual(board);
    const scale = todaysWork(tasks, { ...context, level: 5 });
    expect(scale.every((task) => task.difficulty === 3)).toBe(true);
  });

  it("sends questions without answers", () => {
    for (const task of todaysWork(tasks, context)) {
      const question = workQuestion(task, context.day);
      for (const field of ["bugLine", "fixAnswer", "verdict", "flaw", "explanation"]) expect(question).not.toHaveProperty(field);
    }
  });

  it("grades through the day's patch order and reveals the line afterwards", () => {
    const fix = tasks.find((task): task is CodeFixTask => task.kind === "code-fix")!;
    const shown = presentFixes(fix, context.day).order.indexOf(fix.fixAnswer);
    const right = gradeWork(fix, context.day, { taskId: fix.id, kind: "code-fix", line: fix.bugLine, fix: shown });
    expect(right).toMatchObject({ outcome: "shipped", isDone: true, reveal: { line: fix.bugLine } });
    const wrong = gradeWork(fix, context.day, { taskId: fix.id, kind: "code-fix", line: fix.bugLine, fix: (shown + 1) % fix.fixes.length });
    expect(wrong).toMatchObject({ outcome: "wrong-fix", isDone: false });
  });

  it("refuses answers that don't fit the task", () => {
    const fix = tasks.find((task): task is CodeFixTask => task.kind === "code-fix")!;
    const review = tasks.find((task): task is PrReviewTask => task.kind === "pr-review")!;
    expect(gradeWork(fix, context.day, { taskId: "other", kind: "code-fix", line: 0, fix: 0 })).toBeNull();
    expect(gradeWork(fix, context.day, { taskId: fix.id, kind: "code-fix", line: 0, fix: 99 })).toBeNull();
    expect(gradeWork(fix, context.day, { taskId: fix.id, kind: "code-fix", line: 999, fix: 0 })).toBeNull();
    expect(gradeWork(review, context.day, { taskId: review.id, kind: "pr-review", verdict: "request-changes", flaggedLine: 999 })).toBeNull();
    expect(gradeWork(review, context.day, { taskId: review.id, kind: "code-fix", line: 0, fix: 0 })).toBeNull();
  });
});
