import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, isRollingOut, openIncident, type Incident, type IncidentNotice } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { INFRA_TIER3_INCIDENTS } from "./scenarios/infra-tier3-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { revisionOf } from "./sim/model.ts";

const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
const SETTLE_SECONDS = 180;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;

function play(scenario: Scenario, incident: Incident, seconds: number) {
  const notices: IncidentNotice[] = [];
  let current = incident;
  for (let index = 0; index < seconds; index += 1) {
    const result = advance(current, scenario);
    current = result.incident;
    if (result.notice) notices.push(result.notice);
  }
  return { incident: current, notices };
}

function shell(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

/** Plays the worked solution like solutions.test.ts: first step at t=20, 8 s apart, then 180 s to settle. */
function solve(scenario: Scenario, onStep?: (incident: Incident) => void): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT).incident;
  for (const step of scenario.solution.infrastructure ?? []) {
    incident = shell(scenario, incident, step.command);
    onStep?.(incident);
    incident = play(scenario, incident, THINKING_SECONDS).incident;
  }
  return play(scenario, incident, SETTLE_SECONDS).incident;
}

function deployment(scenario: Scenario): string {
  return scenario.initialState().deployments[0].name;
}

/** The player's tempting move at t=20, then `seconds` of play. */
function tempt(scenario: Scenario, line: string, seconds: number): Incident {
  const opened = play(scenario, openIncident(scenario), FIRST_MOVE_AT).incident;
  return play(scenario, shell(scenario, opened, line), seconds).incident;
}

function isOnBadBuild(incident: Incident): boolean {
  return incident.cluster.deployments.some((candidate) => revisionOf(candidate, candidate.revision).traits.length > 0);
}

const plainUndo = (scenario: Scenario) => `kubectl rollout undo deployment/${deployment(scenario)}`;
const restart = (scenario: Scenario) => `kubectl rollout restart deployment/${deployment(scenario)}`;

/** Undo one step lands on another bad build. */
function undoOneStepStaysBroken(scenario: Scenario) {
  const incident = tempt(scenario, plainUndo(scenario), 240);
  expect(isOnBadBuild(incident)).toBe(true);
  expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
}

/** A rollout's surge pod can't open its pool: it crash-loops and the rollout never finishes. */
function rolloutStalls(line: (scenario: Scenario) => string) {
  return (scenario: Scenario) => {
    const incident = tempt(scenario, line(scenario), 150);
    expect(incident.cluster.crashLoopsCaused).toBeGreaterThan(0);
    expect(isRollingOut(incident.cluster)).toBe(true);
    expect(incident.cluster.logs[scenario.initialState().database.name]?.some((entry) => entry.text.includes("too many clients"))).toBe(true);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
  };
}

function scaleOutCrashLoops(scenario: Scenario) {
  const incident = tempt(scenario, `kubectl scale deployment/${deployment(scenario)} --replicas=6`, 90);
  expect(incident.cluster.crashLoopsCaused).toBeGreaterThan(0);
  expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
  // The pods that fit are still on the same build or query, so the outage comes back however many there are.
  expect(play(scenario, incident, 600).incident.cluster.errorRate).toBeGreaterThan(0.05);
}

function plainReindexLocks(scenario: Scenario) {
  const name = scenario.initialState().database.hotIndex?.name ?? "";
  const locking = tempt(scenario, `psql -c "REINDEX INDEX ${name}"`, 10);
  expect(locking.cluster.errorRate).toBeGreaterThan(0.9);
  const lockedThrough = play(scenario, locking, 80).incident;
  const concurrent = tempt(scenario, `psql -c "REINDEX INDEX CONCURRENTLY ${name}"`, 90);
  expect(scenario.isRootCauseFixed(lockedThrough.cluster)).toBe(true);
  expect(lockedThrough.cluster.failedCheckouts).toBeGreaterThan(concurrent.cluster.failedCheckouts);
}

function scaleDownSheds(scenario: Scenario) {
  const scaled = tempt(scenario, `kubectl scale deployment/${deployment(scenario)} --replicas=2`, 60);
  const untouched = play(scenario, openIncident(scenario), FIRST_MOVE_AT + 60).incident;
  expect(scaled.cluster.errorRate).toBeGreaterThan(untouched.cluster.errorRate);
  expect(scaled.cluster.failedCheckouts).toBeGreaterThan(untouched.cluster.failedCheckouts);
}

function terminatingBackendsCosts(scenario: Scenario) {
  const incident = tempt(scenario, 'psql -c "select pg_terminate_backend(pid) from pg_stat_activity where state = \'idle\'"', 30);
  const pool = incident.cluster.deployments[0];
  expect(pool.pods.some((pod) => pod.leaked >= pool.poolSize)).toBe(true);
  expect(scenario.objectives?.(incident.cluster).some((objective) => !objective.isMet)).toBe(true);
}

function restartReopens(scenario: Scenario) {
  const restarted = tempt(scenario, restart(scenario), SETTLE_SECONDS);
  const declared = declareResolved(restarted, scenario);
  expect(declared.notice).toBeUndefined();
  const { notices } = play(scenario, declared.incident, 700);
  expect(notices.map((notice) => notice.kind)).toContain("reopened");
}

const TRAPS: Readonly<Record<string, (scenario: Scenario) => void>> = {
  "infra-t3-hotfix-keeps-leaking": undoOneStepStaysBroken,
  "infra-t3-xmx-bump-oom": (scenario) => {
    undoOneStepStaysBroken(scenario);
    const incident = tempt(scenario, plainUndo(scenario), 300);
    expect(incident.cluster.deployments[0].pods.some((pod) => pod.lastTermination?.reason === "OOMKilled")).toBe(true);
  },
  "infra-t3-metaspace-undo-leaks": undoOneStepStaysBroken,
  "infra-t3-undo-into-serializer-bug": (scenario) => {
    undoOneStepStaysBroken(scenario);
    expect(tempt(scenario, plainUndo(scenario), 120).cluster.errorRate).toBeGreaterThan(0.3);
  },
  "infra-t3-surge-blocked-four-pods": rolloutStalls(plainUndo),
  "infra-t3-wallet-restart-stalls": rolloutStalls(restart),
  "infra-t3-bnpl-five-small-pools": rolloutStalls(plainUndo),
  "infra-t3-subscriptions-six-pods": rolloutStalls(restart),
  "infra-t3-loyalty-scale-out": scaleOutCrashLoops,
  "infra-t3-failover-invalid-index": scaleOutCrashLoops,
  "infra-t3-runbook-plain-reindex": plainReindexLocks,
  "infra-t3-deadlocked-index-scale-down": scaleDownSheds,
  "infra-t3-giftcard-terminate-backends": terminatingBackendsCosts,
  "infra-t3-preorder-restart-reopens": restartReopens,
};

describe("infra tier-3 incidents", () => {
  it("has fourteen incidents with unique ids, seeds and titles, and a trap test for each", () => {
    expect(INFRA_TIER3_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(INFRA_TIER3_INCIDENTS.map((scenario) => scenario[key])).size).toBe(INFRA_TIER3_INCIDENTS.length);
    }
    expect(Object.keys(TRAPS).sort()).toEqual(INFRA_TIER3_INCIDENTS.map((scenario) => scenario.id).sort());
  });
});

describe.each(INFRA_TIER3_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("is a tier-3 infrastructure incident whose hints, suggestions and postmortem keep the answer honest", () => {
    expect(scenario.id).toMatch(/^infra-t3-[a-z0-9-]+$/);
    expect(scenario.tier).toBe(3);
    expect(scenario.roles).toEqual(["infrastructure"]);
    expect(scenario.roleBriefings?.infrastructure).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const steps = scenario.solution.infrastructure ?? [];
    const opened = openIncident(scenario);
    const fixes = steps.map((step) => step.command).filter((command) => runLine(command, { cluster: opened.cluster, scenario, history: [], role: "infrastructure" }).cluster);
    expect(fixes.length).toBeGreaterThan(0);
    for (const hint of scenario.hints) {
      for (const step of steps) expect(hint).not.toContain(step.command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    for (const suggestion of scenario.suggestions?.infrastructure ?? []) expect(fixes).not.toContain(suggestion);
    const { options, answerIndex } = scenario.postmortem;
    const longest = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThanOrEqual(longest);
  });

  it("gets worse over ten minutes when nobody acts", () => {
    const opened = openIncident(scenario);
    const later = play(scenario, opened, 600).incident;
    const rises = alertRate(scenario, later.cluster) > alertRate(scenario, opened.cluster);
    const pointsFall = debrief(later, scenario, true).points < debrief(opened, scenario, true).points;
    expect(rises || pointsFall).toBe(true);
  });

  it("closes at S or A when the worked solution is played", () => {
    const incident = solve(scenario);
    const declared = declareResolved(incident, scenario);
    expect(declared.notice).toBeUndefined();
    const { incident: closed, notices } = play(scenario, declared.incident, 700);
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("makes its tempting move backfire", () => {
    TRAPS[scenario.id](scenario);
  });

  it("is deterministic", () => {
    expect(solve(scenario).cluster).toEqual(solve(scenario).cluster);
  });

  it("survives a multiplayer frame round trip", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    const steps = scenario.solution.infrastructure ?? [];
    for (let second = 0; second < 120; second += 1) {
      let next = advance(server, scenario).incident;
      const index = (second - FIRST_MOVE_AT) / THINKING_SECONDS;
      const step = Number.isInteger(index) ? steps[index] : undefined;
      if (step) next = shell(scenario, next, step.command);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
