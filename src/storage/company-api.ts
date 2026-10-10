/** The browser's side of startup mode. Every rule is enforced on the server; this only asks and reads. */
import { z } from "zod";
import {
  BuyRoomRequestSchema,
  BuyServerRequestSchema,
  COMPANY_PATH,
  FoundResponseSchema,
  InviteRequestSchema,
  MyCompanySchema,
  SetMemberRequestSchema,
  WorkDaySettlementSchema,
  type FoundRequest,
  type MyCompany,
  type SettleRequest,
  type WorkDaySettlement,
} from "./company-protocol.ts";
import { API_ERRORS, type ApiError } from "./account-protocol.ts";

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
  buyRoom(request: z.input<typeof BuyRoomRequestSchema>) {
    return call(`${COMPANY_PATH}/rooms`, "POST", request, Anything);
  }
  buyServer(request: z.input<typeof BuyServerRequestSchema>) {
    return call(`${COMPANY_PATH}/servers`, "POST", request, Anything);
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
}

async function call<T extends z.ZodType>(path: string, method: "GET" | "POST", body: unknown, schema: T, signal?: AbortSignal): Promise<CompanyOutcome<z.output<T>>> {
  try {
    const response = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
