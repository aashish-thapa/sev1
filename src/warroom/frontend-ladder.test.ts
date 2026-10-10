import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./scenarios/checkout-commerce.ts";
import { addressAutocomplete500s } from "./scenarios/address-autocomplete-500s.ts";
import { deadKillSwitch } from "./scenarios/dead-kill-switch.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { staleServiceWorker } from "./scenarios/stale-service-worker.ts";
import { webAutoRetryStorm } from "./scenarios/web-auto-retry-storm.ts";
import { runLine } from "./shell/shell.ts";
import { unsafeRetryShare } from "./sim/clients.ts";
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

/** Runs a frontend command on `incident`, failing the test if the tool turns it down. */
function act(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
  if (!result.cluster) throw new Error(`${line} changed nothing:\n${result.output.map((output) => output.text).join("\n")}`);
  return { ...incident, cluster: result.cluster };
}

/** Plays the worked solution the way solutions.test.ts does: first move at 20 s, 8 s apart, then settles, declares and monitors. */
function workedSolution(scenario: Scenario) {
  let incident = play(scenario, 20, openIncident(scenario));
  for (const step of scenario.solution.frontend ?? []) {
    incident = shell(scenario, incident, step.command).incident;
    incident = play(scenario, 8, incident);
  }
  const settled = play(scenario, 180, incident);
  const declared = declareResolved(settled, scenario);
  expect(declared.notice).toBeUndefined();
  const closed = play(scenario, 700, declared.incident);
  expect(closed.phase.name).toBe("closed");
  return debrief(closed, scenario, true);
}

/** Debrief points if the incident were closed now: what doing nothing costs. */
function pointsAt(scenario: Scenario, incident: Incident): number {
  return debrief(incident, scenario, true).points;
}

/** Streams an incident to a client frame by frame, applying `moves` (second → command) on the server. */
function roundTrips(scenario: Scenario, moves: Readonly<Record<number, string>>): void {
  const relay = (previous: Incident | null, next: Incident) => applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
  let server = openIncident(scenario);
  let client = relay(null, server);
  for (let second = 0; second < 120; second += 1) {
    let next = advance(server, scenario).incident;
    const move = moves[second];
    if (move) next = act(scenario, next, move);
    client = relay(client, next);
    server = next;
  }
  expect(client).toEqual(server);
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
    expect(web && rolloutLabel(web)).toBe("deployed · 70% of tabs still run a service worker's precached build");
    expect(shell(scenario, opened, "rum overview").text).toMatch(/2026\.10\.09-2\s+70%[\s\S]*2026\.10\.10-1\s+30%|2026\.10\.10-1\s+30%[\s\S]*2026\.10\.09-2\s+70%/);
    const session = shell(scenario, opened, "rum session").text;
    expect(session).toContain("release 2026.10.09-2 (70% of web sessions)");
    expect(session).toContain("(ServiceWorker)");
  });
});

describe("tier 1: web-auto-retry-storm", () => {
  const scenario = webAutoRetryStorm;
  const retriesOff = 'flags set checkout.auto_retry off --note "retry storm"';

  it("opens mid retry storm, four requests per Pay tap, and only loses more checkouts if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.4);
    expect(shell(scenario, opened, "rum overview").text).toMatch(/2026\.10\.09-2\s+100%\s+[\d,]+\s+[\d,]+\s+4\.00/);
    const tenMinutes = play(scenario, 600, opened);
    expect(tenMinutes.cluster.errorRate).toBeGreaterThan(0.4);
    expect(pointsAt(scenario, tenMinutes)).toBeLessThan(pointsAt(scenario, opened) - 40);
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("drains within three minutes of the retries going off", () => {
    let incident = act(scenario, play(scenario, 30, openIncident(scenario)), retriesOff);
    incident = play(scenario, 180, incident);
    expect(incident.cluster.errorRate).toBe(0);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);
  });

  it("doesn't recover when the sale banner goes off: the storm sustains itself", () => {
    let incident = act(scenario, play(scenario, 30, openIncident(scenario)), "flags set home.sale_banner off");
    incident = play(scenario, 300, incident);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.4);
    expect(incident.cluster.commerce && unsafeRetryShare(incident.cluster.commerce, incident.cluster.t)).toBeCloseTo(0.52, 6);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
  });

  it("is deterministic", () => {
    const run = () => play(scenario, 200, act(scenario, play(scenario, 30, openIncident(scenario)), retriesOff));
    expect(run()).toEqual(run());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 20: retriesOff });
  });
});

describe("tier 2: address-autocomplete-500s", () => {
  const scenario = addressAutocomplete500s;
  const autocompleteOff = 'flags set checkout.address_autocomplete off --note "region 500s"';
  // 60% of web's 52% of checkouts, and checkouts are 40% of requests.
  const OPENING_RATE = 0.4 * 0.52 * 0.6;

  it("opens with a steady share of web checkouts failing, and only loses more if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeCloseTo(OPENING_RATE, 6);
    const tenMinutes = play(scenario, 600, opened);
    expect(tenMinutes.cluster.errorRate).toBeCloseTo(OPENING_RATE, 6);
    expect(pointsAt(scenario, tenMinutes)).toBeLessThan(pointsAt(scenario, opened) - 40);
  });

  it("names the failing field in RUM, and the flag that fills it flipped when the errors began", () => {
    const opened = openIncident(scenario);
    const errors = shell(scenario, opened, "rum errors").text;
    expect(errors).toContain("Failed to load resource: the server responded with a status of 500 (Internal Server Error)");
    expect(errors).toContain('unknown region \\"California\\"');
    expect(shell(scenario, opened, "flags list").text).toMatch(/checkout\.address_autocomplete\s+on\s+team-checkout-web\s+13:09:00/);
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("changes nothing when the other flags flipped this hour go off", () => {
    let incident = play(scenario, 30, openIncident(scenario));
    incident = act(scenario, incident, "flags set checkout.gift_message off");
    incident = act(scenario, incident, "flags set home.sale_banner off");
    incident = play(scenario, 60, incident);
    expect(incident.cluster.errorRate).toBeCloseTo(OPENING_RATE, 6);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
  });

  it("clears within the flag's 20 s propagation", () => {
    const incident = play(scenario, 21, act(scenario, play(scenario, 30, openIncident(scenario)), autocompleteOff));
    expect(incident.cluster.errorRate).toBe(0);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);
  });

  it("is deterministic", () => {
    const run = () => play(scenario, 90, act(scenario, play(scenario, 30, openIncident(scenario)), autocompleteOff));
    expect(run()).toEqual(run());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 20: autocompleteOff });
  });
});

describe("tier 3: dead-kill-switch", () => {
  const scenario = deadKillSwitch;
  const walletOff = 'flags set checkout.v2_wallet_autofill off --note "wallet cards 500"';
  const killSwitch = "flags set checkout.payment_element_v2 off";
  // A quarter of web's 52% of checkouts; every web checkout once the v1 fallback is live.
  const OPENING_RATE = 0.4 * 0.52 * 0.25;
  const FALLBACK_RATE = 0.4 * 0.52;

  /** Plays to the end of a 15-minute incident and scores it as if closed there. */
  const pointsAfter = (moves: readonly (readonly [number, string])[]) => {
    let incident = openIncident(scenario);
    for (const [at, line] of moves) incident = act(scenario, play(scenario, at - incident.cluster.t, incident), line);
    return pointsAt(scenario, play(scenario, 900 - incident.cluster.t, incident));
  };

  it("opens with a quarter of web checkouts failing, and only loses more if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeCloseTo(OPENING_RATE, 6);
    const tenMinutes = play(scenario, 600, opened);
    expect(tenMinutes.cluster.errorRate).toBeCloseTo(OPENING_RATE, 6);
    expect(pointsAt(scenario, tenMinutes)).toBeLessThan(pointsAt(scenario, opened) - 40);
  });

  it("puts every 500 on the wallet path in RUM, beside a fallback nobody has used in weeks", () => {
    const paths = shell(scenario, openIncident(scenario), "rum payment-paths").text;
    expect(paths).toMatch(/wallet autofill\s+25\.0%\s+100\.0%/);
    expect(paths).toMatch(/kill-switch fallback\s+0\.0%\s+— \(no sessions since 2026-09-02\)/);
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("backfires when the runbook's kill switch is pulled: every web checkout 500s on the dead v1 tokenizer", () => {
    const pulled = play(scenario, 25, act(scenario, play(scenario, 30, openIncident(scenario)), killSwitch));
    expect(pulled.cluster.errorRate).toBeCloseTo(FALLBACK_RATE, 6);
    expect(shell(scenario, pulled, "rum errors").text).toContain("payments-vault POST /v1/tokens: 410 Gone");
    expect(declareResolved(pulled, scenario).notice?.kind).toBe("refused");

    const alsoWalletOff = play(scenario, 60, act(scenario, pulled, walletOff));
    expect(alsoWalletOff.cluster.errorRate).toBeCloseTo(FALLBACK_RATE, 6);
    expect(scenario.isRootCauseFixed(alsoWalletOff.cluster)).toBe(false);
  });

  it("recovers once the kill switch goes back on and wallet autofill goes off, but scores below the narrow fix", () => {
    const narrow = pointsAfter([[40, walletOff]]);
    const backfired = pointsAfter([
      [40, killSwitch],
      [100, "flags set checkout.payment_element_v2 on"],
      [110, walletOff],
    ]);
    expect(backfired).toBeLessThan(narrow - 15);

    let incident = act(scenario, play(scenario, 40, openIncident(scenario)), killSwitch);
    incident = act(scenario, play(scenario, 60, incident), "flags set checkout.payment_element_v2 on");
    incident = play(scenario, 30, act(scenario, incident, walletOff));
    expect(incident.cluster.errorRate).toBe(0);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);
  });

  it("is deterministic", () => {
    const run = () => play(scenario, 90, act(scenario, play(scenario, 30, openIncident(scenario)), killSwitch));
    expect(run()).toEqual(run());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 20: killSwitch, 50: "flags set checkout.payment_element_v2 on", 60: walletOff });
  });
});

describe("tier 4: stale-service-worker", () => {
  const scenario = staleServiceWorker;
  const killSwitchOn = 'flags set web.sw_kill_switch on --note "old worker pins tabs to the bad build"';
  // 70% of web's 52% of customers are on the precached build, which retries without an Idempotency-Key.
  const STALE_SHARE = 0.52 * 0.7;

  it("opens mid storm with most web tabs on the replaced build, and nothing moves them if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.4);
    expect(shell(scenario, opened, "rum overview").text).toMatch(/2026\.10\.09-2\s+70%\s+[\d,]+\s+[\d,]+\s+4\.00/);
    const tenMinutes = play(scenario, 600, opened);
    expect(webAdoption(tenMinutes)).toBe(0.3);
    expect(tenMinutes.cluster.errorRate).toBeGreaterThan(0.4);
    expect(pointsAt(scenario, tenMinutes)).toBeLessThan(pointsAt(scenario, opened) - 40);
  });

  it("shows the old build coming from the service worker's precache, with the new worker waiting", () => {
    const opened = openIncident(scenario);
    expect(shell(scenario, opened, "rum session").text).toContain("GET / 200 (ServiceWorker)");
    const worker = shell(scenario, opened, "rum service-worker").text;
    expect(worker).toMatch(/#412 activated and is running\s+2026\.10\.09-2\s+70% of tabs/);
    expect(worker).toContain("#413 waiting to activate");
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("moves every tab to the new build within three minutes of the kill switch, and the storm drains", () => {
    const switched = act(scenario, play(scenario, 30, openIncident(scenario)), killSwitchOn);
    const adopted = play(scenario, 90, switched);
    expect(webAdoption(adopted)).toBeGreaterThanOrEqual(0.99);
    expect(scenario.isRootCauseFixed(adopted.cluster)).toBe(true);
    expect(play(scenario, 180, switched).cluster.errorRate).toBe(0);
  });

  it("doesn't move when auto-retry goes off: the precached build's retries ignore the flag", () => {
    let incident = act(scenario, play(scenario, 30, openIncident(scenario)), "flags set checkout.auto_retry off");
    incident = play(scenario, 300, incident);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.4);
    expect(webAdoption(incident)).toBe(0.3);
    expect(incident.cluster.commerce && unsafeRetryShare(incident.cluster.commerce, incident.cluster.t)).toBeCloseTo(STALE_SHARE, 6);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
  });

  it("is deterministic", () => {
    const run = () => play(scenario, 200, act(scenario, play(scenario, 30, openIncident(scenario)), killSwitchOn));
    expect(run()).toEqual(run());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 20: killSwitchOn });
  });
});
