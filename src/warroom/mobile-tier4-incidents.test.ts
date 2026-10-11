import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { MOBILE_TIER4_INCIDENTS } from "./scenarios/mobile-tier4-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { findConfig, latestChange } from "./sim/commerce.ts";

const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
const SETTLE_SECONDS = 180;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function text(scenario: Scenario, incident: Incident, line: string): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" })
    .output.map((output) => output.text)
    .join("\n");
}

function steps(scenario: Scenario) {
  return scenario.solution.mobile ?? [];
}

const fixOf = (scenario: Scenario) => steps(scenario)[1]?.command ?? "";

/** Plays the worked solution like solutions.test.ts: first move at t=20, 8 s apart, 180 s settle, declare, 700 s. */
function playSolution(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of steps(scenario)) incident = play(scenario, run(scenario, incident, step.command), THINKING_SECONDS);
  incident = play(scenario, incident, SETTLE_SECONDS);
  const declared = declareResolved(incident, scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  return play(scenario, declared.incident, 700);
}

/** Plays `moves` from t=20, waits out propagation, and tries to resolve. */
function tryMoves(scenario: Scenario, moves: readonly string[]) {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const move of moves) incident = play(scenario, run(scenario, incident, move), THINKING_SECONDS);
  const settled = play(scenario, incident, SETTLE_SECONDS);
  const declared = declareResolved(settled, scenario);
  return { settled, refused: declared.notice, closed: play(scenario, declared.incident, 700) };
}

/** `remote-config set <key> <previous value>` for the change everyone suspects. */
function decoyRevert(scenario: Scenario): string {
  const suggestion = scenario.suggestions?.mobile?.find((line) => line.startsWith("remote-config history ")) ?? "";
  const key = suggestion.split(" ")[2] ?? "";
  const entry = findConfig(scenario.initialState().commerce!, key);
  if (!entry) throw new Error(`${scenario.id}: no decoy key`);
  return `remote-config set ${key} ${latestChange(entry.history).from}`;
}

function shortcutMove(scenario: Scenario): string | undefined {
  return scenario.suggestions?.mobile?.find((line) => line.startsWith("remote-config set "));
}

describe("mobile tier 4 catalogue", () => {
  it("has fourteen incidents with unique ids, seeds and titles", () => {
    expect(MOBILE_TIER4_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(MOBILE_TIER4_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(MOBILE_TIER4_INCIDENTS.length);
    }
  });
});

describe.each(MOBILE_TIER4_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("is a mobile-only tier 4 incident with a well-formed card", () => {
    expect(scenario.id.startsWith("mob-t4-")).toBe(true);
    expect(scenario.tier).toBe(4);
    expect(scenario.roles).toEqual(["mobile"]);
    expect(scenario.roleBriefings?.mobile).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = steps(scenario).map((step) => step.command);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    expect(scenario.suggestions?.mobile).not.toContain(fixOf(scenario));
    const { options, answerIndex } = scenario.postmortem;
    const answer = options[answerIndex] ?? "";
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(answer.length).toBeLessThan(longestDistractor);
  });

  it("gets worse when nobody acts for 600 s", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.05);
    const later = play(scenario, opened, 600);
    expect(debrief(later, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points);
    expect(alertRate(scenario, later.cluster)).toBeGreaterThan(0.05);
  });

  it("closes at S or A when the worked solution is played", () => {
    const closed = playSolution(scenario);
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"], `${scenario.id}: ${result.points} points, ${result.failedCheckouts} lost`).toContain(result.grade);
  });

  it("does nothing for the usual fix: halting the release and reverting the suspect change", () => {
    const opened = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
    const halt = scenario.suggestions?.mobile?.find((line) => line.startsWith("releases halt ")) ?? "";
    const { settled, refused } = tryMoves(scenario, [halt, decoyRevert(scenario)]);
    expect(alertRate(scenario, settled.cluster)).toBeCloseTo(alertRate(scenario, opened.cluster), 6);
    expect(scenario.isRootCauseFixed(settled.cluster)).toBe(false);
    expect(refused?.kind).toBe("refused");
    expect(text(scenario, opened, "releases rollback ios")).toContain("no rollback");
  });

  const shortcut = shortcutMove(scenario);
  if (shortcut) {
    it("the shortcut restores checkout but breaks the safeguard: root cause and objective unmet", () => {
      const { settled, refused, closed } = tryMoves(scenario, [shortcut]);
      expect(alertRate(scenario, settled.cluster)).toBe(0);
      expect(refused).toBeUndefined();
      const result = debrief(closed, scenario, true);
      expect(result.isRootCauseFixed).toBe(false);
      expect(result.objectives?.some((objective) => !objective.isMet)).toBe(true);
      expect(result.points).toBeLessThan(debrief(playSolution(scenario), scenario, true).points - 30);
    });
  }

  it("the evidence view names the failure, then goes quiet after the fix", () => {
    const view = steps(scenario)[0]?.command ?? "";
    const opened = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
    expect(text(scenario, opened, view)).toContain("Sample");
    const fixed = play(scenario, run(scenario, opened, fixOf(scenario)), SETTLE_SECONDS);
    expect(text(scenario, fixed, view)).not.toContain("Sample");
    expect(alertRate(scenario, fixed.cluster)).toBe(0);
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
