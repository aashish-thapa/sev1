/**
 * A hiring interview: three tasks for the role, sent to the candidate without their answers and
 * graded on the server against a key the candidate never sees. Pure: the server picks, strips and grades.
 */
import { seededRandom, shuffled } from "../random.ts";
import { atDifficulty, type TaskDifficulty } from "../company/levels.ts";
import type { Role } from "../incident.ts";
import { asQuestion, gradeCodeFix, gradeReview, isDone, type Task, type TaskAnswer, type TaskQuestion } from "./task.ts";

export const INTERVIEW_LENGTH = 3;

export type InterviewQuestion = TaskQuestion;

/** What the server keeps to grade with: each question's task, and for a bug fix the order its patches were shown in. */
export type InterviewKey = readonly { readonly taskId: string; readonly fixOrder: readonly number[] | null }[];

export type InterviewAnswer = TaskAnswer;

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
    const order = task.kind === "code-fix" ? shuffled(task.fixes.map((_, index) => index), random) : null;
    questions.push(asQuestion(task, order));
    key.push({ taskId: task.id, fixOrder: order });
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

const DIFFICULTIES: readonly TaskDifficulty[] = [1, 2, 3];

/**
 * Where the library can't fill a full interview: every role needs, at every difficulty, enough
 * tasks for one interview with both a bug fix and a review. Otherwise pass marks would be off.
 */
export function interviewCoverageGaps(tasks: readonly Task[], roles: readonly Role[]): string[] {
  const gaps: string[] = [];
  for (const role of roles) {
    for (const difficulty of DIFFICULTIES) {
      const pool = tasks.filter((task) => task.role === role && task.difficulty === difficulty);
      const fixes = pool.filter((task) => task.kind === "code-fix").length;
      const reviews = pool.length - fixes;
      if (pool.length < INTERVIEW_LENGTH || fixes === 0 || reviews === 0) {
        gaps.push(`${role} at difficulty ${difficulty}: ${fixes} bug fixes and ${reviews} reviews; needs ${INTERVIEW_LENGTH} with at least one of each`);
      }
    }
  }
  return gaps;
}
