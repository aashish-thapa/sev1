/**
 * A member's daily work, decided and graded on the server: the board for the day, each task sent
 * without its answer, and one graded attempt per task. Pure; the server supplies the day and the record.
 */
import type { CategoryId } from "../company/catalog.ts";
import { atDifficulty, difficultiesFor, type CompanyLevel } from "../company/levels.ts";
import type { Role } from "../incident.ts";
import { asQuestion, gradeCodeFix, gradeReview, isDone, presentFixes, tasksForDay, type CodeFixOutcome, type ReviewOutcome, type Task, type TaskAnswer, type TaskQuestion } from "./task.ts";

/** Tasks on a member's board each work day. */
export const TASKS_PER_DAY = 3;

export type WorkContext = {
  readonly role: Role;
  readonly category: CategoryId;
  readonly level: CompanyLevel;
  /** The UTC day, YYYY-MM-DD: the board and each bug fix's patch order stay the same all day. */
  readonly day: string;
  /** Tasks this member has already shipped on earlier days, so fresh ones come first. */
  readonly finishedIds: ReadonlySet<string>;
};

/** The member's tasks for the day, at their company level's difficulty. */
export function todaysWork(tasks: readonly Task[], context: WorkContext): Task[] {
  const forRole = atDifficulty(
    tasks.filter((task) => task.role === context.role),
    difficultiesFor(context.level),
  );
  return tasksForDay(forRole, context.role, context.category, context.day, context.finishedIds, TASKS_PER_DAY);
}

/** A task as the board shows it; the patch order comes from the day, so nothing needs storing to grade it. */
export function workQuestion(task: Task, day: string): TaskQuestion {
  return asQuestion(task, task.kind === "code-fix" ? presentFixes(task, day).order : null);
}

export type WorkOutcome = CodeFixOutcome | ReviewOutcome;

export type WorkResult = {
  readonly outcome: WorkOutcome;
  readonly isDone: boolean;
  /** Shown once answered: the line that was the bug or the flaw (null for a clean PR), and why. */
  readonly reveal: { readonly line: number | null; readonly cause: string; readonly why: string };
};

/** Grades one attempt; null when the answer doesn't fit the task (a different id or kind, a patch that wasn't shown). */
export function gradeWork(task: Task, day: string, answer: TaskAnswer): WorkResult | null {
  if (answer.taskId !== task.id || answer.kind !== task.kind) return null;
  let outcome: WorkOutcome;
  if (task.kind === "code-fix" && answer.kind === "code-fix") {
    const shown = presentFixes(task, day).order[answer.fix];
    if (shown === undefined || answer.line < 0 || answer.line >= task.file.lines.length) return null;
    outcome = gradeCodeFix(task, answer.line, shown);
  } else if (task.kind === "pr-review" && answer.kind === "pr-review") {
    if (answer.flaggedLine !== null && (answer.flaggedLine < 0 || answer.flaggedLine >= task.diff.length)) return null;
    outcome = gradeReview(task, answer.verdict, answer.flaggedLine);
  } else {
    return null;
  }
  const line = task.kind === "code-fix" ? task.bugLine : task.flaw;
  return { outcome, isDone: isDone(outcome), reveal: { line, cause: task.explanation.cause, why: task.explanation.why } };
}
