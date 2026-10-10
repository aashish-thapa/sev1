import { describe, expect, it } from "vitest";
import { advance, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce } from "./scenarios/checkout-commerce.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { customerLossRate, type Settlement } from "./sim/commerce-step.ts";
import type { Commerce, FraudScoring } from "./sim/commerce.ts";
import { FEATURE_MAX_AGE_SECONDS, fraudDeclines, NO_FRAUD, scoredAt, stepFraud } from "./sim/fraud.ts";

const HOUR = 3600;
const ORGANIC_CHECKOUTS = 300 * 0.4;

const SCORER: FraudScoring = {
  model: "fraud-scorer",
  versions: [
    { version: "v11", deployedAt: -40 * 24 * HOUR, note: "baseline", falseDeclineShare: 0.005, catchShare: 0.9 },
    { version: "v12", deployedAt: -9 * 24 * HOUR, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.95 },
  ],
  active: "v12",
  threshold: 0.85,
  tunedThreshold: 0.85,
  mode: "enforce",
  features: [
    { name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -6 * HOUR, refresh: null },
    { name: "device_accounts_30d", pipeline: "features_device_daily", lastSuccessAt: -5 * HOUR, refresh: null },
  ],
  staleFeatureDeclineShare: 0.1,
  fraudAttemptsPerSecond: 10,
};

function withFraud(fraud: Partial<FraudScoring> = {}): Commerce {
  return checkoutCommerce({ fraud: { ...SCORER, ...fraud } });
}

/** A calm builder-made shop with a fraud scorer in front of the gateway, paging on lost customers. */
function shop(commerce: Commerce): Scenario {
  return {
    ...scaledToZero,
    id: "fraud-example",
    seed: "fraud-example",
    roles: ["data"],
    alertMetric: { label: "customers lost", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
    initialState: () =>
      checkoutCluster({ seed: "fraud-example", revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }], revision: 1, commerce }),
  };
}

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("no commerce in this incident");
  return commerce;
}

describe("fraud scoring physics", () => {
  const [, v12] = SCORER.versions;

  it("scores a version as tuned at its tuned threshold", () => {
    expect(scoredAt(v12, 0.85, 0.85)).toEqual({ falseDeclineShare: 0.004, catchShare: 0.95 });
  });

  it("declines more good customers and catches more fraud as the threshold drops, and less of both as it rises", () => {
    const lowered = scoredAt(v12, 0.35, 0.85);
    expect(lowered.falseDeclineShare).toBeCloseTo(0.004 * 2.2 ** 5, 9);
    expect(lowered.catchShare).toBeCloseTo(1 - 0.05 / 1.5 ** 5, 9);
    const raised = scoredAt(v12, 0.95, 0.85);
    expect(raised.falseDeclineShare).toBeLessThan(0.004);
    expect(raised.catchShare).toBeLessThan(0.95);
  });

  it("stays a share at the extremes, and treats a non-number as the tuned threshold", () => {
    expect(scoredAt(v12, 0, 0.85).falseDeclineShare).toBeLessThanOrEqual(1);
    expect(scoredAt(v12, 1, 0.85).catchShare).toBeGreaterThanOrEqual(0);
    expect(scoredAt({ ...v12, catchShare: 0.2 }, 1, 0.3).catchShare).toBe(0);
    expect(scoredAt(v12, Number.NaN, 0.85)).toEqual(scoredAt(v12, 0.85, 0.85));
  });

  it("is neutral without a scorer", () => {
    expect(fraudDeclines(checkoutCommerce(), 0)).toBe(NO_FRAUD);
  });

  it("declines the active version's false positives and passes the fraud it misses", () => {
    expect(fraudDeclines(withFraud(), 0)).toEqual({ declinedCheckoutShare: 0.004, gatewayCallsPerSecond: expect.closeTo(0.5, 9) });
    expect(fraudDeclines(withFraud({ active: "v11" }), 0)).toEqual({ declinedCheckoutShare: 0.005, gatewayCallsPerSecond: expect.closeTo(1, 9) });
  });

  it("adds a decline share for each stale feature, from the moment it crosses the freshness guard", () => {
    const commerce = withFraud();
    const ordersStaleAt = -6 * HOUR + FEATURE_MAX_AGE_SECONDS + 1;
    expect(fraudDeclines(commerce, ordersStaleAt - 1).declinedCheckoutShare).toBeCloseTo(0.004, 9);
    expect(fraudDeclines(commerce, ordersStaleAt).declinedCheckoutShare).toBeCloseTo(0.104, 9);
    expect(fraudDeclines(commerce, ordersStaleAt + HOUR).declinedCheckoutShare).toBeCloseTo(0.204, 9);
    expect(fraudDeclines(withFraud({ staleFeatureDeclineShare: 0.7 }), ordersStaleAt + HOUR).declinedCheckoutShare).toBe(1);
  });

  it("fails open by declining nobody and letting every fraud attempt through", () => {
    expect(fraudDeclines(withFraud({ mode: "fail-open", staleFeatureDeclineShare: 0.5 }), 30 * HOUR)).toEqual({ declinedCheckoutShare: 0, gatewayCallsPerSecond: 10 });
  });

  it("finishes a feature refresh after its seconds run out", () => {
    const refreshing = withFraud({ features: [{ ...SCORER.features[0], lastSuccessAt: -30 * HOUR, refresh: { startedAt: 40, secondsLeft: 2 } }] });
    const settle = (commerce: Commerce, t: number): Commerce =>
      stepFraud(commerce, { t, processedCharges: 0, demand: { fraudGatewayCallsPerSecond: 0 } } as unknown as Settlement);
    const once = settle(refreshing, 41);
    expect(once.fraud?.features[0].refresh).toEqual({ startedAt: 40, secondsLeft: 1 });
    expect(fraudDeclines(once, 41).declinedCheckoutShare).toBeCloseTo(0.104, 9);
    const done = settle(once, 42);
    expect(done.fraud?.features[0]).toEqual({ ...SCORER.features[0], lastSuccessAt: 42, refresh: null });
    expect(fraudDeclines(done, 42).declinedCheckoutShare).toBeCloseTo(0.004, 9);
  });

  it("returns the very same commerce when there is no scorer", () => {
    const commerce = checkoutCommerce();
    expect(stepFraud(commerce, { t: 1, processedCharges: 100, demand: { fraudGatewayCallsPerSecond: 0 } } as unknown as Settlement)).toBe(commerce);
  });

  it("loses declined customers without 5xx, and captures the fraud it passes", () => {
    const scenario = shop(withFraud({ active: "v11", features: [], fraudAttemptsPerSecond: 20 }));
    const before = play(scenario, 5, openIncident(scenario));
    const after = play(scenario, 60, before);
    expect(after.cluster.errorRate).toBe(0);
    expect(customerLossRate(commerceOf(after), after.cluster.t)).toBeCloseTo(0.005, 9);
    expect(commerceOf(after).pulse.gatewayCallsPerSecond).toBeCloseTo(ORGANIC_CHECKOUTS * 0.995, 6);
    const captured = (commerceOf(after).ledger.fraudulentCaptures ?? 0) - (commerceOf(before).ledger.fraudulentCaptures ?? 0);
    expect(captured).toBeCloseTo(60 * 20 * 0.1, 6);
  });

  it("floods a gateway with no headroom when it fails open", () => {
    const scenario = shop(checkoutCommerce({ fraud: { ...SCORER, mode: "fail-open", fraudAttemptsPerSecond: 60 }, gateway: { chargesPerSecond: 150 } }));
    const flooded = play(scenario, 120, openIncident(scenario));
    expect(commerceOf(flooded).gateway.timeoutShare).toBe(1);
    expect(flooded.cluster.errorRate).toBeGreaterThan(0.3);
    expect(commerceOf(flooded).ledger.fraudulentCaptures).toBeGreaterThan(120 * 40);
  });
});
