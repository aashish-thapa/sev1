import type { Settlement } from "./commerce-step.ts";
import type { Commerce, FraudFeature, FraudModelVersion, FraudScoring } from "./commerce.ts";

/** What `commerce.fraud` does to checkouts this second. */
export type FraudEffect = {
  /** Share of checkouts reaching checkout-api that the scorer declines: a 402, lost but not a failed request. */
  readonly declinedCheckoutShare: number;
  /** Fraudulent checkouts the scorer lets through; they join the gateway queue beside real customers. */
  readonly gatewayCallsPerSecond: number;
};

export const NO_FRAUD: FraudEffect = { declinedCheckoutShare: 0, gatewayCallsPerSecond: 0 };

/** The scorer's freshness guard: a feature older than this is served as its default, the value a brand-new customer has. */
export const FEATURE_MAX_AGE_SECONDS = 26 * 3600;

/**
 * Score tails, per 0.1 the threshold sits below where it was tuned: good customers' scores thin out
 * slowly above it, so each step down declines this many times more of them...
 */
const GOOD_TAIL_GROWTH_PER_TENTH = 2.2;
/** ...while fraud scores crowd near 1, so each step down lets this many times fewer fraud attempts through. */
const FRAUD_MISS_SHRINK_PER_TENTH = 1.5;

/** How one version scores at a threshold: the share of good customers it declines and of fraud attempts it catches. */
export type Scored = { readonly falseDeclineShare: number; readonly catchShare: number };

export function activeVersion(fraud: FraudScoring): FraudModelVersion | undefined {
  return fraud.versions.find((version) => version.version === fraud.active);
}

/** A score at or above the threshold is declined, so lowering it declines more good customers and catches more fraud. */
export function scoredAt(version: FraudModelVersion, threshold: number, tunedThreshold: number): Scored {
  const clamped = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : tunedThreshold;
  const tenthsBelowTuned = (tunedThreshold - clamped) / 0.1;
  return {
    falseDeclineShare: Math.min(1, version.falseDeclineShare * GOOD_TAIL_GROWTH_PER_TENTH ** tenthsBelowTuned),
    catchShare: 1 - Math.min(1, (1 - version.catchShare) / FRAUD_MISS_SHRINK_PER_TENTH ** tenthsBelowTuned),
  };
}

export function isFeatureStale(feature: FraudFeature, t: number): boolean {
  return t - feature.lastSuccessAt > FEATURE_MAX_AGE_SECONDS;
}

/** The scorer's effect at `t`. Fail-open approves everything; enforcing, each stale feature declines `staleFeatureDeclineShare` more good customers. */
export function fraudDeclines(commerce: Commerce, t: number): FraudEffect {
  const { fraud } = commerce;
  if (!fraud) return NO_FRAUD;
  if (fraud.mode === "fail-open") return { declinedCheckoutShare: 0, gatewayCallsPerSecond: fraud.fraudAttemptsPerSecond };
  const version = activeVersion(fraud);
  const scored = version ? scoredAt(version, fraud.threshold, fraud.tunedThreshold) : { falseDeclineShare: 0, catchShare: 0 };
  const stale = fraud.features.filter((feature) => isFeatureStale(feature, t)).length;
  return {
    declinedCheckoutShare: Math.min(1, scored.falseDeclineShare + stale * fraud.staleFeatureDeclineShare),
    gatewayCallsPerSecond: fraud.fraudAttemptsPerSecond * (1 - scored.catchShare),
  };
}

function stepRefresh(feature: FraudFeature, t: number): FraudFeature {
  if (!feature.refresh) return feature;
  const secondsLeft = feature.refresh.secondsLeft - 1;
  return secondsLeft > 0 ? { ...feature, refresh: { ...feature.refresh, secondsLeft } } : { ...feature, lastSuccessAt: t, refresh: null };
}

/**
 * Advances feature refreshes and counts the fraud the gateway captured this second. `commerce` is already
 * settled, so its pulse holds this second's real gateway calls; processed charges split between real and
 * fraudulent in proportion to the calls each sent.
 */
export function stepFraud(commerce: Commerce, settlement: Settlement): Commerce {
  const { fraud, ledger } = commerce;
  if (!fraud) return commerce;
  const fraudCalls = settlement.demand.fraudGatewayCallsPerSecond;
  const calls = commerce.pulse.gatewayCallsPerSecond + fraudCalls;
  const captured = calls > 0 ? (settlement.processedCharges * fraudCalls) / calls : 0;
  const isRefreshing = fraud.features.some((feature) => feature.refresh);
  return {
    ...commerce,
    fraud: isRefreshing ? { ...fraud, features: fraud.features.map((feature) => stepRefresh(feature, settlement.t)) } : fraud,
    ledger: { ...ledger, fraudulentCaptures: (ledger.fraudulentCaptures ?? 0) + captured },
  };
}
