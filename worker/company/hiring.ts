/**
 * Hiring on the server: postings, interviews graded against a key the candidate never sees, and
 * applications a founder or hiring manager settles. Every rule that matters runs here, not in the client.
 */
import type { Career } from "../../src/domain/career.ts";
import { ROLE_MINIMUM_PAY_CENTS } from "../../src/domain/company/catalog.ts";
import { difficultiesFor } from "../../src/domain/company/levels.ts";
import { checkOffer } from "../../src/domain/company/rules.ts";
import { buildInterview, gradeInterview, type InterviewAnswer } from "../../src/domain/work/interview.ts";
import type { Task } from "../../src/domain/work/task.ts";
import type { Company, Interview, InterviewResult, MyApplication, OpenPostingRequest } from "../../src/storage/company-protocol.ts";
import type { ApplicationRow, HiringStore, InterviewRow } from "./hiring-store.ts";
import { applicationOf, bookOf, canHire, levelOf, type CompanyProblem, type CompanyService, type Outcome } from "./service.ts";
import type { CompanyStore, CompanyView } from "./store.ts";

/** How long a candidate has to answer once the questions are on screen. */
export const INTERVIEW_MS = 30 * 60 * 1000;
/** Within this window a second "apply" returns the interview already started, so nobody can reshuffle for easier questions. */
export const RETAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HiringCaller = { readonly id: string; readonly username: string };

export type HiringDeps = {
  readonly store: HiringStore;
  readonly companies: Pick<CompanyStore, "companyById">;
  /** The caller's own company (expired unfunded ones dropped), and a company as a viewer may see it. */
  readonly company: Pick<CompanyService, "companyFor" | "reloaded">;
  /** The task library interviews are drawn from and graded against. */
  readonly tasks: readonly Task[];
  /** A player's career, from the progress the server last accepted for them. */
  readonly careerOf: (userId: string) => Promise<Career>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly isOverLimit: (key: string) => Promise<boolean>;
};

const fail = (problem: CompanyProblem) => ({ ok: false as const, problem });
const ok = <Value>(value: Value) => ({ ok: true as const, value });

/** What the candidate sees: the questions and the deadline, never the key. */
function presented(interview: InterviewRow): Interview {
  const questions = interview.questions.map((question) => (question.kind === "code-fix" ? { ...question, fixes: [...question.fixes] } : { ...question }));
  return { id: interview.id, postingId: interview.postingId, questions, expiresAt: interview.expiresAt };
}

export class HiringService {
  private readonly deps: HiringDeps;

  constructor(deps: HiringDeps) {
    this.deps = deps;
  }

  async openPosting(caller: HiringCaller, request: OpenPostingRequest): Promise<Outcome<Company>> {
    const hiring = await this.hirersCompany(caller);
    if (!hiring.ok) return hiring;
    const view = hiring.value;
    if (request.payCents < ROLE_MINIMUM_PAY_CENTS[request.role]) return fail("below_minimum");
    await this.deps.store.openPosting({
      id: this.deps.newId(),
      companyId: view.company.id,
      role: request.role,
      payCents: request.payCents,
      minCareerLevel: request.minCareerLevel,
      minScore: request.minScore,
      isOpen: true,
      createdBy: caller.id,
      createdAt: this.deps.now(),
    });
    return this.deps.company.reloaded(view.company.id, caller.id);
  }

  async closePosting(caller: HiringCaller, postingId: string): Promise<Outcome<Company>> {
    const hiring = await this.hirersCompany(caller);
    if (!hiring.ok) return hiring;
    const view = hiring.value;
    const posting = await this.deps.store.posting(postingId);
    if (!posting || posting.companyId !== view.company.id) return fail("posting_closed");
    await this.deps.store.closePosting(postingId);
    return this.deps.company.reloaded(view.company.id, caller.id);
  }

  /** Starts (or resumes) an interview for an open posting. The answer key stays on the server. */
  async apply(caller: HiringCaller, postingId: string): Promise<Outcome<Interview>> {
    const { store, now } = this.deps;
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const posting = await store.posting(postingId);
    if (!posting || !posting.isOpen) return fail("posting_closed");
    if (await this.deps.company.companyFor(caller.id)) return fail("already_in_company");
    if (await store.hasApplied(posting.id, caller.id)) return fail("already_applied");

    const at = now();
    const started = await store.latestInterview(posting.id, caller.id);
    if (started && started.submittedAt === null && at - started.startedAt < RETAKE_WINDOW_MS) return ok(presented(started));

    const view = await this.deps.companies.companyById(posting.companyId);
    if (!view || view.company.state !== "active") return fail("posting_closed");
    const career = await this.deps.careerOf(caller.id);
    if (career.level < posting.minCareerLevel) return fail("below_level");

    const seed = this.deps.newId();
    const { questions, key } = buildInterview(this.deps.tasks, posting.role, difficultiesFor(levelOf(view).level), seed);
    if (questions.length === 0) return fail("no_questions");
    const interview: InterviewRow = { id: this.deps.newId(), postingId: posting.id, userId: caller.id, seed, questions, key, startedAt: at, expiresAt: at + INTERVIEW_MS, submittedAt: null };
    await store.startInterview(interview);
    return ok(presented(interview));
  }

  /** Grades the answers and files the application; a score under the posting's bar is rejected at once. */
  async answer(caller: HiringCaller, interviewId: string, answers: readonly InterviewAnswer[]): Promise<Outcome<InterviewResult>> {
    const { store, now } = this.deps;
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const interview = await store.interview(interviewId);
    if (!interview || interview.userId !== caller.id) return fail("interview_not_found");
    if (interview.submittedAt !== null) return fail("already_applied");
    const at = now();
    if (at > interview.expiresAt) return fail("interview_expired");
    const posting = await store.posting(interview.postingId);
    if (!posting || !posting.isOpen) return fail("posting_closed");
    const view = await this.deps.companies.companyById(posting.companyId);
    if (!view) return fail("posting_closed");

    const result = gradeInterview(this.deps.tasks, interview.key, answers);
    const career = await this.deps.careerOf(caller.id);
    const application: Omit<ApplicationRow, "username"> = {
      id: this.deps.newId(),
      postingId: posting.id,
      companyId: posting.companyId,
      userId: caller.id,
      interviewId: interview.id,
      score: result.score,
      careerTitle: career.title,
      status: result.score < posting.minScore ? "rejected" : "pending",
      appliedAt: at,
    };
    if (!(await store.submit(interview.id, application, at))) return fail("already_applied");
    const mine: MyApplication = { ...applicationOf({ ...application, username: caller.username }), companyName: view.company.name, role: posting.role, payCents: posting.payCents };
    return ok({ result, application: mine });
  }

  /** Seats a pending applicant at the posting's role and pay; hiring someone already hired is a no-op. */
  async hire(caller: HiringCaller, applicationId: string): Promise<Outcome<Company>> {
    const settled = await this.applicationInHirersCompany(caller, applicationId);
    if (!settled.ok) return settled;
    const { view, application } = settled.value;
    if (application.status === "hired") return this.deps.company.reloaded(view.company.id, caller.id);
    if (application.status !== "pending") return fail("application_not_found");
    const posting = await this.deps.store.posting(application.postingId);
    if (!posting || !posting.isOpen) return fail("posting_closed");
    if (await this.deps.company.companyFor(application.userId)) return fail("already_in_company");
    const problem = checkOffer(bookOf(view), posting.role, posting.payCents, view.pendingInvitations.length);
    if (problem) return fail(problem);
    if (!(await this.deps.store.hire(application, posting, this.deps.now()))) return fail("already_in_company");
    return this.deps.company.reloaded(view.company.id, caller.id);
  }

  async reject(caller: HiringCaller, applicationId: string): Promise<Outcome<Company>> {
    const settled = await this.applicationInHirersCompany(caller, applicationId);
    if (!settled.ok) return settled;
    const { view, application } = settled.value;
    if (application.status === "hired") return fail("application_not_found");
    if (application.status === "pending") await this.deps.store.reject(application.id);
    return this.deps.company.reloaded(view.company.id, caller.id);
  }

  /** The caller's active company, if they may hire for it (the founder, or a member granted it). */
  private async hirersCompany(caller: HiringCaller): Promise<Outcome<CompanyView>> {
    if (await this.deps.isOverLimit(`company:${caller.id}`)) return fail("rate_limited");
    const view = await this.deps.company.companyFor(caller.id);
    if (!view) return fail("not_in_company");
    if (view.company.state !== "active") return fail("not_active");
    if (!canHire(view, caller.id)) return fail("not_hiring");
    return ok(view);
  }

  private async applicationInHirersCompany(caller: HiringCaller, applicationId: string): Promise<Outcome<{ view: CompanyView; application: ApplicationRow }>> {
    const hiring = await this.hirersCompany(caller);
    if (!hiring.ok) return hiring;
    const application = await this.deps.store.application(applicationId);
    if (!application || application.companyId !== hiring.value.company.id) return fail("application_not_found");
    return ok({ view: hiring.value, application });
  }
}

