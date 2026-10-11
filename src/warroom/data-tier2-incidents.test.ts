import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { DATA_TIER2_INCIDENTS } from "./scenarios/data-tier2-incidents.ts";
import { runLine } from "./shell/shell.ts";

/** As solutions.test.ts plays a worked answer: first move 20 s after the page, a command every 8 s, 180 s to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const MONITORING_SECONDS = 700;
/** A trap played at this second, the way a hurried on-call would. */
const TRAP_AT = 40;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

/** Runs one line on the data laptop; fails the test if the shell turns it down. */
function run(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "data" });
  const refusals = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(refusals, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function shellText(scenario: Scenario, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "data" })
    .output.map((output) => output.text)
    .join("\n");
}

function solve(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.data ?? []) incident = play(scenario, run(scenario, step.command, incident), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function trapped(scenario: Scenario, moves: readonly string[]): Incident {
  let incident = playTo(scenario, TRAP_AT, openIncident(scenario));
  for (const move of moves) {
    const result = runLine(move, { cluster: incident.cluster, scenario, history: [], role: "data" });
    expect(result.cluster, `${scenario.id} · trap ${move} should be accepted`).toBeDefined();
    incident = run(scenario, move, incident);
  }
  return play(scenario, incident, SETTLE_SECONDS);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, declared.incident, MONITORING_SECONDS);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

type Trap = { readonly moves: readonly string[]; readonly check: (scenario: Scenario, after: Incident) => void };

/** Acting on the plausible wrong suspect leaves customers turned away as before, and the pager refuses to resolve. */
const doesNothing = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    const untouched = playTo(scenario, after.cluster.t, openIncident(scenario));
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    expect(alertRate(scenario, after.cluster)).toBeGreaterThan(0.9 * alertRate(scenario, untouched.cluster));
    expect(closeOut(scenario, after).refused).toBe(true);
  },
});

/** A half-right move: it may quiet the pager, but the cause stays and the debrief knows it. */
const fallsShort = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    const { result } = closeOut(scenario, after);
    expect(result.isRootCauseFixed).toBe(false);
    expect(result.points).toBeLessThan(closeOut(scenario, solve(scenario)).result.points - 20);
  },
});

const TRAPS: Readonly<Record<string, Trap>> = {
  "data-t2-isotonic-recalibration": doesNothing("pipelines run features_session_hourly"),
  "data-t2-two-bad-versions": doesNothing("models rollback txn-risk"),
  "data-t2-refunds-labelled-fraud": {
    moves: ["models threshold card-risk 0.95"],
    check: (scenario, after) => {
      fallsShort().check(scenario, after);
      // Fewer customers declined, but still several times normal: the pager won't resolve.
      expect(closeOut(scenario, after).refused).toBe(true);
    },
  },
  "data-t2-challenger-at-full-ramp": doesNothing("pipelines run features_card_velocity"),
  "data-t2-statement-timeout": doesNothing("models rollback fraud-scorer"),
  "data-t2-revoked-grant": doesNothing("pipelines run features_customer_daily"),
  "data-t2-rotated-password": doesNothing("models rollback account-trust"),
  "data-t2-backfill-duplicate-key": doesNothing("pipelines run features_card_velocity"),
  "data-t2-feature-store-disk-full": doesNothing("models threshold checkout-guard 0.9"),
  "data-t2-threshold-digit-swap": doesNothing("models rollback risk-engine"),
  "data-t2-sweep-left-behind": fallsShort("models threshold cnp-scorer 0.85"),
  "data-t2-fail-open-after-migration": doesNothing("models rollback checkout-shield"),
  "data-t2-fail-open-overnight": doesNothing("models threshold payment-risk 0.6"),
  "data-t2-drill-never-reverted": doesNothing("pipelines run features_card_velocity"),
};

describe("data tier 2 incidents", () => {
  it("are fourteen distinct data-only tier 2 incidents", () => {
    expect(DATA_TIER2_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title", "opensAtSecondOfDay"] as const) {
      expect(new Set(DATA_TIER2_INCIDENTS.map((scenario) => scenario[key])).size).toBe(DATA_TIER2_INCIDENTS.length);
    }
    for (const scenario of DATA_TIER2_INCIDENTS) {
      expect(scenario.id).toMatch(/^data-t2-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(2);
      expect(scenario.roles).toEqual(["data"]);
      expect(scenario.roleBriefings?.data).toBeTruthy();
      expect(scenario.alertMetric).toBeDefined();
      expect(TRAPS[scenario.id], scenario.id).toBeDefined();
    }
  });
});

describe.each(DATA_TIER2_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("follows the content rules: hints, suggestions, evidence and a postmortem whose answer isn't the longest", () => {
    const commands = (scenario.solution.data ?? []).map((step) => step.command);
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => runLine(command, { cluster: scenario.initialState(), scenario, history: [], role: "data" }).cluster);
    expect(fixes.length).toBeGreaterThan(0);
    expect(scenario.suggestions?.data?.length).toBeGreaterThan(0);
    const opened = openIncident(scenario);
    for (const suggestion of scenario.suggestions?.data ?? []) {
      expect(fixes).not.toContain(suggestion);
      expect(shellText(scenario, suggestion, opened)).not.toMatch(/NaN|Infinity|undefined|not found|unknown/);
    }
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(72);
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestDistractor);
    expect(explanation.cause.length).toBeLessThanOrEqual(110);
    expect(explanation.why.length).toBeLessThanOrEqual(400);
    expect(explanation.tell.length).toBeLessThanOrEqual(240);
    expect(scenario.evidence?.length).toBeGreaterThan(0);
    for (const view of scenario.evidence ?? []) {
      const line = view.tool === "warehouse" ? `warehouse run ${view.name}` : `${view.tool} ${view.name}`;
      expect(shellText(scenario, line, opened), line).not.toMatch(/NaN|Infinity|undefined|no saved query|unknown command/);
    }
  });

  it("gets worse if nobody acts: the pager refuses, and the debrief loses points by the minute", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.01);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    const minute = playTo(scenario, 60, openIncident(scenario));
    const idle = playTo(scenario, 600, minute);
    expect(alertRate(scenario, idle.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, opened.cluster) * 0.99);
    expect(declareResolved(idle, scenario).notice?.kind).toBe("refused");
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(minute, scenario, true).points);
  });

  it("closes at S or A when the worked solution is followed", () => {
    const { refused, closed, result } = closeOut(scenario, solve(scenario));
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(closed.reopenCount).toBe(0);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"], `${scenario.id}: ${result.points} points, ${result.failedCheckouts} lost`).toContain(result.grade);
  });

  it("springs its trap: the plausible wrong suspect doesn't fix it", () => {
    const trap = TRAPS[scenario.id];
    trap.check(scenario, trapped(scenario, trap.moves));
  });

  it("is deterministic", () => {
    expect(solve(scenario).cluster).toEqual(solve(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips its scorer through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.data ?? [];
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 120; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(second - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = run(scenario, step.command, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
    expect(client.cluster.commerce?.fraud).toEqual(server.cluster.commerce?.fraud);
  });
});
