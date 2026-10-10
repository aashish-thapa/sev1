import { describe, expect, it } from "vitest";
import type { Role } from "../domain/incident.ts";
import { advance, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, iosUserAgent, NO_RETRY, SHOP_FLAGS, SHOP_REMOTE_CONFIG, WEB_USER_AGENT } from "./scenarios/checkout-commerce.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";
import { customerLossRate } from "./sim/commerce-step.ts";
import type { ClientDefect, Commerce } from "./sim/commerce.ts";

const AUTOCOMPLETE = "checkout.address_autocomplete";
const ADDRESS_V2 = "checkout_address_v2_enabled";

/** A calm builder-made shop whose web and iOS builds carry the given defects. */
function shop(defects: { readonly web?: readonly ClientDefect[]; readonly ios?: readonly ClientDefect[] }): Scenario {
  const commerce = checkoutCommerce({
    platforms: {
      web: { current: { version: "2026.10.10-1", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY, defects: defects.web } },
      ios: { current: { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: NO_RETRY, defects: defects.ios } },
    },
    flags: [
      {
        key: AUTOCOMPLETE,
        description: "Suggest addresses as the customer types",
        owner: "team-checkout-web",
        history: [{ at: -50 * 60, by: "web-release-bot", from: false, to: true, note: "web 2026.10.10-1" }],
      },
      ...SHOP_FLAGS,
    ],
    remoteConfig: [
      {
        key: ADDRESS_V2,
        description: "New address form on the checkout sheet",
        readBy: "ios >= 7.3.0",
        allowed: ["true", "false"],
        baseVersion: 3,
        history: [{ at: -2 * 3600, by: "jonah.reyes", from: "false", to: "true", note: "ramp to 100%" }],
      },
      ...SHOP_REMOTE_CONFIG,
    ],
  });
  return {
    ...scaledToZero,
    id: "client-defects-example",
    seed: "client-defects-example",
    roles: ["frontend", "mobile"],
    alertMetric: { label: "customers lost", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
    initialState: () =>
      checkoutCluster({
        seed: "client-defects-example",
        revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }],
        revision: 1,
        commerce,
      }),
  };
}

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function as(scenario: Scenario, role: Role, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  if (!result.cluster) throw new Error(result.output.map((output) => output.text).join("\n"));
  return { ...incident, cluster: result.cluster };
}

function lossOf(incident: Incident): number {
  const commerce: Commerce | undefined = incident.cluster.commerce;
  if (!commerce) throw new Error("example shop has no commerce");
  return customerLossRate(commerce, incident.cluster.t);
}

describe("client defects", () => {
  it("leaves a builder-made shop calm when no build has one", () => {
    const calm = play(shop({}), 10, openIncident(shop({})));
    expect(calm.cluster.errorRate).toBe(0);
    expect(lossOf(calm)).toBe(0);
  });

  it("answers a server-side defect's share of checkouts with 5xx", () => {
    const scenario = shop({ web: [{ trigger: "always", failShare: 0.6, where: "server", message: "TypeError: address.lines is undefined" }] });
    const incident = play(scenario, 10, openIncident(scenario));
    // 60% of web's 52% of checkouts, and checkouts are 40% of requests.
    expect(incident.cluster.errorRate).toBeCloseTo(0.4 * 0.52 * 0.6, 3);
    // Nobody retries, so every rejected checkout is a customer lost.
    expect(lossOf(incident)).toBeCloseTo(0.52 * 0.6, 3);
  });

  it("loses a client-side defect's customers without a single 5xx, so only a loss metric pages on it", () => {
    const scenario = shop({ ios: [{ trigger: "always", failShare: 0.5, where: "client", message: "TrustKit: pin validation failed" }] });
    const incident = play(scenario, 10, openIncident(scenario));
    expect(incident.cluster.errorRate).toBe(0);
    expect(lossOf(incident)).toBeCloseTo(0.36 * 0.5, 6);
    expect(incident.cluster.failedCheckouts).toBeCloseTo(10 * 300 * 0.4 * 0.36 * 0.5, 3);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
    expect(declareResolved(incident, { ...scenario, alertMetric: undefined }).notice).toBeUndefined();
  });

  it("clears a flag-triggered defect as the change reaches open tabs over 20 s", () => {
    const scenario = shop({ web: [{ trigger: { flag: AUTOCOMPLETE, failsWhenOn: true }, failShare: 0.6, where: "server", message: "POST /checkout 500 address_autocomplete" }] });
    const opened = play(scenario, 10, openIncident(scenario));
    const before = opened.cluster.errorRate;
    expect(before).toBeGreaterThan(0.1);

    // errorRate is the rate over the second just played, so the 11th second is the one 10 s after the flip.
    const flipped = as(scenario, "frontend", `flags set ${AUTOCOMPLETE} off`, opened);
    expect(play(scenario, 11, flipped).cluster.errorRate).toBeCloseTo(before / 2, 3);
    expect(play(scenario, 21, flipped).cluster.errorRate).toBe(0);
  });

  it("clears a remote-config-triggered defect as apps fetch the change over 120 s", () => {
    const scenario = shop({ ios: [{ trigger: { remoteConfig: ADDRESS_V2, failsWhen: "true" }, failShare: 0.5, where: "client", message: "Fatal error: Unexpectedly found nil" }] });
    const opened = play(scenario, 10, openIncident(scenario));
    const before = lossOf(opened);
    expect(before).toBeCloseTo(0.18, 6);

    const flipped = as(scenario, "mobile", `remote-config set ${ADDRESS_V2} false`, opened);
    expect(lossOf(play(scenario, 60, flipped))).toBeCloseTo(before / 2, 2);
    expect(lossOf(play(scenario, 120, flipped))).toBe(0);
  });

  it("is deterministic", () => {
    const scenario = shop({ web: [{ trigger: "always", failShare: 0.3, where: "server", message: "500" }] });
    expect(play(scenario, 60, openIncident(scenario))).toEqual(play(scenario, 60, openIncident(scenario)));
  });
});
