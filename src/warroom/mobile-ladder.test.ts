import { describe, expect, it } from "vitest";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, iosUserAgent, NO_RETRY } from "./scenarios/checkout-commerce.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";
import { clientSegments } from "./sim/clients.ts";
import type { Commerce, RemoteConfigEntry } from "./sim/commerce.ts";
import { isOlderThan, updateWall } from "./sim/update-wall.ts";

const MIN_VERSION = "min_supported_version";

/** The calm shop with one more published value of `key` at `at`. */
function publish(commerce: Commerce, key: string, value: string, at: number): Commerce {
  return {
    ...commerce,
    remoteConfig: commerce.remoteConfig.map((entry): RemoteConfigEntry => {
      if (entry.key !== key) return entry;
      const from = entry.history.at(-1)?.to ?? entry.history[0].to;
      return { ...entry, history: [...entry.history, { at, by: "test", from, to: value, note: "" }] };
    }),
  };
}

function walled(commerce: Commerce, t: number): Record<string, number> {
  return Object.fromEntries(clientSegments(commerce, t).map((segment) => [segment.id, updateWall(commerce, segment, t)]));
}

describe("the update wall", () => {
  const walledShop = checkoutCommerce({ updateWall: { configKey: MIN_VERSION } });

  it("orders versions by number, not by text", () => {
    expect(isOlderThan("7.3.0", "7.3.1")).toBe(true);
    expect(isOlderThan("7.3.1", "7.3.1")).toBe(false);
    expect(isOlderThan("7.9.0", "7.10.0")).toBe(true);
    expect(isOlderThan("7.10.0", "7.9.0")).toBe(false);
    expect(isOlderThan("7.3", "7.3.0")).toBe(false);
    expect(isOlderThan("7.2.4", "7.3")).toBe(true);
    expect(isOlderThan("7.3.0", "latest")).toBe(false);
  });

  it("walls nobody on a calm day, or where no scenario configured one", () => {
    expect(Object.values(walled(walledShop, 0)).every((share) => share === 0)).toBe(true);
    const raised = publish(checkoutCommerce(), MIN_VERSION, "9.0.0", -600);
    expect(Object.values(walled(raised, 0)).every((share) => share === 0)).toBe(true);
  });

  it("walls app builds below a new minimum as apps fetch it over 120 s, and never the web", () => {
    const raised = publish(walledShop, MIN_VERSION, "7.3.1", 0);
    expect(walled(raised, 60)).toEqual({ "web@2026.10.09-2": 0, "ios@7.3.0": 0.5, "android@7.2.4": 0.5 });
    expect(walled(raised, 120)).toEqual({ "web@2026.10.09-2": 0, "ios@7.3.0": 1, "android@7.2.4": 1 });
    expect(walled(publish(walledShop, MIN_VERSION, "7.3.0", 0), 120)).toEqual({ "web@2026.10.09-2": 0, "ios@7.3.0": 0, "android@7.2.4": 1 });
  });

  it("lifts as apps fetch a lower minimum, and ignores one that isn't a version", () => {
    const lowered = publish(publish(walledShop, MIN_VERSION, "7.3.1", -300), MIN_VERSION, "7.0.0", 0);
    expect(walled(lowered, 30)["ios@7.3.0"]).toBe(0.75);
    expect(walled(lowered, 120)["ios@7.3.0"]).toBe(0);
    expect(walled(publish(walledShop, MIN_VERSION, "7.3.1 please", 0), 120)["ios@7.3.0"]).toBe(0);
  });
});

describe("releases status", () => {
  it("shows each build's failed checkouts and who is stuck on the forced-update screen", () => {
    const defective = { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: NO_RETRY, defects: [{ trigger: "always", failShare: 0.5, where: "server", message: "500" }] } as const;
    const commerce = publish(checkoutCommerce({ platforms: { ios: { current: defective } }, updateWall: { configKey: MIN_VERSION } }), MIN_VERSION, "7.3.0", -600);
    const scenario: Scenario = { ...scaledToZero, id: "releases-example", seed: "releases-example", roles: ["mobile"] };
    const cluster = checkoutCluster({ seed: "releases-example", revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3", traits: [] }], revision: 1, commerce });
    const lines = runLine("releases status", { cluster, scenario, history: [], role: "mobile" }).output.map((line) => line.text);
    expect(lines[0]).toMatch(/REQ\/ORDER\s+FAILED$/);
    expect(lines.find((line) => line.startsWith("ios"))).toMatch(/1\.00\s+50\.0%$/);
    expect(lines.find((line) => line.startsWith("android"))).toMatch(/1\.00\s+100\.0%$/);
    expect(lines).toContain("Android 7.2.4: 100.0% of sessions are on the forced-update screen.");
  });
});
