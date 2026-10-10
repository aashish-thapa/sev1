import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { androidStagedRollout500s } from "./scenarios/android-staged-rollout-500s.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, iosUserAgent, NO_RETRY } from "./scenarios/checkout-commerce.ts";
import { forcedUpdateWall } from "./scenarios/forced-update-wall.ts";
import { iosRetryConfig } from "./scenarios/ios-retry-config.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";
import { clientSegments, unsafeRetryShare } from "./sim/clients.ts";
import { customerLossRate } from "./sim/commerce-step.ts";
import { findPlatform, type Commerce, type RemoteConfigEntry } from "./sim/commerce.ts";
import { isOlderThan, updateWall } from "./sim/update-wall.ts";

const MIN_VERSION = "min_supported_version";
/** The mobile ladder, easiest first. */
const LADDER: readonly Scenario[] = [iosRetryConfig, androidStagedRollout500s, forcedUpdateWall];
/** As solutions.test.ts plays a worked answer: the first move 20 s after the page, a command every 8 s, then 180 s to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const MONITORING_SECONDS = 700;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, incident: Incident, t: number): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

/** Runs a command on the mobile laptop; fails the test unless the tool accepted it and changed something. */
function as(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
  const errors = result.output.filter((output) => output.tone === "err").map((output) => output.text);
  if (!result.cluster || errors.length > 0) throw new Error(`mobile$ ${line}\n${result.output.map((output) => output.text).join("\n")}`);
  return { ...incident, cluster: result.cluster };
}

function text(scenario: Scenario, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" })
    .output.map((output) => output.text)
    .join("\n");
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("mobile incidents run with commerce");
  return commerce;
}

/** The worked solution, step by step through the shell as a player types it. */
function solve(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.mobile ?? []) {
    const result = runLine(step.command, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
    if (result.cluster) incident = { ...incident, cluster: result.cluster };
    incident = play(scenario, incident, THINKING_SECONDS);
  }
  return play(scenario, incident, SETTLE_SECONDS);
}

/** Declares resolved and runs out the monitoring window; `notice` is set when the pager refuses. */
function resolve(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  return { refused: declared.notice, closed: play(scenario, declared.incident, MONITORING_SECONDS) };
}

/** Plays `moves` (first at 20 s after the page), waits out remote-config propagation, then tries to resolve. */
function tryFix(scenario: Scenario, ...moves: readonly string[]) {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const move of moves) incident = play(scenario, as(scenario, move, incident), THINKING_SECONDS);
  const settled = play(scenario, incident, SETTLE_SECONDS);
  return { settled, ...resolve(scenario, settled) };
}

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

describe.each(LADDER.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("pages the mobile role alone, at its own tier", () => {
    expect(scenario.roles).toEqual(["mobile"]);
    expect(scenario.tier).toBe(LADDER.indexOf(scenario) + 1);
  });

  it("gets worse over ten minutes if nobody acts", () => {
    const opened = openIncident(scenario);
    const twoMinutes = playTo(scenario, opened, 120);
    const tenMinutes = playTo(scenario, twoMinutes, 600);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.01);
    expect(alertRate(scenario, tenMinutes.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, opened.cluster));
    expect(tenMinutes.cluster.failedCheckouts).toBeGreaterThan(twoMinutes.cluster.failedCheckouts * 4);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(twoMinutes, scenario, true).points);
    expect(declareResolved(tenMinutes, scenario).notice?.kind).toBe("refused");
  });

  it("closes at grade S or A when the worked solution is typed into the shell", () => {
    const { refused, closed } = resolve(scenario, solve(scenario));
    expect(refused).toBeUndefined();
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("publishes its remote-config fix first, since apps take two minutes to fetch it", () => {
    expect(scenario.solution.mobile?.[0].command).toMatch(/^remote-config set /);
  });

  it("is deterministic", () => {
    expect(solve(scenario)).toEqual(solve(scenario));
  });

  it("round-trips its state through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const fix = scenario.solution.mobile?.[0].command ?? "";
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 150; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === FIRST_MOVE_AT) next = as(scenario, fix, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});

describe("ios-retry-config: the iOS retry storm", () => {
  const scenario = iosRetryConfig;

  it("opens mid storm: iOS 7.3.0 sends four checkout requests per order and every build fails", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.4);
    const status = text(scenario, "releases status ios", opened);
    expect(status).toMatch(/ios\s+7\.3\.0\s.*4\.00\s+100\.0%/);
    expect(status).toMatch(/ios\s+7\.2\.4\s.*1\.00\s/);
  });

  it("drains within about 150 s of the remote-config change", () => {
    let incident = as(scenario, "remote-config set checkout_retry_policy backoff", play(scenario, openIncident(scenario), FIRST_MOVE_AT));
    incident = play(scenario, incident, 150);
    expect(incident.cluster.errorRate).toBeLessThan(0.01);
    expect(unsafeRetryShare(commerceOf(incident), incident.cluster.t)).toBe(0);
  });

  it("halting the phased release leaves the storm where it was", () => {
    const opened = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
    const { settled, refused } = tryFix(scenario, "releases halt ios 7.3.0");
    expect(settled.cluster.errorRate).toBeGreaterThan(0.4);
    expect(settled.cluster.errorRate).toBeCloseTo(opened.cluster.errorRate, 2);
    expect(findPlatform(commerceOf(settled), "ios")?.adoption).toBe(findPlatform(commerceOf(opened), "ios")?.adoption);
    expect(refused?.kind).toBe("refused");
    expect(text(scenario, "releases rollback ios 7.3.0", settled)).toContain("no rollback");
  });
});

describe("android-staged-rollout-500s: a growing staged rollout behind a remote-config switch", () => {
  const scenario = androidStagedRollout500s;
  const V2_OFF = "remote-config set android_checkout_v2_enabled false";
  const HALT = "releases halt android 7.3.0";

  it("fails most of Android 7.3.0's checkouts and no other build's", () => {
    const status = text(scenario, "releases status", openIncident(scenario));
    expect(status).toMatch(/android\s+7\.3\.0\s.*80\.0%/);
    expect(status).toMatch(/android\s+7\.2\.4\s.*\s0\.0%/);
    expect(status).toMatch(/ios\s+7\.3\.0\s.*\s0\.0%/);
  });

  it("gets worse as the rollout reaches more phones", () => {
    const opened = openIncident(scenario);
    const tenMinutes = playTo(scenario, opened, 600);
    expect(tenMinutes.cluster.errorRate).toBeGreaterThan(opened.cluster.errorRate * 1.5);
    expect(findPlatform(commerceOf(tenMinutes), "android")?.adoption).toBeGreaterThan(0.6);
  });

  it("halting alone stops the growth but leaves errors flat above the resolve gate", () => {
    const { settled, refused } = tryFix(scenario, HALT);
    const halted = playTo(scenario, settled, 600);
    expect(halted.cluster.errorRate).toBeGreaterThan(0.03);
    expect(halted.cluster.errorRate).toBeCloseTo(settled.cluster.errorRate, 6);
    expect(refused?.kind).toBe("refused");
  });

  it("halting the healthy iOS release changes nothing", () => {
    const { settled, refused } = tryFix(scenario, "releases halt ios 7.3.0");
    expect(settled.cluster.errorRate).toBeGreaterThan(openIncident(scenario).cluster.errorRate);
    expect(refused?.kind).toBe("refused");
  });

  it("the remote-config fix without the halt closes, but misses the halt objective and scores lower", () => {
    const { refused, closed } = tryFix(scenario, V2_OFF);
    expect(refused).toBeUndefined();
    const withoutHalt = debrief(closed, scenario, true);
    expect(withoutHalt.isRootCauseFixed).toBe(true);
    expect(withoutHalt.objectives?.find((objective) => objective.role === "mobile")?.isMet).toBe(false);
    expect(withoutHalt.points).toBeLessThan(debrief(tryFix(scenario, V2_OFF, HALT).closed, scenario, true).points);
  });
});

describe("forced-update-wall: forcing an update to a build that isn't out", () => {
  const scenario = forcedUpdateWall;
  const WALL = "remote-config set min_supported_version 7.3.1";
  const ADDRESS_OFF = "remote-config set checkout_address_v2_enabled false";
  const loss = (incident: Incident) => customerLossRate(commerceOf(incident), incident.cluster.t);

  it("pages on the worse of 5xx and lost customers: half of iOS 7.3.0's checkouts fail", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeCloseTo(0.4 * 0.36 * 0.95 * 0.5, 6);
    expect(alertRate(scenario, opened.cluster)).toBeCloseTo(0.36 * 0.95 * 0.5, 6);
    expect(text(scenario, "releases status ios", opened)).toMatch(/ios\s+7\.3\.1\s+in review/);
  });

  it("raising the minimum version backfires: 5xx falls, customer loss rises, resolve is refused", () => {
    const opened = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
    const { settled, refused } = tryFix(scenario, WALL);
    expect(settled.cluster.errorRate).toBeLessThan(0.001);
    expect(loss(settled)).toBeGreaterThan(0.36);
    expect(loss(settled)).toBeGreaterThan(loss(opened) * 2);
    expect(refused).toEqual({ kind: "refused", rate: loss(settled), label: "checkout 5xx or loss" });
    expect(text(scenario, "releases status ios", settled)).toContain("iOS 7.3.0: 100.0% of sessions are on the forced-update screen.");
  });

  it("the wall still refuses resolve after the real fix, until the minimum comes back down", () => {
    const walled = tryFix(scenario, WALL, ADDRESS_OFF);
    expect(walled.refused?.kind).toBe("refused");
    const lowered = play(scenario, as(scenario, "remote-config set min_supported_version 7.0.0", walled.settled), SETTLE_SECONDS);
    expect(alertRate(scenario, lowered.cluster)).toBe(0);
    const { refused, closed } = resolve(scenario, lowered);
    expect(refused).toBeUndefined();
    expect(debrief(closed, scenario, true).points).toBeLessThan(debrief(resolve(scenario, solve(scenario)).closed, scenario, true).points);
  });
});
