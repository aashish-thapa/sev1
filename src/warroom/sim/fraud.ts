import type { Settlement } from "./commerce-step.ts";
import type { Commerce } from "./commerce.ts";

/** What `commerce.fraud` does to checkouts this second. */
export type FraudEffect = {
  /** Share of checkouts reaching checkout-api that the scorer declines: a 402, lost but not a failed request. */
  readonly declinedCheckoutShare: number;
  /** Fraudulent checkouts the scorer lets through; they join the gateway queue beside real customers. */
  readonly gatewayCallsPerSecond: number;
};

export const NO_FRAUD: FraudEffect = { declinedCheckoutShare: 0, gatewayCallsPerSecond: 0 };

/** The scorer's effect at `t`. Neutral: declines nothing and lets no fraud through. */
export function fraudDeclines(_commerce: Commerce, _t: number): FraudEffect {
  return NO_FRAUD;
}

/** Advances `commerce.fraud` and the ledger's fraudulent captures by one settled second. Neutral: returns `commerce` itself. */
export function stepFraud(commerce: Commerce, _settlement: Settlement): Commerce {
  return commerce;
}
