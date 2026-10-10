import { describe, expect, it } from "vitest";
import { presentFixes, type Task, type TaskAnswer } from "../../src/domain/work/task.ts";
import { WorkBoardSchema, WorkItemSchema } from "../../src/storage/company-protocol.ts";
import { MemoryCompanyStore } from "./memory-store.ts";
import { MemoryWorkStore } from "./memory-work-store.ts";
import { CompanyService } from "./service.ts";
import type { CompanyRow } from "./store.ts";
import { TASKS } from "./tasks.ts";
import { WorkService } from "./work.ts";

const START = Date.UTC(2026, 9, 10, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

function world() {
  let now = START;
  let ids = 0;
  const work = new MemoryWorkStore();
  const store = new MemoryCompanyStore(work);
  const deps = { now: () => now, newId: () => `id-${(ids += 1)}`, isOverLimit: async () => false };
  const companies = new CompanyService({ store, work, ...deps });
  const service = new WorkService({ store: work, company: companies, tasks: TASKS, ...deps });
  const row: CompanyRow = {
    id: "acme",
    name: "Acme",
    category: "ecommerce",
    founderId: "u1",
    state: "active",
    fundingRef: "fund:acme",
    fundingCents: 0,
    fundingExpiresAt: START,
    workDay: 0,
    lastSettledOn: null,
    createdAt: START,
  };
  return {
    work,
    store,
    companies,
    service,
    now: () => now,
    advance: (ms: number) => (now += ms),
    /** An active company with an infra founder and a frontend engineer, without the money flow (tested elsewhere). */
    async open() {
      store.addUser("u1", "maya");
      store.addUser("u2", "ben");
      await store.found(row, { role: "infrastructure", payCents: 12_000 });
      store.rooms.push({ companyId: "acme", id: "acme:bay", kind: "bay" });
      store.members.push({ companyId: "acme", userId: "u2", username: "ben", role: "frontend", payCents: 10_000, isFounder: false, joinedAt: START, canHire: false });
    },
  };
}

/** The right answer a strong engineer would give, read from the task itself. */
function rightAnswer(task: Task, day: string): TaskAnswer {
  if (task.kind === "code-fix") return { taskId: task.id, kind: "code-fix", line: task.bugLine, fix: presentFixes(task, day).order.indexOf(task.fixAnswer) };
  return { taskId: task.id, kind: "pr-review", verdict: task.verdict, flaggedLine: task.flaw };
}

async function boardOf(setup: ReturnType<typeof world>, userId: string) {
  const board = await setup.service.board({ id: userId });
  if (!board.ok) throw new Error(board.problem);
  return board.value;
}

const taskById = (id: string) => {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

describe("daily work board", () => {
  it("is built on the server from the member's company role, and never carries an answer", async () => {
    const setup = world();
    await setup.open();
    const board = WorkBoardSchema.parse(await boardOf(setup, "u2"));
    expect(board.day).toBe(dayOf(setup.now()));
    expect(board.items).toHaveLength(3);
    expect(board.items.every((item) => item.result === null)).toBe(true);
    expect(board.items.every((item) => taskById(item.question.id).role === "frontend")).toBe(true);
    const json = JSON.stringify(board);
    for (const forbidden of ["bugLine", "fixAnswer", "verdict", "flaw", "explanation"]) expect(json).not.toContain(`"${forbidden}"`);
  });

  it("is for members of an active company only", async () => {
    const setup = world();
    await setup.open();
    expect(await setup.service.board({ id: "stranger" })).toEqual({ ok: false, problem: "not_in_company" });
  });
});

describe("answering work", () => {
  it("grades one attempt per task, refuses a second, and shows the result on the board", async () => {
    const setup = world();
    await setup.open();
    const [first] = (await boardOf(setup, "u1")).items;
    const task = taskById(first.question.id);
    const answered = await setup.service.answer({ id: "u1" }, task.id, rightAnswer(task, dayOf(setup.now())));
    if (!answered.ok) throw new Error(answered.problem);
    expect(WorkItemSchema.parse(answered.value).result?.isDone).toBe(true);
    expect(await setup.service.answer({ id: "u1" }, task.id, rightAnswer(task, dayOf(setup.now())))).toEqual({ ok: false, problem: "already_answered" });
    const board = await boardOf(setup, "u1");
    expect(board.items.find((item) => item.question.id === task.id)?.result?.isDone).toBe(true);
    expect(board.shippedSinceClose).toBe(1);
  });

  it("refuses tasks that aren't on today's board, and answers that don't fit the task", async () => {
    const setup = world();
    await setup.open();
    const board = await boardOf(setup, "u1");
    const offBoard = TASKS.find((task) => task.role === "frontend");
    if (!offBoard) throw new Error("no frontend task");
    expect(await setup.service.answer({ id: "u1" }, offBoard.id, rightAnswer(offBoard, dayOf(setup.now())))).toEqual({ ok: false, problem: "not_on_board" });
    const task = taskById(board.items[0].question.id);
    const misfit: TaskAnswer = task.kind === "code-fix" ? { taskId: task.id, kind: "pr-review", verdict: "approve", flaggedLine: null } : { taskId: task.id, kind: "code-fix", line: 0, fix: 0 };
    expect(await setup.service.answer({ id: "u1" }, task.id, misfit)).toEqual({ ok: false, problem: "invalid" });
  });
});

describe("closing the day", () => {
  it("counts every member's shipped work once, ignoring anything the client claims", async () => {
    const setup = world();
    await setup.open();
    const day = dayOf(setup.now());
    for (const userId of ["u1", "u2"]) {
      for (const item of (await boardOf(setup, userId)).items.slice(0, 2)) {
        const task = taskById(item.question.id);
        const answered = await setup.service.answer({ id: userId }, task.id, rightAnswer(task, day));
        if (!answered.ok) throw new Error(answered.problem);
      }
    }
    expect((await boardOf(setup, "u1")).shippedSinceClose).toBe(4);

    const settled = await setup.companies.settle({ id: "u2" });
    if (!settled.ok) throw new Error(settled.problem);
    expect(setup.work.rows.every((row) => row.settledWorkDay === 1)).toBe(true);
    expect((await boardOf(setup, "u1")).shippedSinceClose).toBe(0);

    // The next day counts only new work.
    setup.advance(DAY_MS);
    expect(await setup.work.unsettledShippedCount("acme")).toBe(0);
    const next = await setup.companies.settle({ id: "u1" });
    expect(next.ok).toBe(true);
    expect(setup.work.rows.every((row) => row.settledWorkDay === 1)).toBe(true);
  });
});
