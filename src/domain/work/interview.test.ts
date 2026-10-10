import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskLibrary } from "../../content/task-library.ts";
import { atDifficulty, companyLevel, difficultiesFor } from "../company/levels.ts";
import { buildInterview, gradeInterview, INTERVIEW_LENGTH, type InterviewAnswer } from "./interview.ts";
import type { CodeFixTask, PrReviewTask } from "./task.ts";

const dir = join(import.meta.dirname, "..", "..", "content", "tasks");
const tasks = createTaskLibrary(Object.fromEntries(readdirSync(dir).map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown])));

describe("company levels", () => {
  it("climbs only when both revenue and work days are met", () => {
    expect(companyLevel({ lifetimeRevenueCents: 0, workDays: 0 }).title).toBe("Garage");
    expect(companyLevel({ lifetimeRevenueCents: 10_000_000, workDays: 3 }).title).toBe("Garage");
    expect(companyLevel({ lifetimeRevenueCents: 600_000, workDays: 6 }).title).toBe("Seed");
    expect(companyLevel({ lifetimeRevenueCents: 50_000_000, workDays: 100 })).toMatchObject({ level: 5, next: null });
  });

  it("gives a garage easy work and falls back to the hardest available when a level outruns the library", () => {
    expect(atDifficulty(tasks, difficultiesFor(1)).every((task) => task.difficulty === 1)).toBe(true);
    const scale = atDifficulty(tasks, difficultiesFor(5));
    expect(scale.length).toBeGreaterThan(0);
    expect(new Set(scale.map((task) => task.difficulty)).size).toBe(1);
  });
});

describe("interviews", () => {
  const { questions, key } = buildInterview(tasks, "infrastructure", [1, 2], "posting-1:maya");

  it("asks three questions, a bug fix and a review among them, with no answers attached", () => {
    expect(questions).toHaveLength(INTERVIEW_LENGTH);
    expect(questions.some((question) => question.kind === "code-fix")).toBe(true);
    expect(questions.some((question) => question.kind === "pr-review")).toBe(true);
    for (const question of questions) {
      for (const field of ["bugLine", "fixAnswer", "verdict", "flaw", "explanation"]) expect(question).not.toHaveProperty(field);
    }
  });

  it("is the same interview for the same seed", () => {
    expect(buildInterview(tasks, "infrastructure", [1, 2], "posting-1:maya")).toEqual({ questions, key });
  });

  it("scores right answers against the key, through the shuffled patch order", () => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const perfect: InterviewAnswer[] = key.map((entry) => {
      const task = byId.get(entry.taskId)!;
      if (task.kind === "code-fix") {
        const fix = task as CodeFixTask;
        return { taskId: fix.id, kind: "code-fix", line: fix.bugLine, fix: entry.fixOrder!.indexOf(fix.fixAnswer) };
      }
      const review = task as PrReviewTask;
      return { taskId: review.id, kind: "pr-review", verdict: review.verdict, flaggedLine: review.flaw };
    });
    expect(gradeInterview(tasks, key, perfect)).toEqual({ correct: 3, total: 3, score: 100 });
    expect(gradeInterview(tasks, key, perfect.slice(1))).toMatchObject({ correct: 2, score: 67 });
    expect(gradeInterview(tasks, key, [])).toMatchObject({ correct: 0, score: 0 });
  });
});
