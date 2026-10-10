import { describe, expect, it } from "vitest";
import type { Role } from "../domain/incident.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import { runLine } from "./shell/shell.ts";

/** Seconds between a player's commands, and when the first one lands after the page. */
const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
/** Long enough for any rollout or rebuild in the catalogue to finish. */
const SETTLE_SECONDS = 180;
/** In a cross-team incident, refunds wait until the retry storm is over (see the data steps); alone, data acts at once. */
const DATA_WAITS_UNTIL = 420;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

/** Runs one role's steps a few seconds apart; fails the test on any step the shell rejects. */
function runSteps(scenario: Scenario, role: Role, incident: Incident): Incident {
  let current = incident;
  for (const step of scenario.solution[role] ?? []) {
    const result = runLine(step.command, { cluster: current.cluster, scenario, history: [], role });
    // Red log lines are output; these are the shell or a tool turning the command down.
    const errors = result.output.filter((line) => line.tone === "err" && REFUSAL.test(line.text)).map((line) => line.text);
    expect(errors, `${scenario.id} · ${role} · ${step.command}`).toEqual([]);
    if (result.cluster) current = { ...current, cluster: result.cluster };
    current = play(scenario, current, THINKING_SECONDS);
  }
  return current;
}

function close(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  return play(scenario, declared.incident, 700);
}

describe.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))("%s: hints and worked solution", (_id, scenario) => {
  it("has two to four hints that never give away a command", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = Object.values(scenario.solution).flatMap((steps) => steps?.map((step) => step.command) ?? []);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
  });

  it("has a solution for every role it pages", () => {
    for (const role of scenario.roles) expect(scenario.solution[role]?.length ?? 0, role).toBeGreaterThanOrEqual(2);
  });

  it("closes with a top grade when the solution is followed", () => {
    let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
    const now = scenario.roles.filter((role) => role !== "data");
    for (const role of now) incident = runSteps(scenario, role, incident);
    if (scenario.roles.includes("data")) {
      if (scenario.roles.length > 1) incident = play(scenario, incident, Math.max(0, DATA_WAITS_UNTIL - incident.cluster.t));
      incident = runSteps(scenario, "data", incident);
    }
    incident = play(scenario, incident, SETTLE_SECONDS);

    const closed = close(scenario, incident);
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });
});
