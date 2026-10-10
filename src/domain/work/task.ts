/**
 * Daily work that isn't a page: fixing a bug from a failing test, and reviewing a pull request.
 * Each task belongs to one role; a company's members get their role's tasks every work day.
 */
import { z } from "zod";
import { CATEGORY_IDS, type CategoryId } from "../company/catalog.ts";
import { seededRandom, shuffled } from "../random.ts";
import { ROLE_IDS, type Role } from "../incident.ts";

const RoleSchema = z.enum(ROLE_IDS as [Role, ...Role[]]);
const Language = z.enum(["go", "ts", "tsx", "py", "sql", "kotlin", "swift", "yaml", "json"]);
const CodeLine = z.string().max(140);

const TaskBase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  role: RoleSchema,
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Categories it fits; empty means every category. */
  categories: z.array(z.enum(CATEGORY_IDS)).default([]),
  title: z.string().min(8).max(90),
  /** Shown after the answer: what was wrong, and why it mattered. */
  explanation: z.object({ cause: z.string().min(10).max(220), why: z.string().min(10).max(420) }),
});

export const CodeFixTaskSchema = TaskBase.extend({
  kind: z.literal("code-fix"),
  /** The bug report, in the reporter's words. */
  ticket: z.string().min(20).max(400),
  file: z.object({ path: z.string().max(80), language: Language, lines: z.array(CodeLine).min(4).max(32) }),
  failing: z.object({ test: z.string().max(120), output: z.array(CodeLine).min(1).max(8) }),
  /** Index into file.lines of the line to fix. */
  bugLine: z.int().nonnegative(),
  /** Replacements for the bug line; exactly one is right. */
  fixes: z.array(CodeLine).min(3).max(4),
  fixAnswer: z.int().nonnegative(),
});

const DiffLine = z.object({ op: z.enum(["+", "-", " "]), text: CodeLine });

export const PrReviewTaskSchema = TaskBase.extend({
  kind: z.literal("pr-review"),
  author: z.string().max(40),
  /** The PR description, as its author wrote it. */
  description: z.string().min(20).max(500),
  path: z.string().max(80),
  language: Language,
  diff: z.array(DiffLine).min(4).max(40),
  verdict: z.enum(["approve", "request-changes"]),
  /** With request-changes: the index into diff of the added line that breaks it. */
  flaw: z.int().nonnegative().nullable(),
});

export const TaskSchema = z.discriminatedUnion("kind", [CodeFixTaskSchema, PrReviewTaskSchema]).superRefine((task, ctx) => {
  if (task.kind === "code-fix") {
    if (task.bugLine >= task.file.lines.length) ctx.addIssue({ code: "custom", path: ["bugLine"], message: "bugLine is past the last line" });
    if (task.fixAnswer >= task.fixes.length) ctx.addIssue({ code: "custom", path: ["fixAnswer"], message: "fixAnswer is past the last fix" });
    if (new Set(task.fixes).size !== task.fixes.length) ctx.addIssue({ code: "custom", path: ["fixes"], message: "fixes must all differ" });
    if (task.fixes.includes(task.file.lines[task.bugLine] ?? "")) ctx.addIssue({ code: "custom", path: ["fixes"], message: "a fix can't be the line unchanged" });
  } else {
    if (task.verdict === "approve" && task.flaw !== null) ctx.addIssue({ code: "custom", path: ["flaw"], message: "an approvable PR has no flaw" });
    if (task.verdict === "request-changes") {
      const line = task.flaw === null ? undefined : task.diff[task.flaw];
      if (!line || line.op !== "+") ctx.addIssue({ code: "custom", path: ["flaw"], message: "flaw must point at an added line" });
    }
  }
});

export const TaskPackSchema = z.array(TaskSchema).min(1);
export type Task = z.output<typeof TaskSchema>;
export type CodeFixTask = Extract<Task, { kind: "code-fix" }>;
export type PrReviewTask = Extract<Task, { kind: "pr-review" }>;

export type CodeFixOutcome = "shipped" | "wrong-line" | "wrong-fix";

/** Right line and right fix ships it; the right line with the wrong fix goes back from review. */
export function gradeCodeFix(task: CodeFixTask, line: number, fix: number): CodeFixOutcome {
  if (line !== task.bugLine) return "wrong-line";
  return fix === task.fixAnswer ? "shipped" : "wrong-fix";
}

export type ReviewOutcome = "correct" | "shipped-a-bug" | "blocked-a-good-pr" | "wrong-line";

/** A review is right when the verdict is, and a requested change points at the line that breaks it. */
export function gradeReview(task: PrReviewTask, verdict: PrReviewTask["verdict"], flaggedLine: number | null): ReviewOutcome {
  if (task.verdict === "approve") return verdict === "approve" ? "correct" : "blocked-a-good-pr";
  if (verdict === "approve") return "shipped-a-bug";
  return flaggedLine === task.flaw ? "correct" : "wrong-line";
}

export function isDone(outcome: CodeFixOutcome | ReviewOutcome): boolean {
  return outcome === "shipped" || outcome === "correct";
}

/** The fixes in a fixed shuffled order for this task and day, with where the right one landed. */
export function presentFixes(task: CodeFixTask, day: string): { readonly fixes: readonly string[]; readonly order: readonly number[] } {
  const order = shuffled(
    task.fixes.map((_, index) => index),
    seededRandom(`${day}:${task.id}`),
  );
  return { fixes: order.map((index) => task.fixes[index]), order };
}

/** Today's tasks for a role: ones the player hasn't finished first, fitting the company's category, in a fixed order for the day. */
export function tasksForDay(tasks: readonly Task[], role: Role, category: CategoryId | null, day: string, finishedIds: ReadonlySet<string>, count: number): Task[] {
  const fits = tasks.filter((task) => task.role === role && (category === null || task.categories.length === 0 || task.categories.includes(category)));
  const random = seededRandom(`work:${role}:${day}`);
  const fresh = shuffled(
    fits.filter((task) => !finishedIds.has(task.id)),
    random,
  );
  const seen = shuffled(
    fits.filter((task) => finishedIds.has(task.id)),
    random,
  );
  return [...fresh, ...seen].slice(0, count);
}
