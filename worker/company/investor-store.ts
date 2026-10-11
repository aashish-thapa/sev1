/** What investing needs from storage: stakes, offers, dividends and the books they're read from. D1 in production, memory in tests. */
import type { CategoryId } from "../../src/domain/company/catalog.ts";
import type { BookLine } from "../../src/domain/company/investors.ts";
import type { Holding, PendingDividend } from "../../src/storage/company-protocol.ts";

/** An investor's stake; the founder isn't stored — they hold whatever the investors don't. */
export type ShareRow = { readonly userId: string; readonly username: string; readonly bps: number; readonly investedCents: number };

export type OfferStatus = "open" | "accepted" | "cancelled" | "declined" | "completed";

export type OfferRow = {
  readonly id: string;
  readonly companyId: string;
  readonly investorId: string;
  readonly investor: string;
  readonly amountCents: number;
  readonly equityBps: number;
  readonly status: OfferStatus;
  /** The wallet ref the investor's spend must carry; fixed per offer, so a retried accept returns the same one. */
  readonly investRef: string;
  /** While accepted: until when the investor's save may still pay it. */
  readonly expiresAt: number | null;
  readonly createdAt: number;
};

/** An offer as its investor sees it, with the company it's for. */
export type ReceivedOfferRow = OfferRow & {
  readonly companyName: string;
  readonly category: CategoryId;
  readonly founder: string;
  readonly lifetimeRevenueCents: number;
  readonly workDay: number;
};

export interface InvestorStore {
  /** Investors' stakes in a company. */
  shares(companyId: string): Promise<ShareRow[]>;
  /** Offers still in play (open or accepted), oldest first: they all count against the founder's control. */
  liveOffers(companyId: string): Promise<OfferRow[]>;
  offer(id: string): Promise<OfferRow | null>;
  /** False when this company already made an offer under the same request key (a retried request). */
  createOffer(offer: OfferRow, requestKey: string | null): Promise<boolean>;
  /** Moves an offer between states only from `from`; false when it wasn't in one of them. */
  setStatus(id: string, from: readonly OfferStatus[], to: OfferStatus, expiresAt?: number | null): Promise<boolean>;
  /** Open and accepted offers made to this player. */
  receivedOffers(userId: string): Promise<ReceivedOfferRow[]>;
  holdings(userId: string): Promise<Holding[]>;
  pendingDividends(userId: string): Promise<PendingDividend[]>;
  /** Every line booked after `afterWorkDay`; the dividend and tracker rules pick the operating ones. */
  bookSince(companyId: string, afterWorkDay: number): Promise<BookLine[]>;
}
