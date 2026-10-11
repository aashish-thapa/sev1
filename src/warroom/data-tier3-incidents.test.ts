import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { DATA_TIER3_INCIDENTS } from "./scenarios/data-tier3-incidents.ts";
import { runLine } from "./shell/shell.ts";

const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
/** A trap played at this second, the way a hurried on-call would. */
const TRAP_AT = 40;
/** The chip that pulls the move everyone reaches for: failing open, a plain rollback, or a threshold away from the tuned one. */
const TRAP = /^models (mode \S+ fail-open|rollback \S+|threshold \S+ \S+)$/;

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, Math.max(0, t - incident.cluster.t), incident);
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "data" });
}

/** Runs a data command, failing the test if the shell or a tool turns it down. */
function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = shell(scenario, incident, line);
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function text(scenario: Scenario, incident: Incident, line: string): string {
  return shell(scenario, incident, line).output.map((output) => output.text).join("\n");
}

/** The worked solution as solutions.test.ts plays it: first move at 20 s, 8 s apart, then 180 s to settle. */
function solved(scenario: Scenario): Incident {
  let incident = play(scenario, FIRST_MOVE_AT, openIncident(scenario));
  for (const step of scenario.solution.data ?? []) incident = play(scenario, THINKING_SECONDS, run(scenario, incident, step.command));
  return play(scenario, SETTLE_SECONDS, incident);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, 700, declared.incident);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

function trapLine(scenario: Scenario): string {
  const traps = scenario.suggestions?.data?.filter((line) => TRAP.test(line)) ?? [];
  expect(traps, `${scenario.id} trap chips`).toHaveLength(1);
  return traps[0];
}

const fraudObjective = (incident: Incident, scenario: Scenario) => scenario.objectives?.(incident.cluster)[0];

describe("data tier 3 incidents: catalogue", () => {
  it("has fourteen distinct data tier 3 incidents", () => {
    expect(DATA_TIER3_INCIDENTS).toHaveLength(14);
    for (const field of ["id", "seed", "title", "service"] as const) expect(new Set(DATA_TIER3_INCIDENTS.map((scenario) => scenario[field])).size).toBe(14);
    expect(new Set(DATA_TIER3_INCIDENTS.flatMap((scenario) => scenario.evidence?.map((view) => view.name) ?? [])).size).toBe(28);
    expect(new Set(DATA_TIER3_INCIDENTS.map((scenario) => scenario.postmortem.question)).size).toBe(14);
    for (const scenario of DATA_TIER3_INCIDENTS) {
      expect(scenario.id).toMatch(/^data-t3-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(3);
      expect(scenario.roles).toEqual(["data"]);
      expect(scenario.roleBriefings?.data).toBeTruthy();
    }
  });
});

describe.each(DATA_TIER3_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("follows the content rules: hints, chips, evidence and a postmortem whose answer isn't the longest", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = scenario.solution.data?.map((step) => step.command) ?? [];
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => / (threshold|rollback|mode) |^pipelines run /.test(command));
    expect(fixes.length).toBeGreaterThan(0);
    for (const chip of scenario.suggestions?.data ?? []) expect(fixes).not.toContain(chip);
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
    const opened = openIncident(scenario);
    for (const chip of scenario.suggestions?.data ?? []) {
      if (TRAP.test(chip)) continue;
      expect(text(scenario, opened, chip), chip).not.toMatch(/NaN|Infinity|undefined|no saved query|not found/);
    }
  });

  it("gets worse if nobody acts for ten minutes", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.05);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    const idle = playTo(scenario, 600, opened);
    expect(alertRate(scenario, idle.cluster)).toBeGreaterThan(0.05);
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 10);
  });

  it("closes at S or A with the worked solution", () => {
    const incident = solved(scenario);
    expect(alertRate(scenario, incident.cluster)).toBeLessThan(0.01);
    const { refused, closed, result } = closeOut(scenario, incident);
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("backfires when the obvious move is pulled instead", () => {
    const trap = trapLine(scenario);
    const fixed = closeOut(scenario, solved(scenario));
    const trapped = playTo(scenario, fixed.closed.cluster.t, run(scenario, playTo(scenario, TRAP_AT, openIncident(scenario)), trap));
    const result = debrief(trapped, scenario, true);
    expect(result.isRootCauseFixed).toBe(false);
    expect(result.points).toBeLessThan(fixed.result.points - 20);
    const fraudLeaked = fraudObjective(trapped, scenario)?.isMet === false;
    const customersStillLost = alertRate(scenario, trapped.cluster) >= 0.01;
    // Failing open always leaks the ring; the other traps leak it or keep turning customers away.
    if (trap.includes("fail-open")) expect(fraudLeaked).toBe(true);
    else expect(fraudLeaked || customersStillLost).toBe(true);
  });

  it("is deterministic", () => {
    expect(solved(scenario).cluster).toEqual(solved(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips its scorer, features and ledger through multiplayer frames", () => {
    const relay = (previous: Incident | null, next: Incident) => applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.data ?? [];
    let server = openIncident(scenario);
    let client = relay(null, server);
    for (let second = 0; second < 140; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(second - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = run(scenario, next, step.command);
      client = relay(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
