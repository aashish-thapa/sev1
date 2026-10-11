/** Investment proposals: a player asking a founder for a stake. D1 in production, memory in tests. */

export type ProposalStatus = "pending" | "accepted" | "declined" | "withdrawn";

export type ProposalRow = {
  readonly id: string;
  readonly companyId: string;
  readonly investorId: string;
  readonly investor: string;
  readonly amountCents: number;
  readonly equityBps: number;
  readonly status: ProposalStatus;
  readonly createdAt: number;
};

/** A proposal as the player who made it sees it, with the company it's for. */
export type MyProposalRow = ProposalRow & { readonly companyName: string };

/** "duplicate" for a retried request (same key); "already_pending" when this player already has one in play with the company. */
export type ProposalCreated = "created" | "duplicate" | "already_pending";

export interface ProposalStore {
  create(proposal: ProposalRow, requestKey: string | null): Promise<ProposalCreated>;
  proposal(id: string): Promise<ProposalRow | null>;
  /** Pending proposals to a company, oldest first. */
  pendingFor(companyId: string): Promise<ProposalRow[]>;
  /** A player's pending proposals, across companies. */
  pendingBy(userId: string): Promise<MyProposalRow[]>;
  /** Moves a pending proposal on; false when it was no longer pending. */
  decide(id: string, to: Exclude<ProposalStatus, "pending">, at: number): Promise<boolean>;
}
