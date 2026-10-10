import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster, type WarmUp } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, WEB_USER_AGENT, NO_RETRY, type CommerceSetup } from "./scenarios/checkout-commerce.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { commerceDemand, customerLossRate } from "./sim/commerce-step.ts";
import type { Commerce } from "./sim/commerce.ts";

// The attack, fraud and update-wall hooks ship neutral. These stand-ins return whatever a test sets,
// to prove the demand, loss and gateway seams carry their effects.
const hooks = vi.hoisted(() => ({ walledIos: 0, attackRequestsPerSecond: 0, declined: 0, fraudCalls: 0 }));
vi.mock("./sim/update-wall.ts", () => ({
  updateWall: (_commerce: unknown, segment: { readonly platform: string }) => (segment.platform === "ios" ? hooks.walledIos : 0),
}));
vi.mock("./sim/attack.ts", () => ({
  attackLoad: () => ({ requestsPerSecond: hooks.attackRequestsPerSecond }),
  stepAttack: (commerce: unknown) => commerce,
}));
vi.mock("./sim/fraud.ts", () => ({
  fraudDeclines: () => ({ declinedCheckoutShare: hooks.declined, gatewayCallsPerSecond: hooks.fraudCalls }),
  stepFraud: (commerce: unknown) => commerce,
}));

const ORGANIC_CHECKOUTS = 300 * 0.4;

/** A builder-made commerce scenario that pages on lost customers rather than 5xx. */
function shop(commerce: Commerce = checkoutCommerce(), warmUp?: WarmUp): Scenario {
  return {
    ...scaledToZero,
    id: "builder-example",
    seed: "builder-example",
    roles: ["security"],
    alertMetric: { label: "customers lost", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
    initialState: () =>
      checkoutCluster({
        seed: "builder-example",
        revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
        revision: 1,
        commerce,
        warmUp,
      }),
  };
}

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("example shop has no commerce");
  return commerce;
}

beforeEach(() => {
  Object.assign(hooks, { walledIos: 0, attackRequestsPerSecond: 0, declined: 0, fraudCalls: 0 });
});

describe("a builder-made commerce scenario", () => {
  it("opens calm: no SIEM alerts, no client retries, a gateway with headroom, nobody lost", () => {
    const scenario = shop();
    const opened = openIncident(scenario);
    const commerce = commerceOf(opened);
    expect(commerce.alerts).toEqual([]);
    expect(commerce.platforms.map((platform) => platform.current.retry)).toEqual([NO_RETRY, NO_RETRY, NO_RETRY]);
    expect(commerce.gateway.chargesPerSecond).toBeGreaterThan(ORGANIC_CHECKOUTS);
    expect(opened.cluster.errorRate).toBe(0);
    expect(customerLossRate(commerce, opened.cluster.t)).toBe(0);
    expect(declareResolved(opened, scenario).notice).toBeUndefined();
  });

  it("runs a warm-up profile before the page, then settles back to the cluster's traffic", () => {
    const surge: WarmUp = { seconds: 60, requestsPerSecond: (second) => (second < 20 ? 600 : 300) };
    const opened = openIncident(shop(checkoutCommerce(), surge));
    expect(opened.cluster.t).toBe(0);
    expect(opened.cluster.traffic.requestsPerSecond).toBe(300);
    expect(opened.cluster.series.errorRate.slice(0, 20).every((rate) => rate > 0.3)).toBe(true);
    expect(opened.cluster.failedCheckouts).toBe(0);
  });

  it("sends nothing from walled customers and counts them lost", () => {
    const scenario = shop();
    const opened = openIncident(scenario);
    hooks.walledIos = 1;
    expect(commerceDemand(opened.cluster, commerceOf(opened)).checkoutAttemptsPerSecond).toBeCloseTo(ORGANIC_CHECKOUTS * 0.64, 9);
    const walled = play(scenario, 5, opened);
    expect(walled.cluster.errorRate).toBe(0);
    expect(customerLossRate(commerceOf(walled), walled.cluster.t)).toBeCloseTo(0.36, 9);
    expect(walled.cluster.failedCheckouts).toBeCloseTo(5 * ORGANIC_CHECKOUTS * 0.36, 6);
    expect(declareResolved(walled, scenario).notice).toEqual({ kind: "refused", rate: expect.closeTo(0.36, 9), label: "customers lost" });
  });

  it("adds attack traffic to the pods' load without adding checkouts", () => {
    const scenario = shop();
    const opened = openIncident(scenario);
    hooks.attackRequestsPerSecond = 300;
    const demand = commerceDemand(opened.cluster, commerceOf(opened));
    expect(demand.requestsPerSecond).toBeCloseTo(600, 9);
    expect(demand.checkoutShare).toBeCloseTo(0.2, 9);
    expect(demand.checkoutAttemptsPerSecond).toBeCloseTo(ORGANIC_CHECKOUTS, 9);
    // Three pods of 130 rps shed what's left of 600.
    expect(play(scenario, 5, opened).cluster.errorRate).toBeCloseTo((600 - 390) / 600, 6);
  });

  it("loses declined customers without failing a request, and queues the fraud it passes at the gateway", () => {
    const scenario = shop();
    const opened = openIncident(scenario);
    hooks.declined = 0.25;
    hooks.fraudCalls = 20;
    const before = play(scenario, 5, opened);
    const after = play(scenario, 1, before);
    expect(after.cluster.errorRate).toBe(0);
    expect(customerLossRate(commerceOf(after), after.cluster.t)).toBeCloseTo(0.25, 9);
    expect(commerceOf(after).pulse.gatewayCallsPerSecond).toBeCloseTo(ORGANIC_CHECKOUTS * 0.75, 6);
    expect(commerceOf(after).ledger.paidOrders - commerceOf(before).ledger.paidOrders).toBeCloseTo(ORGANIC_CHECKOUTS * 0.75 + 20, 6);
  });

  it("round-trips every optional commerce slot through multiplayer frames", () => {
    const setup: CommerceSetup = {
      platforms: {
        web: {
          current: {
            version: "2026.10.10-1",
            userAgent: WEB_USER_AGENT,
            timeoutMs: 8000,
            retry: NO_RETRY,
            defects: [{ trigger: { flag: "checkout.address_autocomplete", failsWhenOn: true }, failShare: 0.6, where: "server", message: "500" }],
          },
        },
      },
      wafRules: [{ id: "r-0001", action: "block", expression: "ip.src in 203.0.113.0/24", createdAt: -60, createdBy: "a.kowalski", customerShare: 0, attackShare: 0.9 }],
      attack: {
        label: "credential stuffing",
        path: "/session",
        requestsPerSecond: 200,
        growthPerSecond: 0.5,
        sources: { kind: "ranges", ranges: [{ cidr: "203.0.113.0/24", asn: 64_500, network: "EXAMPLE-HOSTING", ips: 120 }] },
        ja4: "t13d1516h2_8daaf6152771_02713d6af862",
        userAgent: "python-requests/2.32.3",
      },
      fraud: {
        model: "fraud-scorer",
        versions: [{ version: "v13", deployedAt: -3600, note: "retrained", falseDeclineShare: 0.14, catchShare: 0.9 }],
        active: "v13",
        threshold: 0.85,
        tunedThreshold: 0.85,
        mode: "enforce",
        features: [{ name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -30 * 3600, refresh: null }],
        staleFeatureDeclineShare: 0.2,
        fraudAttemptsPerSecond: 3,
      },
      updateWall: { configKey: "min_supported_version" },
    };
    const built = checkoutCommerce(setup);
    const scenario = shop({ ...built, ledger: { ...built.ledger, fraudulentCaptures: 3 } });
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 30; second += 1) {
      server = advance(server, scenario).incident;
      client = roundTrip(client, server);
    }
    expect(client).toEqual(server);
    expect(commerceOf(client).attack).toEqual(setup.attack);
    expect(commerceOf(client).fraud).toEqual(setup.fraud);
    expect(commerceOf(client).updateWall).toEqual(setup.updateWall);
    expect(commerceOf(client).ledger.fraudulentCaptures).toBe(3);
    expect(commerceOf(client).wafRules[0].attackShare).toBe(0.9);
    expect(commerceOf(client).platforms[0].current.defects).toEqual(setup.platforms?.web?.current?.defects);
  });
});
