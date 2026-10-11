/**
 * Who owns a company and what investing shows: the cap table, the trackers, offers on both sides, and
 * the dividends a week's close books. Reads go through the investor store; every money rule is the
 * shared pure one in src/domain/company/investors.ts.
 */
import { isDealOffer } from "./deal-store.ts";
import { roomKindById, serverTierById } from "../../src/domain/company/catalog.ts";
import {
  DIVIDEND_EVERY_WORK_DAYS,
  impliedValuationCents,
  isDividendDay,
  trackers,
  weeklyDividends,
  WHOLE_BPS,
  type BookLine,
  type CapTable,
} from "../../src/domain/company/investors.ts";
import { companyLevel } from "../../src/domain/company/levels.ts";
import type { CapTableWire, Holding, InvestmentOffer, InvestmentProposal, MyProposal, PendingDividend, ReceivedOffer, TrackersWire } from "../../src/storage/company-protocol.ts";
import type { InvestorStore, OfferRow, ShareRow } from "./investor-store.ts";
import type { ProposalRow, ProposalStore } from "./proposal-store.ts";
import type { BookReason, CompanyView } from "./store.ts";

/** The trackers' longest window, in work days. */
const TRACKED_WORK_DAYS = 30;

export type InvestorReads = Pick<InvestorStore, "shares" | "liveOffers" | "bookSince" | "receivedOffers" | "holdings" | "pendingDividends">;

/** Pending proposals both ways; without it nobody has any. */
export type ProposalReads = Pick<ProposalStore, "pendingFor" | "pendingBy">;

export function proposalOf(row: ProposalRow): InvestmentProposal {
  return { id: row.id, investor: row.investor, amountCents: row.amountCents, equityBps: row.equityBps, createdAt: row.createdAt };
}

/** The founder holds everything investors don't. */
export function capTableOf(founder: string, shares: readonly ShareRow[]): CapTable {
  const holders = shares.map((share) => ({ username: share.username, bps: share.bps, investedCents: share.investedCents }));
  return { founder, founderBps: WHOLE_BPS - holders.reduce((sum, holder) => sum + holder.bps, 0), holders };
}

export function founderOf(view: CompanyView): string {
  return view.members.find((member) => member.isFounder)?.username ?? "";
}

export function offerOf(row: OfferRow): InvestmentOffer {
  return { id: row.id, investor: row.investor, amountCents: row.amountCents, equityBps: row.equityBps, createdAt: row.createdAt };
}

export type Ownership = {
  readonly capTable: CapTableWire | null;
  readonly investmentOffers: InvestmentOffer[];
  readonly investmentProposals: InvestmentProposal[];
  readonly trackers: TrackersWire | null;
};

export const NO_OWNERSHIP: Ownership = { capTable: null, investmentOffers: [], investmentProposals: [], trackers: null };

/** What a member sees of ownership; offers out to investors and proposals from them only for the founder. */
export async function ownershipOf(view: CompanyView, viewerId: string, investors: InvestorReads, proposals?: ProposalReads): Promise<Ownership> {
  const isFounder = view.company.founderId === viewerId;
  const [shares, offers, proposed, lines] = await Promise.all([
    investors.shares(view.company.id),
    isFounder ? investors.liveOffers(view.company.id) : Promise.resolve([]),
    isFounder && proposals ? proposals.pendingFor(view.company.id) : Promise.resolve([]),
    investors.bookSince(view.company.id, view.company.workDay - TRACKED_WORK_DAYS),
  ]);
  const table = capTableOf(founderOf(view), shares);
  const owned = [
    ...view.rooms.map((kind) => ({ item: roomKindById(kind).title, costCents: roomKindById(kind).costCents })),
    ...view.servers.map((tier) => ({ item: serverTierById(tier).title, costCents: serverTierById(tier).costCents })),
  ];
  return {
    capTable: { founder: table.founder, founderBps: table.founderBps, holders: table.holders.map((holder) => ({ ...holder })) },
    investmentOffers: offers.filter((offer) => offer.status === "open").map(offerOf),
    investmentProposals: proposed.map(proposalOf),
    trackers: trackersWire(trackers(lines, table, owned, view.company.workDay)),
  };
}

function trackersWire(tracked: ReturnType<typeof trackers>): TrackersWire {
  const windowOf = (window: typeof tracked.last7) => ({ ...window, expensesByReason: { ...window.expensesByReason } });
  return { ...tracked, inventory: tracked.inventory.map((entry) => ({ ...entry })), last7: windowOf(tracked.last7), last30: windowOf(tracked.last30) };
}

export type MyInvesting = {
  readonly investmentOffers: ReceivedOffer[];
  readonly holdings: Holding[];
  readonly dividends: PendingDividend[];
  readonly proposals: MyProposal[];
};

/** A player's side of investing, member of the company or not: offers made to them, stakes, dividends to claim. */
export async function myInvesting(userId: string, investors: InvestorReads, proposals?: ProposalReads): Promise<MyInvesting> {
  const [received, holdings, dividends, mine] = await Promise.all([
    investors.receivedOffers(userId),
    investors.holdings(userId),
    investors.pendingDividends(userId),
    proposals ? proposals.pendingBy(userId) : Promise.resolve([]),
  ]);
  return {
    // An agreed deal is listed with the caller's deals until paid; its booked offer would be the same money twice.
    investmentOffers: received.filter((row) => !isDealOffer(row.id)).map((row) => ({
      ...offerOf(row),
      companyId: row.companyId,
      companyName: row.companyName,
      category: row.category,
      levelTitle: companyLevel({ lifetimeRevenueCents: row.lifetimeRevenueCents, workDays: row.workDay }).title,
      founder: row.founder,
      valuationCents: impliedValuationCents(row.amountCents, row.equityBps),
    })),
    holdings,
    dividends,
    proposals: mine.map((row) => ({ ...proposalOf(row), companyId: row.companyId, companyName: row.companyName })),
  };
}

export type DayLine = { readonly ref: string; readonly reason: BookReason; readonly amountCents: number; readonly userId: string | null; readonly note: string | null };

/**
 * The dividends a closing day books, when it closes a week: each investor's share of the week's profit,
 * counting the lines this very settlement is about to write. Paid from what the company holds after the
 * day: if it spent the week's profit on rooms, every investor's share shrinks by the same proportion.
 */
export async function dividendsOn(view: CompanyView, workDay: number, today: readonly DayLine[], fundsAfterCents: number, investors: InvestorReads) {
  if (!isDividendDay(workDay)) return { lines: [], payouts: [] };
  const shares = await investors.shares(view.company.id);
  if (shares.length === 0) return { lines: [], payouts: [] };
  const booked = await investors.bookSince(view.company.id, workDay - DIVIDEND_EVERY_WORK_DAYS);
  const week: BookLine[] = [...booked, ...today.map((line) => ({ workDay, reason: line.reason, amountCents: line.amountCents }))];
  const { payouts } = weeklyDividends(week, capTableOf(founderOf(view), shares), workDay);
  const owed = payouts.reduce((sum, payout) => sum + payout.amountCents, 0);
  const affordable = Math.max(0, Math.min(owed, fundsAfterCents));
  const holderId = new Map(shares.map((share) => [share.username, share.userId]));
  const paid = payouts.flatMap((payout) => {
    const userId = holderId.get(payout.username);
    const amountCents = owed === affordable ? payout.amountCents : Math.floor((payout.amountCents * affordable) / owed);
    return userId && amountCents > 0 ? [{ userId, username: payout.username, amountCents }] : [];
  });
  return {
    lines: paid.map((payout): DayLine => ({ ref: `day:${workDay}:dividend:${payout.userId}`, reason: "dividend", amountCents: -payout.amountCents, userId: payout.userId, note: payout.username })),
    payouts: paid.map((payout) => ({ id: `${view.company.id}:${workDay}:dividend:${payout.userId}`, userId: payout.userId, amountCents: payout.amountCents })),
  };
}
