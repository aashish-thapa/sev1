import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { FRONTEND_TIER1_INCIDENTS } from "./scenarios/frontend-tier1-incidents.ts";
import { runLine } from "./shell/shell.ts";

const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

/** Runs a frontend command, failing the test if the shell or a tool turns it down. */
function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

/** Plays the worked solution like solutions.test.ts: first move at 20 s, 8 s apart, 180 s settle, declare, 700 s monitoring. */
function workedSolution(scenario: Scenario) {
  let incident = play(scenario, 20, openIncident(scenario));
  for (const step of scenario.solution.frontend ?? []) incident = play(scenario, 8, run(scenario, incident, step.command));
  const declared = declareResolved(play(scenario, 180, incident), scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  const closed = play(scenario, 700, declared.incident);
  expect(closed.phase.name).toBe("closed");
  return debrief(closed, scenario, true);
}

function fixCommand(scenario: Scenario): string {
  const fix = scenario.solution.frontend?.find((step) => step.command.startsWith("flags set "));
  if (!fix) throw new Error(`${scenario.id} has no flag fix`);
  return fix.command;
}

/** The suggestion chip that flips the flag a teammate blames. */
function decoyCommand(scenario: Scenario): string {
  const decoy = scenario.suggestions?.frontend?.find((line) => line.startsWith("flags set "));
  if (!decoy) throw new Error(`${scenario.id} has no decoy`);
  return decoy;
}

/** Retry storms need the gateway queue to drain; flag defects clear once the flag reaches every tab. */
const isStorm = (scenario: Scenario) => scenario.externals.some((external) => external.status === "degraded");

function roundTrips(scenario: Scenario, moves: Readonly<Record<number, string>>): void {
  const relay = (previous: Incident | null, next: Incident) => applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
  let server = openIncident(scenario);
  let client = relay(null, server);
  for (let second = 0; second < 120; second += 1) {
    let next = advance(server, scenario).incident;
    const move = moves[second];
    if (move) next = run(scenario, next, move);
    client = relay(client, next);
    server = next;
  }
  expect(client).toEqual(server);
}

describe("frontend tier 1 incidents: catalogue", () => {
  it("has fourteen distinct frontend tier 1 incidents", () => {
    expect(FRONTEND_TIER1_INCIDENTS).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) expect(new Set(FRONTEND_TIER1_INCIDENTS.map((scenario) => scenario[field])).size).toBe(14);
    for (const scenario of FRONTEND_TIER1_INCIDENTS) {
      expect(scenario.id).toMatch(/^fe-t1-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(1);
      expect(scenario.roles).toEqual(["frontend"]);
      expect(scenario.roleBriefings?.frontend).toBeTruthy();
    }
    expect(new Set(FRONTEND_TIER1_INCIDENTS.map(fixCommand)).size).toBe(14);
  });
});

describe.each(FRONTEND_TIER1_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("has hints and suggestions that never give the fix away, and a postmortem whose answer isn't the longest", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = scenario.solution.frontend?.map((step) => step.command) ?? [];
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixFlag = fixCommand(scenario).split(" ")[2];
    for (const chip of scenario.suggestions?.frontend ?? []) expect(chip.startsWith(`flags set ${fixFlag}`), chip).toBe(false);
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("gets worse if nobody acts for ten minutes", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.02);
    const idle = play(scenario, 600, opened);
    expect(alertRate(scenario, idle.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, opened.cluster) * 0.9);
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 30);
  });

  it("closes at S or A with the worked solution", () => {
    const result = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("changes nothing when the flag a teammate blames is flipped", () => {
    const before = play(scenario, 30, openIncident(scenario));
    const flipped = play(scenario, isStorm(scenario) ? 300 : 60, run(scenario, before, decoyCommand(scenario)));
    expect(alertRate(scenario, flipped.cluster)).toBeGreaterThan(0.02);
    expect(alertRate(scenario, flipped.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, before.cluster) * 0.9);
    expect(scenario.isRootCauseFixed(flipped.cluster)).toBe(false);
    expect(declareResolved(flipped, scenario).notice?.kind).toBe("refused");
  });

  it("clears once the culprit flag is flipped back", () => {
    const fixed = play(scenario, isStorm(scenario) ? 200 : 25, run(scenario, play(scenario, 30, openIncident(scenario)), fixCommand(scenario)));
    expect(scenario.isRootCauseFixed(fixed.cluster)).toBe(true);
    expect(alertRate(scenario, fixed.cluster)).toBeLessThan(0.01);
  });

  it("is deterministic", () => {
    const once = () => play(scenario, 90, run(scenario, play(scenario, 30, openIncident(scenario)), fixCommand(scenario)));
    expect(once()).toEqual(once());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 15: decoyCommand(scenario), 20: fixCommand(scenario) });
  });
});
