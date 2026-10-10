import type { AlertMetric } from "../scenario.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import type { FraudScoring } from "../sim/commerce.ts";
import { scoringWindow, type ScoringWindow } from "../sim/fraud.ts";
import type { ClusterState } from "../sim/model.ts";

export const FRAUD_MODEL = "fraud-scorer";

/** The page every scorer incident fires: customers who end checkout without an order, declines included. */
export const CUSTOMERS_LOST: AlertMetric = {
  label: "checkout customers lost",
  rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0),
};

type ScorerSetup = Pick<FraudScoring, "versions" | "active" | "features" | "fraudAttemptsPerSecond"> & Partial<FraudScoring>;

/** fraud-scorer as tuned and enforcing; a scenario sets its versions, inputs and fraud, and whatever its incident is about. */
export function fraudScorer(setup: ScorerSetup): FraudScoring {
  return { model: FRAUD_MODEL, threshold: 0.85, tunedThreshold: 0.85, mode: "enforce", staleFeatureDeclineShare: 0.11, ...setup };
}

export function scorerOf(state: ClusterState): FraudScoring | undefined {
  return state.commerce?.fraud;
}

/** What the scorer saw in the warehouse's last quarter hour, at this second's rates. */
export function lastQuarterHour(state: ClusterState): ScoringWindow | undefined {
  return state.commerce ? scoringWindow(state.commerce, state.t, 15 * 60) : undefined;
}
