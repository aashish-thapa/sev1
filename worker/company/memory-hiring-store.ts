/** In-memory hiring and company-list storage with D1's rules (one application per posting, one company per player), for tests. */
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import type { MyApplication } from "../../src/storage/company-protocol.ts";
import type { CompanyDirectoryStore, CompanyListing } from "./directory-store.ts";
import type { ApplicationRow, HiringStore, InterviewRow, PostingRow } from "./hiring-store.ts";
import type { MemoryCompanyStore } from "./memory-store.ts";

export class MemoryHiringStore implements HiringStore {
  readonly postings = new Map<string, PostingRow>();
  readonly interviews = new Map<string, InterviewRow>();
  readonly applications = new Map<string, Omit<ApplicationRow, "username">>();
  private readonly companies: MemoryCompanyStore;

  constructor(companies: MemoryCompanyStore) {
    this.companies = companies;
  }

  async openPosting(posting: PostingRow): Promise<void> {
    this.postings.set(posting.id, posting);
  }

  async posting(id: string): Promise<PostingRow | null> {
    return this.postings.get(id) ?? null;
  }

  async postingsOf(companyId: string): Promise<PostingRow[]> {
    return [...this.postings.values()].filter((posting) => posting.companyId === companyId).sort((a, b) => b.createdAt - a.createdAt);
  }

  async closePosting(id: string): Promise<void> {
    const posting = this.postings.get(id);
    if (posting) this.postings.set(id, { ...posting, isOpen: false });
  }

  async latestInterview(postingId: string, userId: string): Promise<InterviewRow | null> {
    const mine = [...this.interviews.values()].filter((interview) => interview.postingId === postingId && interview.userId === userId);
    return mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }

  async startInterview(interview: InterviewRow): Promise<void> {
    this.interviews.set(interview.id, interview);
  }

  async interview(id: string): Promise<InterviewRow | null> {
    return this.interviews.get(id) ?? null;
  }

  async submit(interviewId: string, application: Omit<ApplicationRow, "username">, at: number): Promise<boolean> {
    const interview = this.interviews.get(interviewId);
    if (!interview || interview.submittedAt !== null) return false;
    this.interviews.set(interviewId, { ...interview, submittedAt: at });
    if (await this.hasApplied(application.postingId, application.userId)) return false;
    this.applications.set(application.id, application);
    return true;
  }

  async application(id: string): Promise<ApplicationRow | null> {
    const application = this.applications.get(id);
    return application ? this.named(application) : null;
  }

  async hasApplied(postingId: string, userId: string): Promise<boolean> {
    return [...this.applications.values()].some((application) => application.postingId === postingId && application.userId === userId);
  }

  async applicationsOf(companyId: string): Promise<ApplicationRow[]> {
    return [...this.applications.values()]
      .filter((application) => application.companyId === companyId)
      .sort((a, b) => b.appliedAt - a.appliedAt)
      .map((application) => this.named(application));
  }

  async myApplications(userId: string): Promise<MyApplication[]> {
    return [...this.applications.values()]
      .filter((application) => application.userId === userId)
      .sort((a, b) => b.appliedAt - a.appliedAt)
      .map((application) => {
        const posting = this.postings.get(application.postingId) as PostingRow;
        const named = this.named(application);
        return {
          id: named.id,
          postingId: named.postingId,
          username: named.username,
          careerTitle: named.careerTitle,
          score: named.score,
          status: named.status,
          appliedAt: named.appliedAt,
          companyName: this.companies.companies.get(application.companyId)?.name ?? "",
          role: posting.role,
          payCents: posting.payCents,
        };
      });
  }

  async hire(application: ApplicationRow, posting: PostingRow, at: number): Promise<boolean> {
    if (this.companies.members.some((member) => member.userId === application.userId)) return false;
    this.companies.members.push({
      companyId: posting.companyId,
      userId: application.userId,
      username: application.username,
      role: posting.role,
      payCents: posting.payCents,
      isFounder: false,
      joinedAt: at,
      canHire: false,
    });
    const stored = this.applications.get(application.id);
    if (stored?.status === "pending") this.applications.set(application.id, { ...stored, status: "hired" });
    return true;
  }

  async reject(applicationId: string): Promise<void> {
    const stored = this.applications.get(applicationId);
    if (stored?.status === "pending") this.applications.set(applicationId, { ...stored, status: "rejected" });
  }

  private named(application: Omit<ApplicationRow, "username">): ApplicationRow {
    return { ...application, username: this.companies.usernames.get(application.userId) ?? "" };
  }
}

export class MemoryCompanyDirectory implements CompanyDirectoryStore {
  private readonly companies: MemoryCompanyStore;
  private readonly hiring: MemoryHiringStore;

  constructor(companies: MemoryCompanyStore, hiring: MemoryHiringStore) {
    this.companies = companies;
    this.hiring = hiring;
  }

  async search(prefix: string, category: CategoryId | null, limit: number): Promise<CompanyListing[]> {
    const wanted = prefix.toLowerCase();
    return this.listings()
      .filter((listing) => listing.name.toLowerCase().startsWith(wanted) && (category === null || listing.category === category))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .slice(0, limit);
  }

  async top(limit: number): Promise<CompanyListing[]> {
    return this.listings()
      .sort((a, b) => b.revenue7dCents - a.revenue7dCents || b.lifetimeRevenueCents - a.lifetimeRevenueCents)
      .slice(0, limit);
  }

  private listings(): CompanyListing[] {
    return [...this.companies.companies.values()]
      .filter((company) => company.state === "active")
      .map((company) => {
        const revenue = this.companies.revenueLines(company.id);
        return {
          id: company.id,
          name: company.name,
          category: company.category,
          founder: this.companies.usernames.get(company.founderId) ?? "",
          members: this.companies.members.filter((member) => member.companyId === company.id).length,
          workDays: company.workDay,
          lifetimeRevenueCents: revenue.reduce((sum, line) => sum + line.amountCents, 0),
          revenue7dCents: revenue.filter((line) => line.workDay > company.workDay - 7).reduce((sum, line) => sum + line.amountCents, 0),
          postings: [...this.hiring.postings.values()].filter((posting) => posting.companyId === company.id && posting.isOpen),
          lines: this.companies.bookLines(company.id),
        };
      });
  }
}
