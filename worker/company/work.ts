/**
 * Daily company work on the server: each member's board for the UTC day, built from what the server
 * knows (role, category, level, past work), and one graded attempt per task. Answers never leave here.
 */
import { gradeWork, todaysWork, workQuestion, type WorkResult } from "../../src/domain/work/daily.ts";
import type { Task, TaskAnswer } from "../../src/domain/work/task.ts";
import { WorkItemSchema, type WorkBoard, type WorkItem } from "../../src/storage/company-protocol.ts";
import { levelOf, type Caller, type CompanyProblem, type CompanyService, type Outcome } from "./service.ts";
import type { CompanyView } from "./store.ts";
import type { WorkStore } from "./work-store.ts";

export type WorkDeps = {
  readonly store: WorkStore;
  /** The caller's own company (expired unfunded ones dropped). */
  readonly company: Pick<CompanyService, "companyFor">;
  /** The task library boards are drawn from and graded against. */
  readonly tasks: readonly Task[];
  readonly now: () => number;
  readonly newId: () => string;
  readonly isOverLimit: (key: string) => Promise<boolean>;
};

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A task as the wire carries it: the answer-free question, and the graded result once there is one. */
function itemOf(task: Task, day: string, result: WorkResult | null): WorkItem {
  return WorkItemSchema.parse({ question: workQuestion(task, day), result });
}

type Seat = { readonly view: CompanyView; readonly board: readonly Task[]; readonly day: string };

export class WorkService {
  private readonly deps: WorkDeps;

  constructor(deps: WorkDeps) {
    this.deps = deps;
  }

  async board(caller: Caller): Promise<Outcome<WorkBoard>> {
    const seat = await this.seat(caller);
    if (!seat.ok) return seat;
    const { view, board, day } = seat.value;
    const answered = new Map((await this.deps.store.answeredOn(caller.id, day)).map((row) => [row.taskId, row.result]));
    return ok({
      day,
      items: board.map((task) => itemOf(task, day, answered.get(task.id) ?? null)),
      shippedSinceClose: await this.deps.store.unsettledShippedCount(view.company.id),
    });
  }

  /** One attempt per task per day; the answer must fit a task on the caller's board today. */
  async answer(caller: Caller, taskId: string, answer: TaskAnswer): Promise<Outcome<WorkItem>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const seat = await this.seat(caller);
    if (!seat.ok) return seat;
    const { view, board, day } = seat.value;
    const task = board.find((candidate) => candidate.id === taskId);
    if (!task) return fail("not_on_board");
    if ((await this.deps.store.answeredOn(caller.id, day)).some((row) => row.taskId === taskId)) return fail("already_answered");
    const result = gradeWork(task, day, answer);
    if (!result) return fail("invalid");
    const isNew = await this.deps.store.record({ id: this.deps.newId(), companyId: view.company.id, userId: caller.id, taskId, day, result, answeredAt: this.deps.now() });
    if (!isNew) return fail("already_answered");
    return ok(itemOf(task, day, result));
  }

  /** The caller's active company, and their board for today from the server's own record of them. */
  private async seat(caller: Caller): Promise<Outcome<Seat>> {
    const view = await this.deps.company.companyFor(caller.id);
    const member = view?.members.find((candidate) => candidate.userId === caller.id);
    if (!view || !member) return fail("not_in_company");
    if (view.company.state !== "active") return fail("not_active");
    const day = utcDay(this.deps.now());
    // Only earlier days count as finished, so answering today never reshuffles today's board.
    const finishedIds = new Set(await this.deps.store.finishedBefore(caller.id, day));
    const board = todaysWork(this.deps.tasks, { role: member.role, category: view.company.category, level: levelOf(view).level, day, finishedIds });
    return ok({ view, board, day });
  }
}
