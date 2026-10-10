/** The /api contract, shared by the worker that serves it and the browser that calls it. */
import { z } from "zod";
import { ProgressSchema } from "../domain/progress.ts";

export const API_ERRORS = ["invalid", "username_taken", "bad_credentials", "rate_limited", "signed_out", "rejected", "forbidden", "not_found"] as const;
export type ApiError = (typeof API_ERRORS)[number];

export const AccountSchema = z.object({ username: z.string() });
export type Account = z.output<typeof AccountSchema>;

export const SyncedProgressSchema = z.object({ progress: ProgressSchema, updatedAt: z.int().nonnegative() });
export type SyncedProgress = z.output<typeof SyncedProgressSchema>;

/** Sign-up and sign-in both answer with who you are and what the account has saved. */
export const AuthResponseSchema = z.object({ account: AccountSchema, progress: SyncedProgressSchema.nullable() });
export const MeResponseSchema = z.object({ account: AccountSchema.nullable() });
export const SaveResponseSchema = z.object({ updatedAt: z.int().nonnegative() });
/** A refused save carries what the server kept, so the client can adopt it. */
export const RejectedSaveSchema = z.object({ error: z.literal("rejected"), current: SyncedProgressSchema.nullable() });
export const ErrorResponseSchema = z.object({ error: z.enum(API_ERRORS), message: z.string() });

export const SignUpRequestSchema = z.object({ username: z.string(), password: z.string(), progress: z.unknown().optional() });
export const SignInRequestSchema = z.object({ username: z.string(), password: z.string() });
export const SaveRequestSchema = z.object({ progress: z.unknown() });
