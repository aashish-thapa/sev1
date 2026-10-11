import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { FRONTEND_TIER2_INCIDENTS } from "./scenarios/frontend-tier2-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { latestChange } from "./sim/commerce.ts";

const COMMAND_WORDS = /\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/;

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
  return { text: result.output.map((output) => output.text).join("\n"), incident: result.cluster ? { ...incident, cluster: result.cluster } : incident };
}

function act(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
  if (!result.cluster) throw new Error(`${line} changed nothing:\n${result.output.map((output) => output.text).join("\n")}`);
  return { ...incident, cluster: result.cluster };
}

function fixCommand(scenario: Scenario): string {
  const step = scenario.solution.frontend?.find((candidate) => candidate.command.startsWith("flags set "));
  if (!step) throw new Error(`${scenario.id} has no flag fix`);
  return step.command;
}

/** Every flag flipped in the hour before the page other than the culprit, with the command that flips it back. */
function decoyReverts(scenario: Scenario): readonly string[] {
  const culprit = fixCommand(scenario).split(" ")[2];
  return (scenario.initialState().commerce?.flags ?? [])
    .filter((flag) => flag.key !== culprit && latestChange(flag.history).at > -3600)
    .map((flag) => `flags set ${flag.key} ${latestChange(flag.history).from ? "on" : "off"}`);
}

function workedSolution(scenario: Scenario) {
  let incident = play(scenario, 20, openIncident(scenario));
  for (const step of scenario.solution.frontend ?? []) {
    const result = runLine(step.command, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
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

describe("frontend tier 2 incidents", () => {
  it("are fourteen distinct incidents for frontend at tier 2", () => {
    const scenarios = FRONTEND_TIER2_INCIDENTS;
    expect(scenarios).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) expect(new Set(scenarios.map((scenario) => scenario[field])).size).toBe(14);
    expect(new Set(scenarios.map((scenario) => fixCommand(scenario).split(" ")[2])).size).toBe(14);
    for (const scenario of scenarios) {
      expect(scenario.id).toMatch(/^fe-t2-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(2);
      expect(scenario.roles).toEqual(["frontend"]);
    }
  });
});

describe.each(FRONTEND_TIER2_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  const fix = fixCommand(scenario);

  it("has clean hints, suggestions and one defensible postmortem answer", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    for (const hint of scenario.hints) {
      expect(hint).not.toMatch(COMMAND_WORDS);
      for (const step of scenario.solution.frontend ?? []) expect(hint).not.toContain(step.command);
    }
    expect(scenario.suggestions?.frontend).not.toContain(fix);
    expect(scenario.suggestions?.frontend?.some((chip) => fix.startsWith(chip) && chip.startsWith("flags set"))).toBe(false);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const others = options.filter((_, index) => index !== answerIndex);
    expect(options[answerIndex].length).toBeLessThan(Math.max(...others.map((option) => option.length)));
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    expect(explanation.cause.length).toBeLessThanOrEqual(90);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
  });

  it("only gets worse if nobody acts", () => {
    const opened = openIncident(scenario);
    const rate = alertRate(scenario, opened.cluster);
    expect(rate).toBeGreaterThan(0.02);
    const tenMinutes = play(scenario, 600, opened);
    expect(alertRate(scenario, tenMinutes.cluster)).toBeCloseTo(rate, 6);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 40);
  });

  it("names the failing slice in its RUM breakdown and the cause in the console", () => {
    const opened = openIncident(scenario);
    const view = scenario.evidence?.[0];
    if (!view) throw new Error("no evidence");
    const breakdown = shell(scenario, opened, `rum ${view.name}`).text;
    expect(breakdown).toMatch(/100\.0%/);
    expect(breakdown).toMatch(/0\.0%/);
    const errors = shell(scenario, opened, "rum errors").text;
    const message = opened.cluster.commerce?.platforms.find((platform) => platform.id === "web")?.current.defects?.[0]?.message;
    expect(message && errors).toContain(message);
  });

  it("closes at S or A with the worked solution", () => {
    expect(["S", "A"]).toContain(workedSolution(scenario).grade);
  });

  it("changes nothing when the other flags flipped this hour go back", () => {
    const reverts = decoyReverts(scenario);
    expect(reverts.length).toBeGreaterThanOrEqual(2);
    let incident = play(scenario, 30, openIncident(scenario));
    const rate = alertRate(scenario, incident.cluster);
    for (const line of reverts) incident = act(scenario, incident, line);
    incident = play(scenario, 60, incident);
    expect(alertRate(scenario, incident.cluster)).toBeCloseTo(rate, 6);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
  });

  it("clears within the flag's 20 s propagation once the culprit flips back", () => {
    const incident = play(scenario, 21, act(scenario, play(scenario, 30, openIncident(scenario)), fix));
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
