import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { INFRA_TIER1_INCIDENTS } from "./scenarios/infra-tier1-incidents.ts";
import { runLine } from "./shell/shell.ts";

const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
const SETTLE_SECONDS = 180;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  const refusals = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  return { refusals, text: result.output.map((output) => output.text).join("\n"), incident: result.cluster ? { ...incident, cluster: result.cluster } : incident };
}

/** Plays the worked solution like solutions.test.ts: first move at 20 s, 8 s apart, settle, declare, monitor. */
function playSolution(scenario: Scenario) {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.infrastructure ?? []) {
    const result = shell(scenario, incident, step.command);
    expect(result.refusals, `${scenario.id} · ${step.command}`).toEqual([]);
    incident = play(scenario, result.incident, THINKING_SECONDS);
  }
  incident = play(scenario, incident, SETTLE_SECONDS);
  const declared = declareResolved(incident, scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  return play(scenario, declared.incident, 700);
}

function fixCommand(scenario: Scenario): string {
  const fix = scenario.solution.infrastructure?.find((step) => /kubectl (scale|rollout undo)/.test(step.command));
  if (!fix) throw new Error(`${scenario.id} has no fix step`);
  return fix.command;
}

function leaks(scenario: Scenario): boolean {
  const deployment = openIncident(scenario).cluster.deployments[0];
  return deployment.revisions.some((revision) => revision.traits.some((trait) => trait.kind === "leaks-connection-on-dependency-timeout"));
}

describe("infrastructure tier 1 incidents", () => {
  it("are thirteen distinct tier-1 infra incidents", () => {
    expect(INFRA_TIER1_INCIDENTS).toHaveLength(13);
    for (const key of ["id", "seed", "title", "service"] as const) {
      expect(new Set(INFRA_TIER1_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(13);
    }
  });
});

describe.each(INFRA_TIER1_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("is a guided infra incident with fair hints and a fair postmortem", () => {
    expect(scenario.id.startsWith("infra-t1-")).toBe(true);
    expect(scenario.tier).toBe(1);
    expect(scenario.roles).toEqual(["infrastructure"]);
    expect(scenario.roleBriefings?.infrastructure).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const fix = fixCommand(scenario);
    for (const hint of scenario.hints) {
      expect(hint).not.toContain(fix);
      expect(hint).not.toMatch(/\b(kubectl|psql|curl)\s/);
    }
    expect(scenario.suggestions?.infrastructure ?? []).not.toContain(fix);
    const { options, answerIndex } = scenario.postmortem;
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("gets worse when nobody acts", () => {
    const opened = openIncident(scenario);
    const idle = play(scenario, opened, 600);
    expect(idle.cluster.errorRate).toBeGreaterThan(0.01);
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points);
  });

  it("closes at S or A when the worked solution is followed", () => {
    const closed = playSolution(scenario);
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("isn't fixed by the tempting move: a restart (or a rollback when nothing was deployed)", () => {
    const trap = fixCommand(scenario).includes("scale")
      ? fixCommand(scenario).replace(/scale (deployment\/\S+) --replicas=\d+/, "rollout undo $1")
      : fixCommand(scenario).replace("rollout undo", "rollout restart");
    let incident = play(scenario, openIncident(scenario), 40);
    const result = shell(scenario, incident, trap);
    expect(result.refusals).toEqual([]);
    incident = result.incident;
    let worst = 0;
    for (let second = 0; second < 150; second += 1) {
      incident = advance(incident, scenario).incident;
      worst = Math.max(worst, incident.cluster.errorRate);
    }
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    // A restart empties a leaking pool for a while; every other trap leaves customers failing.
    if (!leaks(scenario)) expect(worst).toBeGreaterThan(0.05);
  });

  it("replays exactly", () => {
    const run = () => play(scenario, shell(scenario, play(scenario, openIncident(scenario), 30), fixCommand(scenario)).incident, 120);
    expect(run()).toEqual(run());
  });

  it("survives a multiplayer frame round trip", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    expect(client).toEqual(server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === 20) next = shell(scenario, next, fixCommand(scenario)).incident;
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
