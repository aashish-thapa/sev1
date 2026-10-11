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

export const LEDGER_REASONS = ["seed", "revenue", "room-upkeep", "server-upkeep", "contractor", "pantry", "payroll", "room-purchase", "server-purchase", "investment", "dividend"] as const;

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
  /** Who owns the company. */
  capTable: z.lazy(() => CapTableSchema).nullable().default(null),
  /** Offers the founder has out to investors; only the founder gets them. */
  investmentOffers: z.array(z.lazy(() => InvestmentOfferSchema)).default([]),
  trackers: z.lazy(() => TrackersSchema).nullable().default(null),
  /** Players asking to invest; only the founder gets them. */
  investmentProposals: z.array(z.lazy(() => InvestmentProposalSchema)).default([]),
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
  /** Investment offers made to you, waiting for an answer. */
  investmentOffers: z.array(z.lazy(() => ReceivedOfferSchema)).default([]),
  /** Your stakes in companies, in or out of the one you work at. */
  holdings: z.array(z.lazy(() => HoldingSchema)).default([]),
  /** Dividends booked for you and not yet in your wallet; claimed like payroll. */
  dividends: z.array(z.lazy(() => PendingDividendSchema)).default([]),
  /** Your proposals to invest, waiting for a founder's answer. */
  proposals: z.array(z.lazy(() => MyProposalSchema)).default([]),
  /** Investments being negotiated in person, as founder or investor. */
  deals: z.array(z.lazy(() => DealSchema)).default([]),
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
/** Shipped work is counted from the server's own record; `tasksShipped` is accepted from older clients and ignored. */
export const SettleRequestSchema = z.object({ tasksShipped: z.int().nonnegative().max(50).optional() });
export type SettleRequest = z.input<typeof SettleRequestSchema>;

/** POST /api/company/workday: what the settled day booked. */
export const WorkDaySettlementSchema = z.object({
  workDay: z.int().positive(),
  lines: z.array(CompanyLedgerLineSchema),
  fundsAfter: SignedCents,
  isPayrollShort: z.boolean(),
  /** Members paid half because they answered no discussion card that day. */
  undiscussed: z.array(z.string()).default([]),
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
  /** What it's worth now (see domain/company/valuation.ts); older servers omit it. */
  valuationCents: Cents.default(0),
  /** Worth at each of the last 30 work days, oldest first: the market's view of how it's doing. */
  valuationHistory: z.array(z.object({ workDay: Count, valuationCents: Cents })).max(30).default([]),
  /** Change over the last 7 work days in basis points; null until it has a week behind it. */
  weekChangeBps: z.int().nullable().default(null),
  /** What the latest closed investment said the company was worth, and when; null before any. */
  lastRound: z.object({ valuationCents: Cents, workDay: Count, at: z.number() }).nullable().default(null),
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

// ── Daily work, recorded on the server ─────────────────────────────

export const WORK_PATH = "/api/company/work";

const TaskQuestionSchema = z.discriminatedUnion("kind", [CodeFixQuestionSchema, ReviewQuestionSchema]);

export const WorkResultSchema = z.object({
  outcome: z.enum(["shipped", "wrong-line", "wrong-fix", "correct", "shipped-a-bug", "blocked-a-good-pr"]),
  isDone: z.boolean(),
  reveal: z.object({ line: z.int().nonnegative().nullable(), cause: z.string(), why: z.string() }),
});
export type WorkResult = z.output<typeof WorkResultSchema>;

/** One task on today's board; `result` is set once it's been answered (one attempt each). */
export const WorkItemSchema = z.object({ question: TaskQuestionSchema, result: WorkResultSchema.nullable() });
export type WorkItem = z.output<typeof WorkItemSchema>;

/** GET /api/company/work: your board for the UTC day. */
export const WorkBoardSchema = z.object({
  day: z.string(),
  items: z.array(WorkItemSchema).max(5),
  /** Shipped by every member since the last closed work day: what closing the day will count. */
  shippedSinceClose: Count,
});
export type WorkBoard = z.output<typeof WorkBoardSchema>;

/** POST /api/company/work/:taskId: one answer, graded once. Returns the graded WorkItem. */
export const WorkAnswerSchema = InterviewAnswerSchema;
export type WorkAnswer = z.input<typeof WorkAnswerSchema>;

// ── Investors ──────────────────────────────────────────────────────

export const OFFERS_PATH = "/api/company/offers";
const Bps = z.int().min(0).max(10_000);

export const CapTableSchema = z.object({
  founder: z.string(),
  founderBps: Bps,
  holders: z.array(z.object({ username: z.string(), bps: Bps, investedCents: Cents })).max(50),
});
export type CapTableWire = z.output<typeof CapTableSchema>;

/** An offer the founder made: money in for a share of the company. */
export const InvestmentOfferSchema = z.object({
  id: z.string(),
  investor: z.string(),
  amountCents: Cents,
  equityBps: Bps,
  createdAt: z.number(),
});
export type InvestmentOffer = z.output<typeof InvestmentOfferSchema>;

/** POST /api/company/offers (founder only). */
export const OfferRequestSchema = z.object({ investor: z.string().trim().min(1).max(24), amountCents: Cents, equityBps: Bps });
export type OfferRequest = z.input<typeof OfferRequestSchema>;

/** An offer as the investor sees it, with what it says the company is worth. */
export const ReceivedOfferSchema = InvestmentOfferSchema.extend({
  companyId: z.string(),
  companyName: z.string(),
  category: CategoryIdSchema,
  levelTitle: z.string(),
  founder: z.string(),
  valuationCents: Cents,
});
export type ReceivedOffer = z.output<typeof ReceivedOfferSchema>;

/** POST /api/offers/:id/accept: the spend that pays for the stake; the client spends it with reason "invest". */
export const AcceptOfferResponseSchema = z.object({ investRef: z.string(), amountCents: Cents });
export type AcceptOfferResponse = z.output<typeof AcceptOfferResponseSchema>;

export const HoldingSchema = z.object({ companyId: z.string(), companyName: z.string(), bps: Bps, investedCents: Cents });
export type Holding = z.output<typeof HoldingSchema>;

export const PendingDividendSchema = z.object({ id: z.string(), companyId: z.string(), companyName: z.string(), workDay: Count, amountCents: Cents });
export type PendingDividend = z.output<typeof PendingDividendSchema>;

const WindowSchema = z.object({ earningsCents: Cents, expensesCents: Cents, expensesByReason: z.record(z.string(), Cents) });

/** Investment, inventory, and earnings and running costs over 7 and 30 work days; computed on the server from the books. */
export const TrackersSchema = z.object({
  investedCents: Cents,
  inventory: z.array(z.object({ item: z.string(), count: Count, costCents: Cents })),
  inventoryCents: Cents,
  last7: WindowSchema,
  last30: WindowSchema,
});
export type TrackersWire = z.output<typeof TrackersSchema>;

/** POST /api/companies/:companyId/proposals: a player asks to invest; the founder accepts (it becomes an offer to them) or declines. */
export const ProposalRequestSchema = z.object({ amountCents: Cents, equityBps: Bps });
export type ProposalRequest = z.input<typeof ProposalRequestSchema>;

/** A proposal as the founder sees it. */
export const InvestmentProposalSchema = z.object({ id: z.string(), investor: z.string(), amountCents: Cents, equityBps: Bps, createdAt: z.number() });
export type InvestmentProposal = z.output<typeof InvestmentProposalSchema>;

/** A proposal as the player who made it sees it. */
export const MyProposalSchema = InvestmentProposalSchema.extend({ companyId: z.string(), companyName: z.string() });
export type MyProposal = z.output<typeof MyProposalSchema>;

// ── Deals: investments agreed in a meeting ─────────────────────────

export const DEALS_PATH = "/api/deals";

const TermsSchema = z.object({ amountCents: Cents, equityBps: Bps });

/**
 * An investment being negotiated face to face in the company's office (see domain/company/deal.ts).
 * Accepting a proposal or making an offer opens one; it closes when both agree to the same terms.
 */
export const DealSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  founder: z.string(),
  investor: z.string(),
  terms: TermsSchema,
  stage: z.enum(["talking", "agreed", "walked-away"]),
  /** Who has agreed to the terms on the table, while talking. */
  agreed: z.array(z.enum(["founder", "investor"])).max(2),
  /** Once agreed: the spend the investor's wallet makes for exactly these terms. */
  investRef: z.string().nullable(),
  createdAt: z.number(),
});
export type DealWire = z.output<typeof DealSchema>;

/** POST /api/deals/:id/terms: new terms on the table (either side). Clears both agreements. */
export const DealTermsRequestSchema = TermsSchema;
/** POST /api/deals/:id/agree: agree to these terms, exactly as read; refused if they changed. */
export const DealAgreeRequestSchema = TermsSchema;
export type DealTerms = z.input<typeof TermsSchema>;

/** POST /api/deals/:id/meeting: the office room to meet in; the investor gets in while the deal is open. */
export const MeetingResponseSchema = z.object({ code: z.string().min(1) });
export type MeetingResponse = z.output<typeof MeetingResponseSchema>;

/** GET /api/companies/:id/office: what a visitor's floor needs to draw that office; public, so no money in it. */
export const officeLayoutPath = (companyId: string) => `${COMPANIES_PATH}/${encodeURIComponent(companyId)}/office`;
export const OfficeLayoutSchema = z.object({
  layout: CompanySchema.pick({ name: true, category: true, rooms: true, servers: true }).extend({
    members: z.array(CompanyMemberSchema.pick({ username: true, role: true, isFounder: true, joinedAt: true })),
  }),
});
export type OfficeLayout = z.output<typeof OfficeLayoutSchema>["layout"];
