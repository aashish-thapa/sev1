/** What hiring needs from storage: postings, interviews whose answer key stays here, and applications. */
import type { Level as CareerLevel } from "../../src/domain/career.ts";
import type { Role } from "../../src/domain/incident.ts";
import type { InterviewKey, InterviewQuestion } from "../../src/domain/work/interview.ts";
import type { MyApplication } from "../../src/storage/company-protocol.ts";

export type PostingRow = {
  readonly id: string;
  readonly companyId: string;
  readonly role: Role;
  readonly payCents: number;
  readonly minCareerLevel: CareerLevel;
  readonly minScore: number;
  readonly isOpen: boolean;
  readonly createdBy: string;
  readonly createdAt: number;
};

export type InterviewRow = {
  readonly id: string;
  readonly postingId: string;
  readonly userId: string;
  readonly seed: string;
  readonly questions: readonly InterviewQuestion[];
  readonly key: InterviewKey;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly submittedAt: number | null;
};

export type ApplicationStatus = "pending" | "hired" | "rejected";

export type ApplicationRow = {
  readonly id: string;
  readonly postingId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly username: string;
  readonly interviewId: string;
  readonly score: number;
  readonly careerTitle: string;
  readonly status: ApplicationStatus;
  readonly appliedAt: number;
};

export interface HiringStore {
  openPosting(posting: PostingRow): Promise<void>;
  posting(id: string): Promise<PostingRow | null>;
  /** Newest first; every posting, open or closed. */
  postingsOf(companyId: string): Promise<PostingRow[]>;
  closePosting(id: string): Promise<void>;
  /** The latest interview this player started for this posting, if any. */
  latestInterview(postingId: string, userId: string): Promise<InterviewRow | null>;
  startInterview(interview: InterviewRow): Promise<void>;
  interview(id: string): Promise<InterviewRow | null>;
  /**
   * Marks the interview submitted and files its application, together; false when the interview was
   * already submitted or the player already applied to this posting.
   */
  submit(interviewId: string, application: Omit<ApplicationRow, "username">, at: number): Promise<boolean>;
  application(id: string): Promise<ApplicationRow | null>;
  hasApplied(postingId: string, userId: string): Promise<boolean>;
  /** Newest first. */
  applicationsOf(companyId: string): Promise<ApplicationRow[]>;
  /** The player's own applications, with what each posting offers. */
  myApplications(userId: string): Promise<MyApplication[]>;
  /** Seats the applicant and marks them hired, together; false when they already belong to a company. */
  hire(application: ApplicationRow, posting: PostingRow, at: number): Promise<boolean>;
  reject(applicationId: string): Promise<void>;
}
