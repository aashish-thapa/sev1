import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { INFRA_TIER4_INCIDENTS } from "./scenarios/infra-tier4-incidents.ts";
import { runLine } from "./shell/shell.ts";

const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
const SETTLE_SECONDS = 180;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const FIX = /REINDEX|--to-revision|^kubectl scale deployment\//;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function steps(scenario: Scenario) {
  return scenario.solution.infrastructure ?? [];
}

/** Plays the worked solution like solutions.test.ts: first move at t=20, 8 s apart, 180 s settle, declare, 700 s. */
function playSolution(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of steps(scenario)) incident = play(scenario, run(scenario, incident, step.command), THINKING_SECONDS);
  incident = play(scenario, incident, SETTLE_SECONDS);
  const declared = declareResolved(incident, scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  return play(scenario, declared.incident, 700);
}

type Kind = "index" | "hog" | "hidden-defect";

function kindOf(scenario: Scenario): Kind {
  const state = scenario.initialState();
  if (state.database.hotIndex) return "index";
  return state.deployments.length > 1 ? "hog" : "hidden-defect";
}

/** The largest alert rate seen over `seconds` of play. */
function peakAlert(scenario: Scenario, incident: Incident, seconds: number): number {
  let current = incident;
  let peak = 0;
  for (let index = 0; index < seconds; index += 1) {
    current = advance(current, scenario).incident;
    peak = Math.max(peak, alertRate(scenario, current.cluster));
  }
  return peak;
}

describe("infrastructure tier 4 catalogue", () => {
  it("has fourteen incidents with unique ids, seeds and titles", () => {
    expect(INFRA_TIER4_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(INFRA_TIER4_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(INFRA_TIER4_INCIDENTS.length);
    }
  });
});

describe.each(INFRA_TIER4_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  const kind = kindOf(scenario);
  const service = scenario.service;

  it("is an infrastructure-only tier 4 incident with a well-formed card", () => {
    expect(scenario.id.startsWith("infra-t4-")).toBe(true);
    expect(scenario.tier).toBe(4);
    expect(scenario.roles).toEqual(["infrastructure"]);
    expect(scenario.roleBriefings?.infrastructure).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = steps(scenario).map((step) => step.command);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => FIX.test(command));
    expect(fixes.length).toBeGreaterThan(0);
    for (const suggestion of scenario.suggestions?.infrastructure ?? []) expect(fixes).not.toContain(suggestion);
    const { options, answerIndex } = scenario.postmortem;
    const answer = options[answerIndex] ?? "";
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(answer.length).toBeLessThan(longestDistractor);
  });

  it("gets worse when nobody acts for 600 s", () => {
    const opened = openIncident(scenario);
    const later = play(scenario, opened, 600);
    expect(debrief(later, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points);
    expect(peakAlert(scenario, later, 60)).toBeGreaterThan(0.05);
  });

  it("closes at S or A when the worked solution is played", () => {
    const closed = playSolution(scenario);
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"], `${scenario.id}: ${result.points} points, ${result.failedCheckouts} lost`).toContain(result.grade);
  });

  it("does nothing for the usual fix", () => {
    const opened = play(scenario, openIncident(scenario), 30);
    if (kind === "index") {
      // Rolling the app back can't touch a broken index.
      const undone = play(scenario, run(scenario, opened, `kubectl rollout undo deployment/${service}`), 150);
      expect(scenario.isRootCauseFixed(undone.cluster)).toBe(false);
      expect(undone.cluster.errorRate).toBeGreaterThan(0.05);
    } else if (kind === "hidden-defect") {
      // One step back is another build with the same defect: the pager fires again.
      const undone = play(scenario, run(scenario, opened, `kubectl rollout undo deployment/${service}`), 120);
      expect(scenario.isRootCauseFixed(undone.cluster)).toBe(false);
      expect(peakAlert(scenario, undone, 600)).toBeGreaterThan(0.05);
    } else {
      // Restarting the paged service only adds crash loops: nothing frees connections.
      const restarted = play(scenario, run(scenario, opened, `kubectl rollout restart deployment/${service}`), 120);
      expect(scenario.isRootCauseFixed(restarted.cluster)).toBe(false);
      expect(restarted.cluster.crashLoopsCaused).toBeGreaterThan(0);
      expect(restarted.cluster.errorRate).toBeGreaterThan(0.05);
      const scaled = play(scenario, run(scenario, opened, `kubectl scale deployment/${service} --replicas=5`), 120);
      expect(scaled.cluster.crashLoopsCaused).toBeGreaterThan(0);
      expect(scaled.cluster.errorRate).toBeGreaterThan(0.05);
    }
  });

  it("plays the same way twice", () => {
    expect(playSolution(scenario)).toEqual(playSolution(scenario));
  });

  it("round-trips through multiplayer frames while the fix lands", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const moves = new Map(steps(scenario).map((step, index) => [FIRST_MOVE_AT + index * THINKING_SECONDS, step.command]));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 150; second += 1) {
      let next = advance(server, scenario).incident;
      const move = moves.get(second);
      if (move) next = run(scenario, next, move);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
