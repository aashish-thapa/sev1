/**
 * Startup mode's wire contract. Company money lives only on the server (a ledger whose sum is the
 * balance). A player funds a company by spending from their own wallet against a funding ref the
 * server issued, and is paid by claiming payouts the server booked; the server never edits a save.
 */
import { z } from "zod";
import { CATEGORY_IDS, ROOM_KIND_IDS, SERVER_TIER_IDS } from "../domain/company/catalog.ts";
import { ROLE_IDS, type Role } from "../domain/incident.ts";
import { CodeFixTaskSchema, PrReviewTaskSchema } from "../domain/work/task.ts";

export const COMPANY_PATH = "/api/company";

const CategoryIdSchema = z.enum(CATEGORY_IDS);
const RoomKindIdSchema = z.enum(ROOM_KIND_IDS);
const ServerTierIdSchema = z.enum(SERVER_TIER_IDS);
const RoleSchema = z.enum(ROLE_IDS as [Role, ...Role[]]);
const Cents = z.int().nonnegative();
const SignedCents = z.int();
const Count = z.int().nonnegative();
const CompanyLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

/** Unfunded until the founder's seed spend lands (it expires after a day); active after. */
export const COMPANY_STATES = ["unfunded", "active"] as const;

export const CompanyNameSchema = z.string().trim().min(3).max(40);

export const FoundRequestSchema = z.object({ name: CompanyNameSchema, category: CategoryIdSchema, role: RoleSchema, seedCents: Cents });
export type FoundRequest = z.input<typeof FoundRequestSchema>;

/** Spend exactly `seedCents` from the wallet with ref `fundingRef`; the next save funds the company. */
export const FoundResponseSchema = z.object({ companyId: z.string(), fundingRef: z.string(), seedCents: Cents });

export const LEDGER_REASONS = ["seed", "revenue", "room-upkeep", "server-upkeep", "contractor", "payroll", "room-purchase", "server-purchase"] as const;

export const CompanyMemberSchema = z.object({
  username: z.string(),
  role: RoleSchema,
  /** Per work day. */
  payCents: Cents,
  isFounder: z.boolean(),
  joinedAt: z.number(),
  /** Can open postings and hire or reject applicants; the founder always can. */
  canHire: z.boolean().default(false),
});

export const SentInvitationSchema = z.object({ id: z.string(), username: z.string(), role: RoleSchema, payCents: Cents });

export const CompanyLedgerLineSchema = z.object({
  at: z.number(),
  workDay: z.int().nonnegative(),
  reason: z.enum(LEDGER_REASONS),
  amountCents: SignedCents,
  /** Who a payroll line paid, or what a purchase bought. */
  note: z.string().nullable(),
});

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: CategoryIdSchema,
  state: z.enum(COMPANY_STATES),
  fundsCents: SignedCents,
  /** Work days settled so far. */
  workDay: z.int().nonnegative(),
  rooms: z.array(RoomKindIdSchema),
  servers: z.array(ServerTierIdSchema),
  members: z.array(CompanyMemberSchema),
  pendingInvitations: z.array(SentInvitationSchema),
  /** Newest last; the most recent lines only. */
  ledger: z.array(CompanyLedgerLineSchema).max(60),
  /** Present only while unfunded: the spend that will fund it. */
  funding: z.object({ ref: z.string(), seedCents: Cents, expiresAt: z.number() }).nullable(),
  /** Computed on the server from the books; older servers omit these. */
  level: CompanyLevelSchema.default(1),
  levelTitle: z.string().default("Garage"),
  lifetimeRevenueCents: Cents.default(0),
  postings: z.array(z.lazy(() => PostingSchema)).default([]),
  /** Applicants to this company's postings; only the founder and hiring managers get them. */
  applications: z.array(z.lazy(() => ApplicationSchema)).default([]),
});
export type Company = z.output<typeof CompanySchema>;

/** An offer someone sent you: a role at a company, at a daily pay. */
export const ReceivedInvitationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  category: CategoryIdSchema,
  from: z.string(),
  role: RoleSchema,
  payCents: Cents,
});
export type ReceivedInvitation = z.output<typeof ReceivedInvitationSchema>;

/** Pay the server booked for you; earn it into your wallet with ref `payroll:<id>`. */
export const PendingPayoutSchema = z.object({ id: z.string(), amountCents: Cents, companyId: z.string(), workDay: z.int().nonnegative() });
export type PendingPayout = z.output<typeof PendingPayoutSchema>;

/** GET /api/company: your company (founded or joined), offers waiting for you, and pay to claim. */
export const MyCompanySchema = z.object({
  company: CompanySchema.nullable(),
  invitations: z.array(ReceivedInvitationSchema),
  payouts: z.array(PendingPayoutSchema),
  /** Postings you've interviewed for, and where each stands. */
  applications: z.array(z.lazy(() => MyApplicationSchema)).default([]),
});
export type MyCompany = z.output<typeof MyCompanySchema>;

export const BuyRoomRequestSchema = z.object({ room: RoomKindIdSchema });
export const BuyServerRequestSchema = z.object({ server: ServerTierIdSchema });
export const InviteRequestSchema = z.object({ username: z.string().trim().min(1).max(24), role: RoleSchema, payCents: Cents });
export const SetMemberRequestSchema = z.object({ username: z.string(), role: RoleSchema, payCents: Cents, canHire: z.boolean().optional() });

/**
 * POST /api/company/workday body: tasks the member shipped today. Phase 1 trusts it within a cap
 * (the server clamps it); phase 2 records each finished task on the server instead.
 */
export const SettleRequestSchema = z.object({ tasksShipped: z.int().nonnegative().max(50) });
export type SettleRequest = z.input<typeof SettleRequestSchema>;

/** POST /api/company/workday: what the settled day booked. */
export const WorkDaySettlementSchema = z.object({
  workDay: z.int().positive(),
  lines: z.array(CompanyLedgerLineSchema),
  fundsAfter: SignedCents,
  isPayrollShort: z.boolean(),
});
export type WorkDaySettlement = z.output<typeof WorkDaySettlementSchema>;

// ── Levels, hiring and the company leaderboard ─────────────────────

export const COMPANIES_PATH = "/api/companies";
export const TOP_COMPANIES_PATH = "/api/companies/top";
export const POSTINGS_PATH = "/api/company/postings";

const CareerLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const Score = z.int().min(0).max(100);

/** An open role: what it pays and the bar an applicant must clear. */
export const PostingSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  role: RoleSchema,
  payCents: Cents,
  /** The lowest career level that may apply (0 = intern). */
  minCareerLevel: CareerLevelSchema,
  /** The interview score, 0…100, an applicant needs before they can be hired. */
  minScore: Score,
  isOpen: z.boolean(),
  createdAt: z.number(),
});
export type Posting = z.output<typeof PostingSchema>;

export const OpenPostingRequestSchema = PostingSchema.pick({ role: true, payCents: true, minCareerLevel: true, minScore: true });
export type OpenPostingRequest = z.input<typeof OpenPostingRequestSchema>;

/** A company as the leaderboard and search list it: public, so no funds or books. */
export const CompanySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: CategoryIdSchema,
  level: CompanyLevelSchema,
  levelTitle: z.string(),
  founder: z.string(),
  members: Count,
  revenue7dCents: Cents,
  lifetimeRevenueCents: Cents,
  /** Open postings only. */
  postings: z.array(PostingSchema).max(20),
});
export type CompanySummary = z.output<typeof CompanySummarySchema>;

export const CompanyListSchema = z.object({ companies: z.array(CompanySummarySchema).max(50) });

/** Someone who interviewed for a posting, as the founder or a hiring manager sees them. */
export const ApplicationSchema = z.object({
  id: z.string(),
  postingId: z.string(),
  username: z.string(),
  careerTitle: z.string(),
  score: Score,
  /** Below the posting's bar is rejected at once; otherwise it waits for a hire or reject. */
  status: z.enum(["pending", "hired", "rejected"]),
  appliedAt: z.number(),
});
export type Application = z.output<typeof ApplicationSchema>;

/** Your own application, as you see it. */
export const MyApplicationSchema = ApplicationSchema.extend({ companyName: z.string(), role: RoleSchema, payCents: Cents });
export type MyApplication = z.output<typeof MyApplicationSchema>;

/** A bug fix question: the task with its bug line, right patch and explanation removed. */
const CodeFixQuestionSchema = CodeFixTaskSchema.pick({ kind: true, id: true, title: true, ticket: true, file: true, failing: true, fixes: true });
/** A review question: the PR with its verdict, flaw and explanation removed. */
const ReviewQuestionSchema = PrReviewTaskSchema.pick({ kind: true, id: true, title: true, author: true, description: true, path: true, language: true, diff: true });

/** POST /api/postings/:id/apply: the interview, answers withheld. Answer before `expiresAt`. */
export const InterviewSchema = z.object({
  id: z.string(),
  postingId: z.string(),
  questions: z.array(z.discriminatedUnion("kind", [CodeFixQuestionSchema, ReviewQuestionSchema])).min(1).max(5),
  expiresAt: z.number(),
});
export type Interview = z.output<typeof InterviewSchema>;

export const InterviewAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ taskId: z.string(), kind: z.literal("code-fix"), line: z.int().nonnegative(), fix: z.int().nonnegative() }),
  z.object({ taskId: z.string(), kind: z.literal("pr-review"), verdict: z.enum(["approve", "request-changes"]), flaggedLine: z.int().nonnegative().nullable() }),
]);

/** POST /api/interviews/:id/answers. */
export const InterviewAnswersSchema = z.object({ answers: z.array(InterviewAnswerSchema).max(5) });
export type InterviewAnswers = z.input<typeof InterviewAnswersSchema>;

export const InterviewResultSchema = z.object({
  result: z.object({ correct: Count, total: Count, score: Score }),
  application: MyApplicationSchema,
});
export type InterviewResult = z.output<typeof InterviewResultSchema>;
