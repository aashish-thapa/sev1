import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { MOBILE_TIER2_INCIDENTS } from "./scenarios/mobile-tier2-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { latestChange, type Platform } from "./sim/commerce.ts";

const COMMAND_WORDS = /\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/;

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function shell(scenario: Scenario, incident: Incident, line: string): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" })
    .output.map((output) => output.text)
    .join("\n");
}

function act(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
  if (!result.cluster) throw new Error(`${line} changed nothing:\n${result.output.map((output) => output.text).join("\n")}`);
  return { ...incident, cluster: result.cluster };
}

function fixCommand(scenario: Scenario): string {
  const step = scenario.solution.mobile?.find((candidate) => candidate.command.startsWith("remote-config set "));
  if (!step) throw new Error(`${scenario.id} has no remote-config fix`);
  return step.command;
}

function culpritKey(scenario: Scenario): string {
  return fixCommand(scenario).split(" ")[2];
}

function platforms(scenario: Scenario): readonly Platform[] {
  return scenario.initialState().commerce?.platforms.filter((platform) => platform.id !== "web") ?? [];
}

/** The platform whose build fails: the one the worked solution checks at the end. */
function failingPlatform(scenario: Scenario): Platform {
  const id = scenario.solution.mobile?.at(-1)?.command.split(" ")[2];
  const platform = platforms(scenario).find((candidate) => candidate.id === id);
  if (!platform) throw new Error(`${scenario.id}: no failing platform`);
  return platform;
}

/** The plausible suspects: revert every other key changed this hour, and halt the other platform's rollout. */
function decoyMoves(scenario: Scenario): readonly string[] {
  const culprit = culpritKey(scenario);
  const reverts = (scenario.initialState().commerce?.remoteConfig ?? [])
    .filter((entry) => entry.key !== culprit && latestChange(entry.history).at > -3600)
    .map((entry) => `remote-config set ${entry.key} ${latestChange(entry.history).from}`);
  const failing = failingPlatform(scenario).id;
  const halts = platforms(scenario)
    .filter((platform) => platform.id !== failing && platform.rollout.kind === "phased")
    .map((platform) => `releases halt ${platform.id} ${platform.current.version}`);
  return [...reverts, ...halts];
}

function workedSolution(scenario: Scenario) {
  let incident = play(scenario, 20, openIncident(scenario));
  for (const step of scenario.solution.mobile ?? []) {
    const result = runLine(step.command, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
    const refusals = result.output.filter((line) => line.tone === "err").map((line) => line.text);
    expect(refusals, step.command).toEqual([]);
    if (result.cluster) incident = { ...incident, cluster: result.cluster };
    incident = play(scenario, 8, incident);
  }
  const declared = declareResolved(play(scenario, 180, incident), scenario);
  expect(declared.notice).toBeUndefined();
  const closed = play(scenario, 700, declared.incident);
  expect(closed.phase.name).toBe("closed");
  return debrief(closed, scenario, true);
}

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

describe("mobile tier 2 incidents", () => {
  it("are fourteen distinct incidents for mobile at tier 2", () => {
    const scenarios = MOBILE_TIER2_INCIDENTS;
    expect(scenarios).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) expect(new Set(scenarios.map((scenario) => scenario[field])).size).toBe(14);
    expect(new Set(scenarios.map(culpritKey)).size).toBe(14);
    for (const scenario of scenarios) {
      expect(scenario.id).toMatch(/^mob-t2-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(2);
      expect(scenario.roles).toEqual(["mobile"]);
    }
  });
});

describe.each(MOBILE_TIER2_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  const fix = fixCommand(scenario);
  const failing = failingPlatform(scenario);
  const isRollingOut = failing.rollout.kind === "phased";

  it("has clean hints, suggestions and one defensible postmortem answer", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    for (const hint of scenario.hints) {
      expect(hint).not.toMatch(COMMAND_WORDS);
      for (const step of scenario.solution.mobile ?? []) expect(hint).not.toContain(step.command);
    }
    expect(scenario.suggestions?.mobile?.some((chip) => chip.startsWith(`remote-config set ${culpritKey(scenario)}`))).toBe(false);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const others = options.filter((_, index) => index !== answerIndex);
    expect(options[answerIndex].length).toBeLessThan(Math.max(...others.map((option) => option.length)));
    for (const option of options) expect(option.length).toBeLessThanOrEqual(72);
    expect(explanation.cause.length).toBeLessThanOrEqual(100);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
  });

  it("only gets worse if nobody acts", () => {
    const opened = openIncident(scenario);
    const rate = alertRate(scenario, opened.cluster);
    expect(rate).toBeGreaterThan(0.02);
    const tenMinutes = play(scenario, 600, opened);
    const later = alertRate(scenario, tenMinutes.cluster);
    if (isRollingOut) expect(later).toBeGreaterThan(rate * 1.1);
    else expect(later).toBeCloseTo(rate, 6);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 30);
  });

  it("names the failing slice and the error in its release view", () => {
    const opened = openIncident(scenario);
    const view = scenario.evidence?.[0];
    if (!view) throw new Error("no evidence");
    const text = shell(scenario, opened, `releases ${view.name}`);
    expect(text).toMatch(/100\.0%/);
    expect(text).toMatch(/0\.0%/);
    const message = failing.current.defects?.[0]?.message;
    expect(message && text).toContain(message);
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("changes nothing when the other suspects are reverted or halted", () => {
    const moves = decoyMoves(scenario);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    const start = play(scenario, 30, openIncident(scenario));
    let incident = start;
    for (const line of moves) incident = act(scenario, incident, line);
    incident = play(scenario, 150, incident);
    const untouched = play(scenario, 150, start);
    expect(alertRate(scenario, incident.cluster)).toBeCloseTo(alertRate(scenario, untouched.cluster), 6);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
  });

  it.runIf(isRollingOut)("halting the failing rollout alone stops the spread but fixes nobody", () => {
    const halted = play(scenario, 150, act(scenario, play(scenario, 30, openIncident(scenario)), `releases halt ${failing.id} ${failing.current.version}`));
    expect(alertRate(scenario, halted.cluster)).toBeGreaterThan(0.02);
    expect(scenario.isRootCauseFixed(halted.cluster)).toBe(false);
    expect(declareResolved(halted, scenario).notice?.kind).toBe("refused");
  });

  it("clears within remote config's two-minute propagation once the culprit is reverted", () => {
    const incident = play(scenario, 121, act(scenario, play(scenario, 30, openIncident(scenario)), fix));
    expect(alertRate(scenario, incident.cluster)).toBeLessThan(0.01);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);
    expect(declareResolved(incident, scenario).notice).toBeUndefined();
  });

  it("is deterministic", () => {
    const run = () => play(scenario, 90, act(scenario, play(scenario, 30, openIncident(scenario)), fix));
    expect(run()).toEqual(run());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 20: fix });
  });
});
