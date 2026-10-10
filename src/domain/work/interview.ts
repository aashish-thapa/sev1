/**
 * A hiring interview: three tasks for the role, sent to the candidate without their answers and
 * graded on the server against a key the candidate never sees. Pure: the server picks, strips and grades.
 */
import { seededRandom, shuffled } from "../random.ts";
import { atDifficulty, type TaskDifficulty } from "../company/levels.ts";
import type { Role } from "../incident.ts";
import { gradeCodeFix, gradeReview, isDone, type CodeFixTask, type PrReviewTask, type Task } from "./task.ts";

export const INTERVIEW_LENGTH = 3;

/** A bug fix as a candidate sees it: no bug line, patches in the order the key records. */
export type CodeFixQuestion = Pick<CodeFixTask, "kind" | "id" | "title" | "ticket" | "file" | "failing"> & { readonly fixes: readonly string[] };
/** A PR as a candidate sees it: no verdict, no flaw, no explanation. */
export type ReviewQuestion = Pick<PrReviewTask, "kind" | "id" | "title" | "author" | "description" | "path" | "language" | "diff">;
export type InterviewQuestion = CodeFixQuestion | ReviewQuestion;

/** What the server keeps to grade with: each question's task, and for a bug fix the order its patches were shown in. */
export type InterviewKey = readonly { readonly taskId: string; readonly fixOrder: readonly number[] | null }[];

export type InterviewAnswer =
  | { readonly taskId: string; readonly kind: "code-fix"; readonly line: number; readonly fix: number }
  | { readonly taskId: string; readonly kind: "pr-review"; readonly verdict: "approve" | "request-changes"; readonly flaggedLine: number | null };

/**
 * Picks the interview for `role` at a posting's difficulty: a bug fix and a review when the library
 * has both, the rest at random, each bug fix's patches shuffled. `seed` makes it reproducible.
 */
export function buildInterview(tasks: readonly Task[], role: Role, difficulties: readonly TaskDifficulty[], seed: string): { questions: InterviewQuestion[]; key: InterviewKey } {
  const random = seededRandom(`interview:${seed}`);
  const pool = shuffled(atDifficulty(tasks.filter((task) => task.role === role), difficulties), random);
  const firstFix = pool.find((task) => task.kind === "code-fix");
  const firstReview = pool.find((task) => task.kind === "pr-review");
  const picked = [firstFix, firstReview].filter((task): task is Task => task !== undefined);
  for (const task of pool) if (picked.length < INTERVIEW_LENGTH && !picked.includes(task)) picked.push(task);

  const questions: InterviewQuestion[] = [];
  const key: { taskId: string; fixOrder: number[] | null }[] = [];
  for (const task of picked) {
    if (task.kind === "code-fix") {
      const order = shuffled(task.fixes.map((_, index) => index), random);
      questions.push({ kind: task.kind, id: task.id, title: task.title, ticket: task.ticket, file: task.file, failing: task.failing, fixes: order.map((index) => task.fixes[index]) });
      key.push({ taskId: task.id, fixOrder: order });
    } else {
      questions.push({ kind: task.kind, id: task.id, title: task.title, author: task.author, description: task.description, path: task.path, language: task.language, diff: task.diff });
      key.push({ taskId: task.id, fixOrder: null });
    }
  }
  return { questions, key };
}

export type InterviewResult = { readonly correct: number; readonly total: number; /** 0…100, rounded. */ readonly score: number };

/** Grades answers against the key: unanswered or unknown questions count as wrong. */
export function gradeInterview(tasks: readonly Task[], key: InterviewKey, answers: readonly InterviewAnswer[]): InterviewResult {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let correct = 0;
  for (const entry of key) {
    const task = byId.get(entry.taskId);
    const answer = answers.find((candidate) => candidate.taskId === entry.taskId);
    if (!task || !answer || answer.kind !== task.kind) continue;
    if (task.kind === "code-fix" && answer.kind === "code-fix") {
      const shown = entry.fixOrder?.[answer.fix];
      if (shown !== undefined && isDone(gradeCodeFix(task, answer.line, shown))) correct += 1;
    } else if (task.kind === "pr-review" && answer.kind === "pr-review") {
      if (isDone(gradeReview(task, answer.verdict, answer.flaggedLine))) correct += 1;
    }
  }
  const total = key.length;
  return { correct, total, score: total === 0 ? 0 : Math.round((correct / total) * 100) };
}
