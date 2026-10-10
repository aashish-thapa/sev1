/** Investments being agreed in person. D1 in production, memory in tests. */
import type { Terms } from "../../src/domain/company/deal.ts";

export type DealStage = "talking" | "agreed" | "walked-away";

export type DealRow = {
  readonly id: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly founderId: string;
  readonly founder: string;
  readonly investorId: string;
  readonly investor: string;
  readonly terms: Terms;
  readonly stage: DealStage;
  readonly agreedFounder: boolean;
  readonly agreedInvestor: boolean;
  /** Bumped on every change; a write names the version it read. */
  readonly version: number;
  readonly createdAt: number;
};

/** What a deal's next state writes; the names and parties never change. */
export type DealChange = Pick<DealRow, "terms" | "stage" | "agreedFounder" | "agreedInvestor">;

/** "duplicate" for a retried request (same key); "already_talking" when this investor already has a deal on the table with the company. */
export type DealOpened = "opened" | "duplicate" | "already_talking";

export interface DealStore {
  open(deal: Omit<DealRow, "companyName" | "founder" | "investor" | "version">, requestKey: string | null): Promise<DealOpened>;
  deal(id: string): Promise<DealRow | null>;
  /** The deal opened under this key, for a retried request. */
  dealByKey(companyId: string, requestKey: string): Promise<DealRow | null>;
  /** Writes the change only if the deal is still at `version`; false when someone else changed it first. */
  change(id: string, version: number, next: DealChange): Promise<boolean>;
  /** A player's deals, as founder or investor, still on the table or agreed and not yet paid for. */
  openFor(userId: string): Promise<DealRow[]>;
  /** Whether this player is an investor with a deal on the table at this company: their pass into its office. */
  isTalkingWith(companyId: string, investorId: string): Promise<boolean>;
}

export const DEAL_OFFER_PREFIX = "deal:";
/** The accepted investment offer an agreed deal turns into; its ref is what the investor's wallet spends. */
export const dealOfferId = (dealId: string) => `${DEAL_OFFER_PREFIX}${dealId}`;
