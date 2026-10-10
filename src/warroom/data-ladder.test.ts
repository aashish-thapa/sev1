import { describe, expect, it } from "vitest";
import type { Role } from "../domain/incident.ts";
import { advance, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce } from "./scenarios/checkout-commerce.ts";
import { checkoutMeltdown } from "./scenarios/checkout-meltdown.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { SSO_GROUPS } from "./shell/identity.ts";
import { completeLine, runLine } from "./shell/shell.ts";
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

describe("the models command", () => {
  const scenario = shop(withFraud({ features: [...SCORER.features, { name: "customer_refunds_90d", pipeline: "features_customer_daily", lastSuccessAt: -30 * HOUR, refresh: null }] }));
  const opened = play(scenario, 5, openIncident(scenario));
  const run = (line: string, role: Role = "data", incident: Incident = opened) => runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  const text = (line: string, role: Role = "data", incident: Incident = opened) =>
    run(line, role, incident)
      .output.map((output) => output.text)
      .join("\n");
  const fraudAfter = (line: string) => run(line).cluster?.commerce?.fraud;

  it("lists the scorer and shows its versions, live decline rate and inputs", () => {
    expect(text("models list")).toMatch(/fraud-scorer\s+v12\s+enforce\s+0\.85\s+/);
    const shown = text("models show fraud-scorer");
    expect(shown).toMatch(/v12 \*\s+9d ago\s+10\.4% live/);
    expect(shown).toMatch(/v11\s+40d ago\s+0\.5% while serving/);
    expect(text("models features fraud-scorer")).toMatch(/customer_refunds_90d\s+features_customer_daily\s+30h ago\s+30h\s+STALE: served as default 0/);
    expect(text("models features fraud-scorer")).toMatch(/customer_orders_90d\s+features_customer_daily\s+\S+\s+6h0m\s+fresh/);
    expect(text("models show nope")).toContain('model "nope" not found');
  });

  it("rolls back to the version before, or the one named", () => {
    expect(fraudAfter("models rollback fraud-scorer")?.active).toBe("v11");
    expect(text("models rollback fraud-scorer")).toContain("rolled back v12 → v11");
    const rolledBack = { ...opened, cluster: run("models rollback fraud-scorer").cluster ?? opened.cluster };
    expect(text("models rollback fraud-scorer", "data", rolledBack)).toContain("v11 is the oldest version");
    expect(run("models rollback fraud-scorer --to v12", "data", rolledBack).cluster?.commerce?.fraud?.active).toBe("v12");
    expect(text("models rollback fraud-scorer --to v9")).toContain('version "v9" not found');
    expect(text("models rollback fraud-scorer --to v12")).toContain("already serving v12");
  });

  it("moves the threshold, and refuses anything that isn't a score", () => {
    expect(fraudAfter("models threshold fraud-scorer 0.9")?.threshold).toBe(0.9);
    expect(text("models threshold fraud-scorer 0.9")).toContain("threshold 0.85 → 0.9");
    for (const bad of ["abc", "1.5", "0", "1", "-0.2"]) {
      expect(run(`models threshold fraud-scorer ${bad}`).cluster, bad).toBeUndefined();
      expect(text(`models threshold fraud-scorer ${bad}`), bad).toContain("between 0 and 1");
    }
  });

  it("switches between enforce and fail-open", () => {
    expect(fraudAfter("models mode fraud-scorer fail-open")?.mode).toBe("fail-open");
    expect(text("models mode fraud-scorer fail-open")).toContain("enforce → fail-open");
    expect(text("models mode fraud-scorer enforce")).toContain("already in enforce mode");
    expect(text("models mode fraud-scorer off")).toContain('unknown mode "off"');
  });

  it("completes subcommands, the model, modes and versions", () => {
    const complete = (line: string) => completeLine(line, { cluster: opened.cluster, scenario, history: [], role: "data" });
    expect(complete("mod").line).toBe("models ");
    expect(complete("models sh").line).toBe("models show ");
    expect(complete("models show f").line).toBe("models show fraud-scorer ");
    expect(complete("models mode fraud-scorer f").line).toBe("models mode fraud-scorer fail-open ");
    expect(complete("models rollback fraud-scorer --to v1").candidates).toEqual(["v11", "v12"]);
  });

  it("turns away other roles the way the platform's SSO does, and changes nothing", () => {
    for (const role of ["infrastructure", "frontend", "mobile", "security"] as const) {
      expect(text("models list", role)).toBe(
        `models: 403 Forbidden: oncall-${role}@marlow.example is not in ml-platform\nmodels: your groups: ${SSO_GROUPS[role].join(", ")} — ask in #access-requests`,
      );
      expect(run("models mode fraud-scorer fail-open", role).cluster).toBeUndefined();
    }
  });

  it("isn't installed where no model serves checkout", () => {
    const meltdown = { cluster: openIncident(checkoutMeltdown).cluster, scenario: checkoutMeltdown, history: [], role: "data" as const };
    expect(runLine("models list", meltdown).output[0].text).toBe("bash: models: command not found");
    expect(runLine("help", meltdown).output.map((line) => line.text).join("\n")).not.toContain("models");
    expect(text("help")).toContain("models");
  });
});
