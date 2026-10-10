/** The /api contract, shared by the worker that serves it and the browser that calls it. */
import { z } from "zod";
import { ProgressSchema } from "../domain/progress.ts";

/** Startup-mode refusals, one code per rule the server enforced (see worker/company/service.ts). */
export const COMPANY_ERRORS = [
  "not_in_company",
  "not_founder",
  "not_active",
  "already_in_company",
  "below_founding_minimum",
  "below_minimum",
  "no_free_desk",
  "not_enough_funds",
  "no_free_rack",
  "unknown_user",
  "self_invite",
  "already_invited",
  "invitation_not_found",
  "already_settled_today",
  // Hiring.
  "not_hiring",
  "posting_closed",
  "already_applied",
  "below_level",
  "interview_expired",
  "interview_not_found",
  "application_not_found",
  "no_questions",
  // Daily work.
  "not_on_board",
  "already_answered",
  // Investors.
  "self_offer",
  "below_minimum_investment",
  "too_much_equity",
  "founder_control",
  "offer_not_found",
  "not_enough_money",
] as const;

export const API_ERRORS = [
  "invalid",
  "username_taken",
  "bad_credentials",
  "rate_limited",
  "signed_out",
  "rejected",
  "forbidden",
  "not_found",
  "billing_unavailable",
  "no_subscription",
  "already_subscribed",
  "payment_provider",
  ...COMPANY_ERRORS,
] as const;
export type ApiError = (typeof API_ERRORS)[number];

/** `tags` are granted marks such as "creator"; older servers omit them. */
export const AccountSchema = z.object({ username: z.string(), tags: z.array(z.string()).default([]) });
export type Account = z.output<typeof AccountSchema>;

export const SyncedProgressSchema = z.object({ progress: ProgressSchema, updatedAt: z.int().nonnegative() });
export type SyncedProgress = z.output<typeof SyncedProgressSchema>;

/** Sign-up and sign-in both answer with who you are and what the account has saved. */
export const AuthResponseSchema = z.object({ account: AccountSchema, progress: SyncedProgressSchema.nullable() });
/** What the account has paid for, decided only by the server from Stripe's webhooks. */
export const EntitlementsSchema = z.object({
  /** Epoch ms when Pro lapses; null when the account doesn't have Pro. */
  proUntil: z.int().nullable(),
  cosmetics: z.array(z.string()),
});
export type Entitlements = z.output<typeof EntitlementsSchema>;
export const NO_ENTITLEMENTS: Entitlements = { proUntil: null, cosmetics: [] };

/** The Pro plans a player can check out. */
export const PRO_PLANS = ["pro-monthly", "pro-yearly"] as const;
export type ProPlan = (typeof PRO_PLANS)[number];
export const CheckoutRequestSchema = z.object({ plan: z.enum(PRO_PLANS) });

/** Money an admin granted this player, waiting for their game to claim it into the wallet. */
export const PendingGrantSchema = z.object({ id: z.string().min(1), amountCents: z.int().positive(), note: z.string(), grantedAt: z.number() });
export type PendingGrant = z.output<typeof PendingGrantSchema>;

/** `entitlements` is null for guests; `pendingGrants` is empty for them and on older servers. */
export const MeResponseSchema = z.object({
  account: AccountSchema.nullable(),
  entitlements: EntitlementsSchema.nullable().default(null),
  pendingGrants: z.array(PendingGrantSchema).default([]),
});
export const SaveResponseSchema = z.object({ updatedAt: z.int().nonnegative() });
/** A refused save carries what the server kept, so the client can adopt it. */
export const RejectedSaveSchema = z.object({ error: z.literal("rejected"), current: SyncedProgressSchema.nullable() });
export const ErrorResponseSchema = z.object({ error: z.enum(API_ERRORS), message: z.string() });

export const SignUpRequestSchema = z.object({ username: z.string(), password: z.string(), progress: z.unknown().optional() });
export const SignInRequestSchema = z.object({ username: z.string(), password: z.string() });
export const SaveRequestSchema = z.object({ progress: z.unknown() });
