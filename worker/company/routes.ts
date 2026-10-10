import { z } from "zod";
import {
  BuyRoomRequestSchema,
  BuyServerRequestSchema,
  COMPANIES_PATH,
  COMPANY_PATH,
  FoundRequestSchema,
  InterviewAnswersSchema,
  OpenPostingRequestSchema,
  POSTINGS_PATH,
  TOP_COMPANIES_PATH,
  InviteRequestSchema,
  OFFERS_PATH,
  OfferRequestSchema,
  SetMemberRequestSchema,
  SettleRequestSchema,
  WORK_PATH,
  WorkAnswerSchema,
} from "../../src/storage/company-protocol.ts";
import type { AccountService } from "../api/accounts.ts";
import { failure, idempotencyKeyOf, isSameOrigin, json, readBody, sessionTokenOf } from "../api/http.ts";
import { CATEGORY_IDS, type CategoryId } from "../../src/domain/company/catalog.ts";
import type { CompanyDirectory } from "./directory.ts";
import type { HiringService } from "./hiring.ts";
import type { InvestingService } from "./investing.ts";
import type { WorkService } from "./work.ts";
import type { CompanyOffice } from "./office.ts";

/** The company's private multiplayer room: returns `{ code }` to join it like any room. */
export const OFFICE_PATH = "/api/company/office";
import type { CompanyProblem, CompanyService, Outcome } from "./service.ts";

export const INVITATIONS_PATH = "/api/invitations";
/** Applying to a posting, answering its interview, and deciding on an application live outside /api/company: the caller needn't be in one. */
export const APPLY_PATH = "/api/postings";
export const INTERVIEWS_PATH = "/api/interviews";
export const APPLICATIONS_PATH = "/api/applications";
/** An investor answers an offer from outside any company. */
export const RECEIVED_OFFERS_PATH = "/api/offers";
const ID = "([A-Za-z0-9-]{1,64})";
const INVITATION_ACTION = new RegExp(`^${INVITATIONS_PATH}/${ID}/(accept|decline)$`);
const POSTING_CLOSE = new RegExp(`^${POSTINGS_PATH}/${ID}/close$`);
const POSTING_APPLY = new RegExp(`^${APPLY_PATH}/${ID}/apply$`);
const INTERVIEW_ANSWERS = new RegExp(`^${INTERVIEWS_PATH}/${ID}/answers$`);
const APPLICATION_DECISION = new RegExp(`^${APPLICATIONS_PATH}/${ID}/(hire|reject)$`);
const WORK_ANSWER = new RegExp(`^${WORK_PATH}/${ID}$`);
const OFFER_CANCEL = new RegExp(`^${OFFERS_PATH}/${ID}/cancel$`);
const OFFER_ANSWER = new RegExp(`^${RECEIVED_OFFERS_PATH}/${ID}/(accept|decline)$`);
/** Public lists change once a work day; a minute of caching spares the database on every page view. */
const PUBLIC_CACHE = { "cache-control": "public, max-age=60" } as const;
const CategorySchema = z.enum(CATEGORY_IDS);


const STATUS: Readonly<Record<CompanyProblem, number>> = {
  not_in_company: 404,
  invitation_not_found: 404,
  unknown_user: 404,
  not_founder: 403,
  below_founding_minimum: 400,
  below_minimum: 400,
  self_invite: 400,
  not_active: 409,
  already_in_company: 409,
  no_free_desk: 409,
  not_enough_funds: 409,
  no_free_rack: 409,
  already_invited: 409,
  already_settled_today: 409,
  rate_limited: 429,
  not_hiring: 403,
  posting_closed: 409,
  already_applied: 409,
  below_level: 403,
  interview_expired: 410,
  interview_not_found: 404,
  application_not_found: 404,
  no_questions: 409,
  not_on_board: 404,
  already_answered: 409,
  invalid: 400,
  self_offer: 400,
  below_minimum_investment: 400,
  too_much_equity: 400,
  founder_control: 409,
  offer_not_found: 404,
  not_enough_money: 409,
};

const MESSAGE: Readonly<Record<CompanyProblem, string>> = {
  not_in_company: "You're not in a company.",
  invitation_not_found: "That offer isn't open any more.",
  unknown_user: "No account has that username.",
  not_founder: "Only the founder can do that.",
  below_founding_minimum: "The seed doesn't cover the first room and a week of pay.",
  below_minimum: "That's below the role's minimum daily pay.",
  self_invite: "You're already the founder.",
  not_active: "The company isn't funded yet.",
  already_in_company: "You already belong to a company.",
  no_free_desk: "Every desk is taken or promised. Buy another bay first.",
  not_enough_funds: "The company can't afford that.",
  no_free_rack: "Every rack is full. Buy a server room first.",
  already_invited: "They already have an offer from you.",
  already_settled_today: "Today's work day is already settled.",
  rate_limited: "Too many changes in a row. Try again in a few minutes.",
  not_hiring: "Only the founder or a hiring manager can do that.",
  posting_closed: "That posting isn't open any more.",
  already_applied: "You've already applied for that posting.",
  below_level: "Your career level is below what that posting asks for.",
  interview_expired: "The interview's time ran out.",
  interview_not_found: "That interview isn't yours or doesn't exist.",
  application_not_found: "That application isn't open.",
  no_questions: "There are no interview questions for that role yet.",
  not_on_board: "That task isn't on your board today.",
  already_answered: "You've already answered that task today.",
  invalid: "That answer doesn't fit the task.",
  self_offer: "The founder can't invest in their own company.",
  below_minimum_investment: "An investment starts at $500.",
  too_much_equity: "One offer can't sell more than 49% of the company.",
  founder_control: "That would leave the founder under 51%, counting the offers already out.",
  offer_not_found: "That offer isn't open any more.",
  not_enough_money: "Your saved wallet doesn't hold that much.",
};

function respond<Value>(outcome: Outcome<Value>, status = 200): Response {
  return outcome.ok ? json(outcome.value, status) : failure(outcome.problem, MESSAGE[outcome.problem], STATUS[outcome.problem]);
}

/** HTTP for startup mode: parse, check who's asking, hand to the service. Accounts only. */
export async function handleCompany(
  request: Request,
  accounts: Pick<AccountService, "userFor">,
  companies: CompanyService,
  hiring: HiringService,
  office: CompanyOffice,
  work: WorkService,
  investing: InvestingService,
): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (request.method !== "GET" && !isSameOrigin(request)) return failure("forbidden", "Cross-site requests are not allowed.", 403);
  const user = await accounts.userFor(sessionTokenOf(request));
  if (!user) return failure("signed_out", "Sign in to run a company.", 401);
  const requestKey = idempotencyKeyOf(request);

  if (request.method === "POST") {
    const invitationAction = INVITATION_ACTION.exec(url.pathname);
    if (invitationAction) {
      const [, id, action] = invitationAction;
      return respond(action === "accept" ? await companies.accept(user, id) : await companies.decline(user, id));
    }
    const closing = POSTING_CLOSE.exec(url.pathname);
    if (closing) return respond(await hiring.closePosting(user, closing[1]));
    const applying = POSTING_APPLY.exec(url.pathname);
    if (applying) return respond(await hiring.apply(user, applying[1]));
    const answering = INTERVIEW_ANSWERS.exec(url.pathname);
    if (answering) {
      const body = await readBody(request, InterviewAnswersSchema);
      return body.ok ? respond(await hiring.answer(user, answering[1], body.data.answers)) : body.response;
    }
    const answeringWork = WORK_ANSWER.exec(url.pathname);
    if (answeringWork) {
      const body = await readBody(request, WorkAnswerSchema);
      return body.ok ? respond(await work.answer(user, answeringWork[1], body.data)) : body.response;
    }
    const cancelling = OFFER_CANCEL.exec(url.pathname);
    if (cancelling) return respond(await investing.cancel(user, cancelling[1]));
    const answeringOffer = OFFER_ANSWER.exec(url.pathname);
    if (answeringOffer) {
      const [, id, answer] = answeringOffer;
      return answer === "accept" ? respond(await investing.accept(user, id)) : respond(await investing.decline(user, id));
    }
    const deciding = APPLICATION_DECISION.exec(url.pathname);
    if (deciding) return respond(deciding[2] === "hire" ? await hiring.hire(user, deciding[1]) : await hiring.reject(user, deciding[1]));
  }

  switch (route) {
    case `GET ${COMPANY_PATH}`:
      return json(await companies.mine(user));
    case `POST ${COMPANY_PATH}`: {
      const body = await readBody(request, FoundRequestSchema);
      return body.ok ? respond(await companies.found(user, body.data), 201) : body.response;
    }
    case `GET ${WORK_PATH}`:
      return respond(await work.board(user));
    case `POST ${OFFICE_PATH}`: {
      const entered = await office.enter(user.id);
      return entered ? json(entered) : failure("not_in_company", "Only members of an active company have an office.", 404);
    }
    case `POST ${COMPANY_PATH}/rooms`: {
      const body = await readBody(request, BuyRoomRequestSchema);
      return body.ok ? respond(await companies.buyRoom(user, body.data.room, requestKey)) : body.response;
    }
    case `POST ${COMPANY_PATH}/servers`: {
      const body = await readBody(request, BuyServerRequestSchema);
      return body.ok ? respond(await companies.buyServer(user, body.data.server, requestKey)) : body.response;
    }
    case `POST ${COMPANY_PATH}/invitations`: {
      const body = await readBody(request, InviteRequestSchema);
      return body.ok ? respond(await companies.invite(user, body.data)) : body.response;
    }
    case `POST ${COMPANY_PATH}/members`: {
      const body = await readBody(request, SetMemberRequestSchema);
      return body.ok ? respond(await companies.setMember(user, body.data)) : body.response;
    }
    case `POST ${OFFERS_PATH}`: {
      const body = await readBody(request, OfferRequestSchema);
      return body.ok ? respond(await investing.offer(user, body.data, requestKey), 201) : body.response;
    }
    case `POST ${POSTINGS_PATH}`: {
      const body = await readBody(request, OpenPostingRequestSchema);
      return body.ok ? respond(await hiring.openPosting(user, body.data), 201) : body.response;
    }
    case `POST ${COMPANY_PATH}/workday`: {
      const body = await readBody(request, SettleRequestSchema);
      // Older clients still send their own tasksShipped; the server counts recorded work instead.
      return body.ok ? respond(await companies.settle(user)) : body.response;
    }
    default:
      return failure("not_found", `No route for ${route}.`, 404);
  }
}

/** The public company list: anyone may search it or see the leaderboard. */
export async function handleDirectory(request: Request, directory: CompanyDirectory): Promise<Response> {
  if (request.method !== "GET") return failure("not_found", "The company list is read-only.", 404);
  const url = new URL(request.url);
  if (url.pathname === TOP_COMPANIES_PATH) return json({ companies: await directory.top() }, 200, PUBLIC_CACHE);
  if (url.pathname !== COMPANIES_PATH) return failure("not_found", "No such list.", 404);
  const category = CategorySchema.safeParse(url.searchParams.get("category"));
  const chosen: CategoryId | null = category.success ? category.data : null;
  return json({ companies: await directory.search(url.searchParams.get("query") ?? "", chosen) }, 200, PUBLIC_CACHE);
}
