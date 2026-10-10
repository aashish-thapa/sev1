import { describe, expect, it } from "vitest";
import { careerAt } from "../../src/domain/career.ts";
import type { InterviewAnswer } from "../../src/domain/work/interview.ts";
import { CompanyListSchema, InterviewResultSchema, InterviewSchema, MyCompanySchema } from "../../src/storage/company-protocol.ts";
import { CompanyDirectory } from "./directory.ts";
import { HiringService, INTERVIEW_MS, RETAKE_WINDOW_MS } from "./hiring.ts";
import { MemoryCompanyDirectory, MemoryHiringStore } from "./memory-hiring-store.ts";
import { MemoryCompanyStore } from "./memory-store.ts";
import { CompanyService } from "./service.ts";
import { TASKS } from "./tasks.ts";
import type { CompanyRow } from "./store.ts";

const START = Date.UTC(2026, 9, 10, 9);
/** Experience that makes each player an intern, a junior, or an engineer. */
const EXPERIENCE = { intern: 0, junior: 150, engineer: 400 } as const;

function world() {
  let now = START;
  let ids = 0;
  const companiesStore = new MemoryCompanyStore();
  const hiringStore = new MemoryHiringStore(companiesStore);
  const experience = new Map<string, number>();
  const deps = { now: () => now, newId: () => `id-${(ids += 1)}`, isOverLimit: async () => false };
  const companies = new CompanyService({ store: companiesStore, hiring: hiringStore, ...deps });
  const hiring = new HiringService({
    store: hiringStore,
    companies: companiesStore,
    company: companies,
    tasks: TASKS,
    careerOf: async (userId) => careerAt(experience.get(userId) ?? 0),
    ...deps,
  });
  const directory = new CompanyDirectory(new MemoryCompanyDirectory(companiesStore, hiringStore));
  const user = (id: string, username: string, xp = 0) => {
    companiesStore.addUser(id, username);
    experience.set(id, xp);
    return { id, username };
  };
  /** An active company with a founder and a free desk or three, without the money flow (tested elsewhere). */
  const company = async (id: string, name: string, founderId: string) => {
    const row: CompanyRow = {
      id,
      name,
      category: "ecommerce",
      founderId,
      state: "active",
      fundingRef: `fund:${id}`,
      fundingCents: 0,
      fundingExpiresAt: START,
      workDay: 0,
      lastSettledOn: null,
      createdAt: START,
    };
    await companiesStore.found(row, { role: "infrastructure", payCents: 12_000 });
    companiesStore.rooms.push({ companyId: id, id: `${id}:bay`, kind: "bay" });
  };
  return { companiesStore, hiringStore, companies, hiring, directory, user, company, advance: (ms: number) => (now += ms) };
}

/** The right answer to every question, read from the server-side key — what a perfect candidate would send. */
function perfectAnswers(store: MemoryHiringStore, interviewId: string): InterviewAnswer[] {
  const interview = store.interviews.get(interviewId);
  if (!interview) throw new Error("no interview");
  return interview.key.map((entry) => {
    const task = TASKS.find((candidate) => candidate.id === entry.taskId);
    if (!task) throw new Error("unknown task");
    if (task.kind === "code-fix") return { taskId: task.id, kind: "code-fix", line: task.bugLine, fix: (entry.fixOrder ?? []).indexOf(task.fixAnswer) };
    return { taskId: task.id, kind: "pr-review", verdict: task.verdict, flaggedLine: task.flaw };
  });
}

async function openRole(setup: ReturnType<typeof world>, founder: { id: string; username: string }, minScore = 60, minCareerLevel: 0 | 1 | 2 = 0) {
  const opened = await setup.hiring.openPosting(founder, { role: "infrastructure", payCents: 15_000, minCareerLevel, minScore });
  if (!opened.ok) throw new Error(opened.problem);
  return opened.value.postings[0];
}

describe("postings", () => {
  it("lets the founder and hiring managers open postings, at or above the role's minimum pay", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const sam = setup.user("u2", "sam");
    await setup.company("c1", "Acme Ops", maya.id);
    setup.companiesStore.members.push({ companyId: "c1", userId: sam.id, username: "sam", role: "frontend", payCents: 10_000, isFounder: false, joinedAt: START, canHire: false });

    expect(await setup.hiring.openPosting(maya, { role: "infrastructure", payCents: 1, minCareerLevel: 0, minScore: 50 })).toEqual({ ok: false, problem: "below_minimum" });
    expect(await setup.hiring.openPosting(sam, { role: "infrastructure", payCents: 15_000, minCareerLevel: 0, minScore: 50 })).toEqual({ ok: false, problem: "not_hiring" });

    // Only the founder can make someone a hiring manager.
    expect((await setup.companies.setMember(sam, { username: "sam", role: "frontend", payCents: 10_000, canHire: true })).ok).toBe(false);
    expect((await setup.companies.setMember(maya, { username: "sam", role: "frontend", payCents: 10_000, canHire: true })).ok).toBe(true);
    expect((await setup.hiring.openPosting(sam, { role: "infrastructure", payCents: 15_000, minCareerLevel: 0, minScore: 50 })).ok).toBe(true);
  });

  it("shows postings and applicants only to the founder and hiring managers", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const sam = setup.user("u2", "sam");
    await setup.company("c1", "Acme Ops", maya.id);
    setup.companiesStore.members.push({ companyId: "c1", userId: sam.id, username: "sam", role: "frontend", payCents: 10_000, isFounder: false, joinedAt: START, canHire: false });
    await openRole(setup, maya);
    expect(MyCompanySchema.parse(await setup.companies.mine(maya)).company?.postings).toHaveLength(1);
    expect(MyCompanySchema.parse(await setup.companies.mine(sam)).company?.postings).toEqual([]);
  });
});

describe("interviews", () => {
  it("sends questions without any answers, and a second apply within a day returns the same interview", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const lee = setup.user("u2", "lee");
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya);

    const first = await setup.hiring.apply(lee, posting.id);
    if (!first.ok) throw new Error(first.problem);
    const wire = JSON.stringify(InterviewSchema.parse(first.value));
    for (const secret of ["fixOrder", "fixAnswer", "bugLine", "verdict", "flaw", "explanation", "key"]) expect(wire).not.toContain(`"${secret}"`);
    expect(first.value.expiresAt).toBe(START + INTERVIEW_MS);

    setup.advance(60_000);
    expect(await setup.hiring.apply(lee, posting.id)).toEqual(first);
    setup.advance(RETAKE_WINDOW_MS);
    const later = await setup.hiring.apply(lee, posting.id);
    expect(later.ok && later.value.id).not.toBe(first.value.id);
  });

  it("refuses players below the posting's career level, players already in a company, and closed postings", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const intern = setup.user("u2", "ivy", EXPERIENCE.intern);
    const junior = setup.user("u3", "jo", EXPERIENCE.junior);
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya, 60, 1);
    expect(await setup.hiring.apply(intern, posting.id)).toEqual({ ok: false, problem: "below_level" });
    expect((await setup.hiring.apply(junior, posting.id)).ok).toBe(true);
    expect(await setup.hiring.apply(maya, posting.id)).toEqual({ ok: false, problem: "already_in_company" });
    await setup.hiring.closePosting(maya, posting.id);
    expect(await setup.hiring.apply(junior, posting.id)).toEqual({ ok: false, problem: "posting_closed" });
  });

  it("grades on the server, files one application, and rejects a score under the bar at once", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const lee = setup.user("u2", "lee");
    const ana = setup.user("u3", "ana");
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya, 100);

    const leeInterview = await setup.hiring.apply(lee, posting.id);
    if (!leeInterview.ok) throw new Error(leeInterview.problem);
    const passed = await setup.hiring.answer(lee, leeInterview.value.id, perfectAnswers(setup.hiringStore, leeInterview.value.id));
    if (!passed.ok) throw new Error(passed.problem);
    expect(InterviewResultSchema.parse(passed.value).result.score).toBe(100);
    expect(passed.value.application).toMatchObject({ status: "pending", companyName: "Acme Ops", role: "infrastructure", payCents: 15_000 });
    expect(await setup.hiring.answer(lee, leeInterview.value.id, [])).toEqual({ ok: false, problem: "already_applied" });
    expect(await setup.hiring.apply(lee, posting.id)).toEqual({ ok: false, problem: "already_applied" });

    const anaInterview = await setup.hiring.apply(ana, posting.id);
    if (!anaInterview.ok) throw new Error(anaInterview.problem);
    expect(await setup.hiring.answer(lee, anaInterview.value.id, [])).toEqual({ ok: false, problem: "interview_not_found" });
    const failed = await setup.hiring.answer(ana, anaInterview.value.id, []);
    expect(failed.ok && failed.value.application.status).toBe("rejected");
  });

  it("refuses answers after the interview's time runs out", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const lee = setup.user("u2", "lee");
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya);
    const interview = await setup.hiring.apply(lee, posting.id);
    if (!interview.ok) throw new Error(interview.problem);
    setup.advance(INTERVIEW_MS + 1);
    expect(await setup.hiring.answer(lee, interview.value.id, perfectAnswers(setup.hiringStore, interview.value.id))).toEqual({ ok: false, problem: "interview_expired" });
  });
});

describe("hiring", () => {
  it("lets the founder hire a passing applicant into a free desk, once, and nobody else decide", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const lee = setup.user("u2", "lee");
    const ana = setup.user("u3", "ana");
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya, 50);
    const interview = await setup.hiring.apply(lee, posting.id);
    if (!interview.ok) throw new Error(interview.problem);
    const answered = await setup.hiring.answer(lee, interview.value.id, perfectAnswers(setup.hiringStore, interview.value.id));
    if (!answered.ok) throw new Error(answered.problem);
    const applicationId = answered.value.application.id;

    expect(await setup.hiring.hire(ana, applicationId)).toEqual({ ok: false, problem: "not_in_company" });
    const hired = await setup.hiring.hire(maya, applicationId);
    expect(hired.ok && hired.value.members.map((member) => member.username)).toEqual(["maya", "lee"]);
    expect(hired.ok && hired.value.members[1]).toMatchObject({ role: "infrastructure", payCents: 15_000, canHire: false });
    expect((await setup.hiring.hire(maya, applicationId)).ok).toBe(true);
    expect(setup.companiesStore.members.filter((member) => member.userId === lee.id)).toHaveLength(1);
    expect((await setup.companies.mine(lee)).applications[0]).toMatchObject({ status: "hired" });
  });

  it("rejects pending applicants, and won't hire a rejected one", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const lee = setup.user("u2", "lee");
    await setup.company("c1", "Acme Ops", maya.id);
    const posting = await openRole(setup, maya, 0);
    const interview = await setup.hiring.apply(lee, posting.id);
    if (!interview.ok) throw new Error(interview.problem);
    const answered = await setup.hiring.answer(lee, interview.value.id, []);
    if (!answered.ok) throw new Error(answered.problem);
    expect((await setup.hiring.reject(maya, answered.value.application.id)).ok).toBe(true);
    expect(await setup.hiring.hire(maya, answered.value.application.id)).toEqual({ ok: false, problem: "application_not_found" });
  });
});

describe("company list", () => {
  it("ranks active companies by revenue over their last seven work days", async () => {
    const setup = world();
    const maya = setup.user("u1", "maya");
    const sam = setup.user("u2", "sam");
    await setup.company("c1", "Acme Ops", maya.id);
    await setup.company("c2", "Zed Labs", sam.id);
    const book = (companyId: string, workDay: number, amountCents: number) =>
      setup.companiesStore.ledger.push({ companyId, ref: `rev:${companyId}:${workDay}`, reason: "revenue", amountCents, at: START, workDay, note: null });
    // Acme earned more long ago; Zed earned more lately.
    for (let day = 1; day <= 20; day += 1) book("c1", day, day <= 10 ? 100_000 : 1_000);
    for (let day = 1; day <= 20; day += 1) book("c2", day, day <= 10 ? 1_000 : 20_000);
    setup.companiesStore.companies.set("c1", { ...(setup.companiesStore.companies.get("c1") as CompanyRow), workDay: 20 });
    setup.companiesStore.companies.set("c2", { ...(setup.companiesStore.companies.get("c2") as CompanyRow), workDay: 20 });

    const top = CompanyListSchema.parse({ companies: await setup.directory.top() }).companies;
    expect(top.map((company) => company.name)).toEqual(["Zed Labs", "Acme Ops"]);
    expect(top[0]).toMatchObject({ revenue7dCents: 140_000, founder: "sam", members: 1 });
    expect(top[1].level).toBeGreaterThan(1);
  });

  it("searches by name prefix in any case, takes wildcards literally, and filters by category", async () => {
    const setup = world();
    setup.user("u1", "maya");
    setup.user("u2", "sam");
    await setup.company("c1", "Acme Ops", "u1");
    await setup.company("c2", "acme_% Labs", "u2");
    expect((await setup.directory.search("ACME", null)).map((company) => company.name)).toEqual(["Acme Ops", "acme_% Labs"]);
    expect((await setup.directory.search("acme_%", null)).map((company) => company.name)).toEqual(["acme_% Labs"]);
    expect(await setup.directory.search("acme", "fintech")).toEqual([]);
  });
});
