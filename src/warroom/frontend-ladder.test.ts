import { describe, expect, it } from "vitest";
import { advance, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./scenarios/checkout-commerce.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";
import { findPlatform } from "./sim/commerce.ts";
import { rolloutLabel } from "./sim/rollout.ts";

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
  return { text: result.output.map((output) => output.text).join("\n"), incident: result.cluster ? { ...incident, cluster: result.cluster } : incident };
}

function webAdoption(incident: Incident): number {
  const web = incident.cluster.commerce && findPlatform(incident.cluster.commerce, "web");
  if (!web) throw new Error("no web platform");
  return web.adoption;
}

describe("service-worker rollout", () => {
  const KILL_SWITCH = "web.sw_kill_switch";
  const commerce = checkoutCommerce({
    platforms: {
      web: {
        current: { version: "2026.10.10-1", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY },
        previous: { version: "2026.10.09-2", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY },
        adoption: 0.3,
        rollout: { kind: "service-worker", killSwitchFlag: KILL_SWITCH, adoptionPerSecond: 0.01 },
      },
    },
    flags: [
      { key: KILL_SWITCH, description: "Old service workers unregister and reload their tabs", owner: "team-web-platform", history: [{ at: -86_400, by: "a", from: true, to: false, note: "drill over" }] },
      ...SHOP_FLAGS,
    ],
  });
  const scenario: Scenario = {
    ...scaledToZero,
    id: "service-worker-example",
    seed: "service-worker-example",
    roles: ["frontend"],
    initialState: () => checkoutCluster({ seed: "service-worker-example", revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3", traits: [] }], revision: 1, commerce }),
  };

  it("keeps tabs on the precached build until the kill switch is on, then moves them over at its rate", () => {
    const waited = play(scenario, 120, openIncident(scenario));
    expect(webAdoption(waited)).toBe(0.3);

    const switched = shell(scenario, waited, `flags set ${KILL_SWITCH} on`).incident;
    expect(webAdoption(play(scenario, 10, switched))).toBeCloseTo(0.4, 6);
    expect(webAdoption(play(scenario, 70, switched))).toBe(1);
  });

  it("shows each release's share of web sessions, and that the old one comes from the service worker", () => {
    const opened = openIncident(scenario);
    const web = opened.cluster.commerce && findPlatform(opened.cluster.commerce, "web");
    expect(web && rolloutLabel(web)).toContain(`70% of tabs still on the service worker's precache (kill switch: ${KILL_SWITCH})`);
    expect(shell(scenario, opened, "rum overview").text).toMatch(/2026\.10\.09-2\s+70%[\s\S]*2026\.10\.10-1\s+30%|2026\.10\.10-1\s+30%[\s\S]*2026\.10\.09-2\s+70%/);
    const session = shell(scenario, opened, "rum session").text;
    expect(session).toContain("release 2026.10.09-2 (70% of web sessions)");
    expect(session).toContain("(ServiceWorker)");
  });
});
