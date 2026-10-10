/** The browser's side of startup mode. Every rule is enforced on the server; this only asks and reads. */
import { z } from "zod";
import {
  BuyRoomRequestSchema,
  BuyServerRequestSchema,
  COMPANIES_PATH,
  COMPANY_PATH,
  CompanyListSchema,
  InterviewResultSchema,
  InterviewSchema,
  POSTINGS_PATH,
  TOP_COMPANIES_PATH,
  WORK_PATH,
  OFFERS_PATH,
  AcceptOfferResponseSchema,
  WorkBoardSchema,
  WorkItemSchema,
  FoundResponseSchema,
  InviteRequestSchema,
  MyCompanySchema,
  SetMemberRequestSchema,
  WorkDaySettlementSchema,
  type CompanySummary,
  type FoundRequest,
  type Interview,
  type InterviewAnswers,
  type InterviewResult,
  type OpenPostingRequest,
  type WorkAnswer,
  type AcceptOfferResponse,
  type OfferRequest,
  type WorkBoard,
  type WorkItem,
  type MyCompany,
  type SettleRequest,
  type WorkDaySettlement,
} from "./company-protocol.ts";
import { API_ERRORS, type ApiError } from "./account-protocol.ts";
import type { CategoryId } from "../domain/company/catalog.ts";

export type CompanyOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError | "unreachable"; readonly message: string };

export interface CompanyApi {
  mine(signal?: AbortSignal): Promise<CompanyOutcome<MyCompany>>;
  found(request: FoundRequest): Promise<CompanyOutcome<z.output<typeof FoundResponseSchema>>>;
  buyRoom(request: z.input<typeof BuyRoomRequestSchema>): Promise<CompanyOutcome<unknown>>;
  buyServer(request: z.input<typeof BuyServerRequestSchema>): Promise<CompanyOutcome<unknown>>;
  invite(request: z.input<typeof InviteRequestSchema>): Promise<CompanyOutcome<unknown>>;
  setMember(request: z.input<typeof SetMemberRequestSchema>): Promise<CompanyOutcome<unknown>>;
  respond(invitationId: string, answer: "accept" | "decline"): Promise<CompanyOutcome<unknown>>;
  settleWorkDay(request: SettleRequest): Promise<CompanyOutcome<WorkDaySettlement>>;
  /** The leaderboard: top companies by revenue over their last 7 work days. */
  top(signal?: AbortSignal): Promise<CompanyOutcome<readonly CompanySummary[]>>;
  search(query: string, category: CategoryId | null, signal?: AbortSignal): Promise<CompanyOutcome<readonly CompanySummary[]>>;
  openPosting(request: OpenPostingRequest): Promise<CompanyOutcome<unknown>>;
  closePosting(postingId: string): Promise<CompanyOutcome<unknown>>;
  /** Starts (or resumes) the interview for a posting; the questions come without their answers. */
  apply(postingId: string): Promise<CompanyOutcome<Interview>>;
  /** Graded on the server; the application is created with its score. */
  answerInterview(interviewId: string, answers: InterviewAnswers): Promise<CompanyOutcome<InterviewResult>>;
  decide(applicationId: string, decision: "hire" | "reject"): Promise<CompanyOutcome<unknown>>;
  /** The code of the company's own office room: members only, the same for every member, never listed. */
  enterOffice(): Promise<CompanyOutcome<{ code: string }>>;
  /** Your board for the UTC day, with each answered task's result. */
  work(signal?: AbortSignal): Promise<CompanyOutcome<WorkBoard>>;
  /** One attempt per task, graded on the server. */
  answerWork(answer: WorkAnswer): Promise<CompanyOutcome<WorkItem>>;
  /** Founder only: offer a player a stake for money. */
  makeOffer(request: OfferRequest): Promise<CompanyOutcome<unknown>>;
  cancelOffer(offerId: string): Promise<CompanyOutcome<unknown>>;
  /** Returns the spend that pays for the stake; it counts once the wallet spends it and saves. */
  acceptOffer(offerId: string): Promise<CompanyOutcome<AcceptOfferResponse>>;
  declineOffer(offerId: string): Promise<CompanyOutcome<unknown>>;
}

const ErrorSchema = z.object({ error: z.enum(API_ERRORS), message: z.string().optional() });
const Anything = z.unknown();

export class HttpCompanyApi implements CompanyApi {
  mine(signal?: AbortSignal) {
    return call(`${COMPANY_PATH}`, "GET", undefined, MyCompanySchema, signal);
  }
  found(request: FoundRequest) {
    return call(COMPANY_PATH, "POST", request, FoundResponseSchema);
  }
  // Each purchase gets a fresh key, so the server books a retried request once.
  buyRoom(request: z.input<typeof BuyRoomRequestSchema>) {
    return call(`${COMPANY_PATH}/rooms`, "POST", request, Anything, undefined, crypto.randomUUID());
  }
  buyServer(request: z.input<typeof BuyServerRequestSchema>) {
    return call(`${COMPANY_PATH}/servers`, "POST", request, Anything, undefined, crypto.randomUUID());
  }
  invite(request: z.input<typeof InviteRequestSchema>) {
    return call(`${COMPANY_PATH}/invitations`, "POST", request, Anything);
  }
  setMember(request: z.input<typeof SetMemberRequestSchema>) {
    return call(`${COMPANY_PATH}/members`, "POST", request, Anything);
  }
  respond(invitationId: string, answer: "accept" | "decline") {
    return call(`/api/invitations/${encodeURIComponent(invitationId)}/${answer}`, "POST", {}, Anything);
  }
  settleWorkDay(request: SettleRequest) {
    return call(`${COMPANY_PATH}/workday`, "POST", request, WorkDaySettlementSchema);
  }
  async top(signal?: AbortSignal) {
    return companies(await call(TOP_COMPANIES_PATH, "GET", undefined, CompanyListSchema, signal));
  }
  async search(query: string, category: CategoryId | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ query });
    if (category) params.set("category", category);
    return companies(await call(`${COMPANIES_PATH}?${params}`, "GET", undefined, CompanyListSchema, signal));
  }
  openPosting(request: OpenPostingRequest) {
    return call(POSTINGS_PATH, "POST", request, Anything);
  }
  closePosting(postingId: string) {
    return call(`${POSTINGS_PATH}/${encodeURIComponent(postingId)}/close`, "POST", {}, Anything);
  }
  apply(postingId: string) {
    return call(`/api/postings/${encodeURIComponent(postingId)}/apply`, "POST", {}, InterviewSchema);
  }
  answerInterview(interviewId: string, answers: InterviewAnswers) {
    return call(`/api/interviews/${encodeURIComponent(interviewId)}/answers`, "POST", answers, InterviewResultSchema);
  }
  decide(applicationId: string, decision: "hire" | "reject") {
    return call(`/api/applications/${encodeURIComponent(applicationId)}/${decision}`, "POST", {}, Anything);
  }
  enterOffice() {
    return call(`${COMPANY_PATH}/office`, "POST", {}, OfficeSchema);
  }
  work(signal?: AbortSignal) {
    return call(WORK_PATH, "GET", undefined, WorkBoardSchema, signal);
  }
  answerWork(answer: WorkAnswer) {
    return call(`${WORK_PATH}/${encodeURIComponent(answer.taskId)}`, "POST", answer, WorkItemSchema);
  }
  makeOffer(request: OfferRequest) {
    return call(OFFERS_PATH, "POST", request, Anything, undefined, crypto.randomUUID());
  }
  cancelOffer(offerId: string) {
    return call(`${OFFERS_PATH}/${encodeURIComponent(offerId)}/cancel`, "POST", {}, Anything);
  }
  acceptOffer(offerId: string) {
    return call(`/api/offers/${encodeURIComponent(offerId)}/accept`, "POST", {}, AcceptOfferResponseSchema);
  }
  declineOffer(offerId: string) {
    return call(`/api/offers/${encodeURIComponent(offerId)}/decline`, "POST", {}, Anything);
  }
}

const OfficeSchema = z.object({ code: z.string().min(1) });

function companies(outcome: CompanyOutcome<z.output<typeof CompanyListSchema>>): CompanyOutcome<readonly CompanySummary[]> {
  return outcome.ok ? { ok: true, value: outcome.value.companies } : outcome;
}

async function call<T extends z.ZodType>(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  schema: T,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<CompanyOutcome<z.output<T>>> {
  try {
    const response = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse(json);
      return parsed.success
        ? { ok: false, error: parsed.data.error, message: parsed.data.message ?? "" }
        : { ok: false, error: "unreachable", message: `The server answered ${response.status}.` };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "unreachable", message: "The server's answer didn't make sense." };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, error: "unreachable", message: "Couldn't reach the server." };
  }
}
