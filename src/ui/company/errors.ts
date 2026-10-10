import type { ApiError } from "../../storage/account-protocol.ts";

/** What each company refusal means, in the player's words; the server's own message is the fallback. */
export const COMPANY_ERROR_TEXT: Readonly<Partial<Record<ApiError | "unreachable", string>>> = {
  signed_out: "Sign in first: companies belong to accounts.",
  not_in_company: "You’re not in a company.",
  not_founder: "Only the founder can do that.",
  not_active: "The company isn’t funded yet.",
  already_in_company: "You already work at a company.",
  below_founding_minimum: "The seed is below the founding minimum.",
  below_minimum: "That pay is below the role’s minimum.",
  no_free_desk: "Every desk is taken or promised. Buy another bay first.",
  not_enough_funds: "The company can’t afford that yet.",
  no_free_rack: "There’s no free rack. Buy a server room first.",
  unknown_user: "There’s no player with that username.",
  self_invite: "You can’t send yourself an offer.",
  already_invited: "That player already has an offer from you.",
  invitation_not_found: "That offer is gone; it may have been withdrawn.",
  already_settled_today: "Today’s work day is already closed. Come back tomorrow.",
  rate_limited: "Too many tries. Wait a moment.",
  unreachable: "Couldn’t reach the company server.",
};

export function companyErrorText(error: ApiError | "unreachable", message: string): string {
  return COMPANY_ERROR_TEXT[error] ?? (message || "That didn’t go through.");
}
