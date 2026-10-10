import {
  BuyRoomRequestSchema,
  BuyServerRequestSchema,
  COMPANY_PATH,
  FoundRequestSchema,
  InviteRequestSchema,
  SetMemberRequestSchema,
  SettleRequestSchema,
} from "../../src/storage/company-protocol.ts";
import type { AccountService } from "../api/accounts.ts";
import { failure, idempotencyKeyOf, isSameOrigin, json, readBody, sessionTokenOf } from "../api/http.ts";
import type { CompanyProblem, CompanyService, Outcome } from "./service.ts";

export const INVITATIONS_PATH = "/api/invitations";
const INVITATION_ACTION = /^\/api\/invitations\/([A-Za-z0-9-]{1,64})\/(accept|decline)$/;
/** A client retrying a purchase sends the same key, so the second attempt books nothing new. */


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
};

function respond<Value>(outcome: Outcome<Value>, status = 200): Response {
  return outcome.ok ? json(outcome.value, status) : failure(outcome.problem, MESSAGE[outcome.problem], STATUS[outcome.problem]);
}

/** HTTP for startup mode: parse, check who's asking, hand to the service. Accounts only. */
export async function handleCompany(request: Request, accounts: Pick<AccountService, "userFor">, companies: CompanyService): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (request.method !== "GET" && !isSameOrigin(request)) return failure("forbidden", "Cross-site requests are not allowed.", 403);
  const user = await accounts.userFor(sessionTokenOf(request));
  if (!user) return failure("signed_out", "Sign in to run a company.", 401);
  const requestKey = idempotencyKeyOf(request);

  const invitationAction = request.method === "POST" ? INVITATION_ACTION.exec(url.pathname) : null;
  if (invitationAction) {
    const [, id, action] = invitationAction;
    return respond(action === "accept" ? await companies.accept(user, id) : await companies.decline(user, id));
  }

  switch (route) {
    case `GET ${COMPANY_PATH}`:
      return json(await companies.mine(user));
    case `POST ${COMPANY_PATH}`: {
      const body = await readBody(request, FoundRequestSchema);
      return body.ok ? respond(await companies.found(user, body.data), 201) : body.response;
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
    case `POST ${COMPANY_PATH}/workday`: {
      const body = await readBody(request, SettleRequestSchema);
      return body.ok ? respond(await companies.settle(user, body.data)) : body.response;
    }
    default:
      return failure("not_found", `No route for ${route}.`, 404);
  }
}
