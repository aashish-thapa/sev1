import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { FRONTEND_TIER4_INCIDENTS } from "./scenarios/frontend-tier4-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { findPlatform } from "./sim/commerce.ts";

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

function shellText(scenario: Scenario, incident: Incident, line: string): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "frontend" })
    .output.map((output) => output.text)
    .join("\n");
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

function killSwitchCommand(scenario: Scenario): string {
  const fix = scenario.solution.frontend?.find((step) => step.command.startsWith("flags set "));
  if (!fix) throw new Error(`${scenario.id} has no kill-switch step`);
  return fix.command;
}

/** The suggestion chip with the usual fix: the flag teammates and the runbook reach for. */
function usualFixCommand(scenario: Scenario): string {
  const usual = scenario.suggestions?.frontend?.find((line) => line.startsWith("flags set "));
  if (!usual) throw new Error(`${scenario.id} has no usual-fix chip`);
  return usual;
}

function webAdoption(incident: Incident): number {
  const web = incident.cluster.commerce && findPlatform(incident.cluster.commerce, "web");
  if (!web) throw new Error("no web platform");
  return web.adoption;
}

/** Retry storms need the gateway queue to drain after the tabs move. */
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

describe("frontend tier 4 incidents: catalogue", () => {
  it("has fourteen distinct frontend tier 4 incidents", () => {
    expect(FRONTEND_TIER4_INCIDENTS).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) expect(new Set(FRONTEND_TIER4_INCIDENTS.map((scenario) => scenario[field])).size).toBe(14);
    for (const scenario of FRONTEND_TIER4_INCIDENTS) {
      expect(scenario.id).toMatch(/^fe-t4-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(4);
      expect(scenario.roles).toEqual(["frontend"]);
      expect(scenario.roleBriefings?.frontend).toBeTruthy();
    }
    expect(new Set(FRONTEND_TIER4_INCIDENTS.map(killSwitchCommand)).size).toBe(14);
    expect(new Set(FRONTEND_TIER4_INCIDENTS.map(usualFixCommand)).size).toBe(14);
  });
});

describe.each(FRONTEND_TIER4_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  const storm = isStorm(scenario);

  it("has hints and suggestions that never give the fix away, and a postmortem whose answer isn't the longest", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = scenario.solution.frontend?.map((step) => step.command) ?? [];
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const killSwitch = killSwitchCommand(scenario).split(" ")[2];
    for (const chip of scenario.suggestions?.frontend ?? []) expect(chip.startsWith(`flags set ${killSwitch}`), chip).toBe(false);
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("shows the stale build coming from a service worker, with the new worker waiting", () => {
    const opened = openIncident(scenario);
    expect(shellText(scenario, opened, "rum session")).toContain("(ServiceWorker)");
    const view = scenario.evidence?.[0];
    if (!view) throw new Error("no evidence view");
    expect(shellText(scenario, opened, `rum ${view.name}`)).toContain("waiting to activate");
  });

  it("gets worse if nobody acts for ten minutes, and no tab moves on its own", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(storm ? 0.4 : 0.02);
    const idle = play(scenario, 600, opened);
    expect(webAdoption(idle)).toBe(webAdoption(opened));
    expect(alertRate(scenario, idle.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, opened.cluster) * 0.9);
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 30);
  });

  it("closes at S or A with the worked solution", () => {
    const result = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("does nothing when the usual flag fix is applied: the precached build never reads it", () => {
    const before = play(scenario, 30, openIncident(scenario));
    const flipped = play(scenario, storm ? 300 : 60, run(scenario, before, usualFixCommand(scenario)));
    expect(webAdoption(flipped)).toBe(webAdoption(before));
    expect(alertRate(scenario, flipped.cluster)).toBeGreaterThan(storm ? 0.4 : 0.02);
    expect(alertRate(scenario, flipped.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, before.cluster) * 0.9);
    expect(scenario.isRootCauseFixed(flipped.cluster)).toBe(false);
    expect(declareResolved(flipped, scenario).notice?.kind).toBe("refused");
  });

  it("moves every tab to the deployed build once the old worker's kill switch is on, and the alert clears", () => {
    const switched = play(scenario, 200, run(scenario, play(scenario, 30, openIncident(scenario)), killSwitchCommand(scenario)));
    expect(webAdoption(switched)).toBeGreaterThanOrEqual(0.99);
    expect(scenario.isRootCauseFixed(switched.cluster)).toBe(true);
    expect(alertRate(scenario, switched.cluster)).toBeLessThan(0.01);
  });

  it("is deterministic", () => {
    const once = () => play(scenario, 120, run(scenario, play(scenario, 30, openIncident(scenario)), killSwitchCommand(scenario)));
    expect(once()).toEqual(once());
  });

  it("round-trips through multiplayer frames", () => {
    roundTrips(scenario, { 15: usualFixCommand(scenario), 20: killSwitchCommand(scenario) });
  });
});
