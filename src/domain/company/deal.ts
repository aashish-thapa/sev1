/**
 * An investment is agreed in person: the founder and the investor meet in the company's office and
 * settle a term sheet. Either can change the terms, which clears both agreements; it closes only
 * when both have agreed to the same terms. Pure: the server keeps the deal and books the money.
 */
import { MAX_OFFER_BPS, MIN_INVESTMENT_CENTS } from "./investors.ts";

export type Terms = { readonly amountCents: number; readonly equityBps: number };
export type Party = "founder" | "investor";

export type Deal =
  | { readonly stage: "talking"; readonly terms: Terms; readonly agreed: ReadonlySet<Party> }
  /** Both agreed: the investor's wallet pays for exactly these terms. */
  | { readonly stage: "agreed"; readonly terms: Terms }
  | { readonly stage: "walked-away"; readonly by: Party };

export type DealProblem = "deal_closed" | "below_minimum_investment" | "too_much_equity";

export const openDeal = (terms: Terms): Deal => ({ stage: "talking", terms, agreed: new Set() });

export function checkTerms(terms: Terms): DealProblem | null {
  if (!Number.isInteger(terms.amountCents) || terms.amountCents < MIN_INVESTMENT_CENTS) return "below_minimum_investment";
  if (!Number.isInteger(terms.equityBps) || terms.equityBps < 1 || terms.equityBps > MAX_OFFER_BPS) return "too_much_equity";
  return null;
}

/** New terms on the table: whoever had agreed must agree again. */
export function propose(deal: Deal, terms: Terms): Deal | DealProblem {
  if (deal.stage !== "talking") return "deal_closed";
  return checkTerms(terms) ?? { stage: "talking", terms, agreed: new Set() };
}

/** One side agrees to the terms on the table, as they read them; the deal closes once both have. */
export function agree(deal: Deal, party: Party, seen: Terms): Deal | DealProblem | "terms_changed" {
  if (deal.stage !== "talking") return "deal_closed";
  // Agreeing to terms that changed under you would bind you to something you never read.
  if (seen.amountCents !== deal.terms.amountCents || seen.equityBps !== deal.terms.equityBps) return "terms_changed";
  const agreed = new Set(deal.agreed).add(party);
  return agreed.size === 2 ? { stage: "agreed", terms: deal.terms } : { stage: "talking", terms: deal.terms, agreed };
}

export function walkAway(deal: Deal, party: Party): Deal | DealProblem {
  return deal.stage === "talking" ? { stage: "walked-away", by: party } : "deal_closed";
}
