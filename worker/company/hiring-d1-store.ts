import type { Level as CareerLevel } from "../../src/domain/career.ts";
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { InterviewKey, InterviewQuestion } from "../../src/domain/work/interview.ts";
import type { MyApplication } from "../../src/storage/company-protocol.ts";
import type { CompanyDirectoryStore, CompanyListing, RoundRow } from "./directory-store.ts";
import type { ApplicationRow, ApplicationStatus, HiringStore, InterviewRow, PostingRow } from "./hiring-store.ts";

type PostingRecord = { id: string; company_id: string; role: Role; pay_cents: number; min_career_level: number; min_score: number; is_open: number; created_by: string; created_at: number };
type InterviewRecord = { id: string; posting_id: string; user_id: string; seed: string; questions: string; answer_key: string; started_at: number; expires_at: number; submitted_at: number | null };
type ApplicationRecord = {
  id: string;
  posting_id: string;
  company_id: string;
  user_id: string;
  username: string;
  interview_id: string;
  score: number;
  career_title: string;
  status: ApplicationStatus;
  applied_at: number;
};

const toPosting = (row: PostingRecord): PostingRow => ({
  id: row.id,
  companyId: row.company_id,
  role: row.role,
  payCents: row.pay_cents,
  minCareerLevel: row.min_career_level as CareerLevel,
  minScore: row.min_score,
  isOpen: row.is_open === 1,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

/** Questions and key were written by this server from the task library, so they're trusted on the way back. */
const toInterview = (row: InterviewRecord): InterviewRow => ({
  id: row.id,
  postingId: row.posting_id,
  userId: row.user_id,
  seed: row.seed,
  questions: JSON.parse(row.questions) as InterviewQuestion[],
  key: JSON.parse(row.answer_key) as InterviewKey,
  startedAt: row.started_at,
  expiresAt: row.expires_at,
  submittedAt: row.submitted_at,
});

const toApplication = (row: ApplicationRecord): ApplicationRow => ({
  id: row.id,
  postingId: row.posting_id,
  companyId: row.company_id,
  userId: row.user_id,
  username: row.username,
  interviewId: row.interview_id,
  score: row.score,
  careerTitle: row.career_title,
  status: row.status,
  appliedAt: row.applied_at,
});

const APPLICATION_COLUMNS =
  "company_applications.id, company_applications.posting_id, company_applications.company_id, company_applications.user_id, users.username, " +
  "company_applications.interview_id, company_applications.score, company_applications.career_title, company_applications.status, company_applications.applied_at";

export class D1HiringStore implements HiringStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async openPosting(posting: PostingRow): Promise<void> {
    await this.db
      .prepare("INSERT INTO company_postings (id, company_id, role, pay_cents, min_career_level, min_score, is_open, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(posting.id, posting.companyId, posting.role, posting.payCents, posting.minCareerLevel, posting.minScore, posting.createdBy, posting.createdAt)
      .run();
  }

  async posting(id: string): Promise<PostingRow | null> {
    const row = await this.db.prepare("SELECT * FROM company_postings WHERE id = ?").bind(id).first<PostingRecord>();
    return row ? toPosting(row) : null;
  }

  async postingsOf(companyId: string): Promise<PostingRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM company_postings WHERE company_id = ? ORDER BY created_at DESC").bind(companyId).all<PostingRecord>();
    return results.map(toPosting);
  }

  async closePosting(id: string): Promise<void> {
    await this.db.prepare("UPDATE company_postings SET is_open = 0 WHERE id = ?").bind(id).run();
  }

  async latestInterview(postingId: string, userId: string): Promise<InterviewRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM company_interviews WHERE posting_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1")
      .bind(postingId, userId)
      .first<InterviewRecord>();
    return row ? toInterview(row) : null;
  }

  async startInterview(interview: InterviewRow): Promise<void> {
    await this.db
      .prepare("INSERT INTO company_interviews (id, posting_id, user_id, seed, questions, answer_key, started_at, expires_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .bind(interview.id, interview.postingId, interview.userId, interview.seed, JSON.stringify(interview.questions), JSON.stringify(interview.key), interview.startedAt, interview.expiresAt)
      .run();
  }

  async interview(id: string): Promise<InterviewRow | null> {
    const row = await this.db.prepare("SELECT * FROM company_interviews WHERE id = ?").bind(id).first<InterviewRecord>();
    return row ? toInterview(row) : null;
  }

  async submit(interviewId: string, application: Omit<ApplicationRow, "username">, at: number): Promise<boolean> {
    // Close the interview and file the application in one transaction; a second submit finds the interview closed.
    const [, filed] = await this.db.batch([
      this.db.prepare("UPDATE company_interviews SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL").bind(at, interviewId),
      this.db
        .prepare(
          "INSERT INTO company_applications (id, posting_id, company_id, user_id, interview_id, score, career_title, status, applied_at) " +
            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM company_interviews WHERE id = ? AND submitted_at = ?) " +
            "ON CONFLICT (posting_id, user_id) DO NOTHING",
        )
        .bind(
          application.id,
          application.postingId,
          application.companyId,
          application.userId,
          application.interviewId,
          application.score,
          application.careerTitle,
          application.status,
          application.appliedAt,
          interviewId,
          at,
        ),
    ]);
    return (filed.meta.changes ?? 0) > 0;
  }

  async application(id: string): Promise<ApplicationRow | null> {
    const row = await this.db
      .prepare(`SELECT ${APPLICATION_COLUMNS} FROM company_applications JOIN users ON users.id = company_applications.user_id WHERE company_applications.id = ?`)
      .bind(id)
      .first<ApplicationRecord>();
    return row ? toApplication(row) : null;
  }

  async hasApplied(postingId: string, userId: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS found FROM company_applications WHERE posting_id = ? AND user_id = ?").bind(postingId, userId).first()) !== null;
  }

  async applicationsOf(companyId: string): Promise<ApplicationRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${APPLICATION_COLUMNS} FROM company_applications JOIN users ON users.id = company_applications.user_id WHERE company_applications.company_id = ? ORDER BY company_applications.applied_at DESC`)
      .bind(companyId)
      .all<ApplicationRecord>();
    return results.map(toApplication);
  }

  async myApplications(userId: string): Promise<MyApplication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS}, companies.name AS company_name, company_postings.role, company_postings.pay_cents FROM company_applications ` +
          "JOIN users ON users.id = company_applications.user_id JOIN companies ON companies.id = company_applications.company_id " +
          "JOIN company_postings ON company_postings.id = company_applications.posting_id WHERE company_applications.user_id = ? ORDER BY company_applications.applied_at DESC",
      )
      .bind(userId)
      .all<ApplicationRecord & { company_name: string; role: Role; pay_cents: number }>();
    return results.map((row) => {
      const application = toApplication(row);
      return {
        id: application.id,
        postingId: application.postingId,
        username: application.username,
        careerTitle: application.careerTitle,
        score: application.score,
        status: application.status,
        appliedAt: application.appliedAt,
        companyName: row.company_name,
        role: row.role,
        payCents: row.pay_cents,
      };
    });
  }

  async hire(application: ApplicationRow, posting: PostingRow, at: number): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO company_members (company_id, user_id, role, pay_cents, is_founder, joined_at, can_hire) VALUES (?, ?, ?, ?, 0, ?, 0)")
          .bind(posting.companyId, application.userId, posting.role, posting.payCents, at),
        this.db.prepare("UPDATE company_applications SET status = 'hired' WHERE id = ? AND status = 'pending'").bind(application.id),
      ]);
      return true;
    } catch (error) {
      // One company per player: someone seated elsewhere in the meantime leaves nothing behind.
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return false;
      throw error;
    }
  }

  async reject(applicationId: string): Promise<void> {
    await this.db.prepare("UPDATE company_applications SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(applicationId).run();
  }
}

const roundOf = (round: { amount_cents: number; equity_bps: number; work_day: number; created_at: number } | undefined): RoundRow | null =>
  round ? { amountCents: round.amount_cents, equityBps: round.equity_bps, workDay: round.work_day, at: round.created_at } : null;

/** LIKE treats % and _ as wildcards; a name search means them literally. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

const LISTING_COLUMNS =
  "SELECT companies.id, companies.name, companies.category, companies.work_day, companies.created_at, users.username AS founder, " +
  "(SELECT COUNT(*) FROM company_members WHERE company_members.company_id = companies.id) AS members, " +
  "(SELECT COALESCE(SUM(amount_cents), 0) FROM company_ledger WHERE company_ledger.company_id = companies.id AND reason = 'revenue') AS lifetime, " +
  "(SELECT COALESCE(SUM(amount_cents), 0) FROM company_ledger WHERE company_ledger.company_id = companies.id AND reason = 'revenue' AND company_ledger.work_day > companies.work_day - 7) AS recent " +
  "FROM companies JOIN users ON users.id = companies.founder_id WHERE companies.state = 'active'";

type ListingRecord = { id: string; name: string; category: CategoryId; work_day: number; founder: string; members: number; lifetime: number; recent: number };

export class D1CompanyDirectory implements CompanyDirectoryStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async search(prefix: string, category: CategoryId | null, limit: number): Promise<CompanyListing[]> {
    const statement =
      category === null
        ? this.db.prepare(`${LISTING_COLUMNS} AND companies.name LIKE ? ESCAPE '\\' ORDER BY companies.name COLLATE NOCASE LIMIT ?`).bind(likePrefix(prefix), limit)
        : this.db.prepare(`${LISTING_COLUMNS} AND companies.name LIKE ? ESCAPE '\\' AND companies.category = ? ORDER BY companies.name COLLATE NOCASE LIMIT ?`).bind(likePrefix(prefix), category, limit);
    return this.withPostings((await statement.all<ListingRecord>()).results);
  }

  async top(limit: number): Promise<CompanyListing[]> {
    const { results } = await this.db.prepare(`${LISTING_COLUMNS} ORDER BY recent DESC, lifetime DESC, companies.created_at ASC LIMIT ?`).bind(limit).all<ListingRecord>();
    return this.withPostings(results);
  }

  private async withPostings(rows: readonly ListingRecord[]): Promise<CompanyListing[]> {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT * FROM company_postings WHERE is_open = 1 AND company_id IN (${placeholders}) ORDER BY created_at DESC`)
      .bind(...rows.map((row) => row.id))
      .all<PostingRecord>();
    const postings = results.map(toPosting);
    const books = await this.db
      .prepare(`SELECT company_id, work_day, reason, amount_cents FROM company_ledger WHERE company_id IN (${placeholders}) ORDER BY created_at`)
      .bind(...rows.map((row) => row.id))
      .all<{ company_id: string; work_day: number; reason: string; amount_cents: number }>();
    // A round closes when its money lands in the books; the offer it paid says what stake it bought.
    const rounds = await this.db
      .prepare(
        "SELECT ledger.company_id, offers.amount_cents, offers.equity_bps, ledger.work_day, ledger.created_at FROM company_ledger AS ledger " +
          `JOIN investment_offers AS offers ON offers.invest_ref = ledger.ref AND offers.company_id = ledger.company_id WHERE ledger.reason = 'investment' AND ledger.company_id IN (${placeholders}) ORDER BY ledger.created_at`,
      )
      .bind(...rows.map((row) => row.id))
      .all<{ company_id: string; amount_cents: number; equity_bps: number; work_day: number; created_at: number }>();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      founder: row.founder,
      members: row.members,
      workDays: row.work_day,
      lifetimeRevenueCents: row.lifetime,
      revenue7dCents: row.recent,
      postings: postings.filter((posting) => posting.companyId === row.id),
      lines: books.results.filter((line) => line.company_id === row.id).map((line) => ({ workDay: line.work_day, reason: line.reason, amountCents: line.amount_cents })),
      lastRound: roundOf(rounds.results.findLast((round) => round.company_id === row.id)),
    }));
  }
}
