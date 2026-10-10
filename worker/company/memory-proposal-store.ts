import type { MyProposalRow, ProposalCreated, ProposalRow, ProposalStatus, ProposalStore } from "./proposal-store.ts";

/** Proposals in memory, for tests; `companyName` resolves names the way D1's join does. */
export class MemoryProposalStore implements ProposalStore {
  readonly proposals = new Map<string, ProposalRow>();
  private readonly keys = new Set<string>();
  private readonly companyName: (companyId: string) => string;

  constructor(companyName: (companyId: string) => string = () => "") {
    this.companyName = companyName;
  }

  async create(proposal: ProposalRow, requestKey: string | null): Promise<ProposalCreated> {
    const key = requestKey === null ? null : `${proposal.investorId}:${requestKey}`;
    if (key !== null && this.keys.has(key)) return "duplicate";
    const isPending = [...this.proposals.values()].some(
      (existing) => existing.status === "pending" && existing.companyId === proposal.companyId && existing.investorId === proposal.investorId,
    );
    if (isPending) return "already_pending";
    if (key !== null) this.keys.add(key);
    this.proposals.set(proposal.id, { ...proposal, status: "pending" });
    return "created";
  }

  async proposal(id: string): Promise<ProposalRow | null> {
    return this.proposals.get(id) ?? null;
  }

  async pendingFor(companyId: string): Promise<ProposalRow[]> {
    return [...this.proposals.values()].filter((proposal) => proposal.companyId === companyId && proposal.status === "pending");
  }

  async pendingBy(userId: string): Promise<MyProposalRow[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.investorId === userId && proposal.status === "pending")
      .map((proposal) => ({ ...proposal, companyName: this.companyName(proposal.companyId) }));
  }

  async decide(id: string, to: Exclude<ProposalStatus, "pending">): Promise<boolean> {
    const proposal = this.proposals.get(id);
    if (proposal?.status !== "pending") return false;
    this.proposals.set(id, { ...proposal, status: to });
    return true;
  }
}
