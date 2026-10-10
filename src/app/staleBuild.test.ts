import { describe, expect, it } from "vitest";
import { reloadOnStaleBuild } from "./staleBuild.ts";

function fakePage() {
  const target = new EventTarget();
  let reloads = 0;
  const page = Object.assign(target, { location: { reload: () => (reloads += 1) } });
  const fail = () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { page, fail, reloads: () => reloads };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

describe("reloading a tab that outlived a deploy", () => {
  it("reloads once when a chunk fails, then lets a repeat failure through", () => {
    const { page, fail, reloads } = fakePage();
    let now = 1_000_000;
    reloadOnStaleBuild(page, memoryStorage(), () => now);
    expect(fail()).toBe(true);
    now += 5_000;
    expect(fail()).toBe(false);
    expect(reloads()).toBe(1);
  });

  it("tries again once the guard window has passed", () => {
    const { page, fail, reloads } = fakePage();
    let now = 1_000_000;
    reloadOnStaleBuild(page, memoryStorage(), () => now);
    fail();
    now += 60_000;
    expect(fail()).toBe(true);
    expect(reloads()).toBe(2);
  });

  it("never reloads without storage, since it couldn't stop a loop", () => {
    const { page, fail, reloads } = fakePage();
    reloadOnStaleBuild(page, null);
    expect(fail()).toBe(false);
    expect(reloads()).toBe(0);
  });
});
