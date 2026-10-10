import { describe, expect, it } from "vitest";
import { checkoutCommerce } from "./scenarios/checkout-commerce.ts";
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
