import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { INFRA_TIER2_INCIDENTS } from "./scenarios/infra-tier2-incidents.ts";
import { runLine } from "./shell/shell.ts";

/** As solutions.test.ts plays a worked answer: first move 20 s after the page, a command every 8 s, 180 s to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const MONITORING_SECONDS = 700;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const RESTART = "kubectl rollout restart deployment/checkout-api";

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

/** Runs one command as the infrastructure engineer; fails the test if the shell turns it down. */
function run(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  const refusals = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(refusals, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function playMoves(scenario: Scenario, moves: readonly string[]): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const move of moves) incident = play(scenario, run(scenario, move, incident), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function solve(scenario: Scenario): Incident {
  return playMoves(scenario, (scenario.solution.infrastructure ?? []).map((step) => step.command));
}

type Trap = { readonly moves: readonly string[]; readonly check: (scenario: Scenario, after: Incident) => void };

/** The decoy fix does nothing: the cause stays, and checkouts keep failing. */
const doesNothing = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    const later = play(scenario, after, 300);
    expect(later.cluster.failedCheckouts - after.cluster.failedCheckouts).toBeGreaterThan(200);
  },
});

/** The decoy fix asks orders-db for connections it doesn't have: new pods crash-loop and nothing is fixed. */
const crashLoops = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(after.cluster.crashLoopsCaused).toBeGreaterThan(0);
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
  },
});

const TRAPS: Readonly<Record<string, Trap>> = {
  "infra-t2-heap-exit-on-oome": doesNothing("kubectl rollout undo deployment/promo-engine"),
  "infra-t2-native-thread-exhaustion": doesNothing("kubectl rollout undo deployment/notifications-api"),
  "infra-t2-grpc-native-memory": doesNothing("kubectl rollout undo deployment/inventory-api"),
  "infra-t2-split-tender-recursion": doesNothing("kubectl rollout undo deployment/gift-card-api"),
  "infra-t2-liveness-on-fraud-scorer": doesNothing(RESTART),
  "infra-t2-libvips-segfault": doesNothing(RESTART),
  "infra-t2-adyen-proxy-leak": doesNothing(`psql -c "select pg_terminate_backend(pid) from pg_stat_activity where state = 'idle'"`),
  "infra-t2-wallet-pay-leak": {
    moves: [RESTART],
    check: (scenario, after) => {
      // The restart empties the pools and checkout recovers, for a while.
      expect(after.cluster.errorRate).toBeLessThan(0.01);
      expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
      const relapsed = play(scenario, after, 600);
      expect(relapsed.cluster.errorRate).toBeGreaterThan(0.05);
    },
  },
  "infra-t2-manifest-replicas": doesNothing("kubectl rollout undo deployment/checkout-api"),
  "infra-t2-partner-launch-capacity": {
    moves: ["kubectl scale deployment/checkout-api --replicas=6"],
    check: (scenario, after) => {
      expect(after.cluster.crashLoopsCaused).toBeGreaterThan(0);
      expect(scenario.objectives?.(after.cluster).every((objective) => objective.isMet)).toBe(false);
      expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    },
  },
  "infra-t2-month-end-exporter": crashLoops(RESTART),
  "infra-t2-catalog-backfill-indexer": crashLoops("kubectl scale deployment/checkout-api --replicas=5"),
  "infra-t2-forgotten-canary": crashLoops(RESTART),
  "infra-t2-maintenance-lock-timeout": doesNothing("kubectl scale deployment/analytics-etl --replicas=0"),
};

describe("infrastructure tier 2 incidents", () => {
  it("are fourteen distinct infrastructure-only tier 2 incidents", () => {
    expect(INFRA_TIER2_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(INFRA_TIER2_INCIDENTS.map((scenario) => scenario[key])).size).toBe(INFRA_TIER2_INCIDENTS.length);
    }
    for (const scenario of INFRA_TIER2_INCIDENTS) {
      expect(scenario.id).toMatch(/^infra-t2-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(2);
      expect(scenario.roles).toEqual(["infrastructure"]);
      expect(TRAPS[scenario.id], scenario.id).toBeDefined();
    }
  });
});

describe.each(INFRA_TIER2_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("has hints and suggestions that never give the fix away, and a postmortem whose answer isn't the longest option", () => {
    const commands = (scenario.solution.infrastructure ?? []).map((step) => step.command);
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => runLine(command, { cluster: scenario.initialState(), scenario, history: [], role: "infrastructure" }).cluster);
    for (const suggestion of scenario.suggestions?.infrastructure ?? []) expect(fixes).not.toContain(suggestion);
    const { options, answerIndex } = scenario.postmortem;
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("gets worse when nobody acts", () => {
    const opened = openIncident(scenario);
    const later = play(scenario, opened, 600);
    expect(debrief(later, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points);
  });

  it("closes at S or A when the worked solution is followed", () => {
    const solved = solve(scenario);
    expect(scenario.isRootCauseFixed(solved.cluster)).toBe(true);
    const declared = declareResolved(solved, scenario);
    expect(declared.notice, `${scenario.id} refused to resolve at ${alertRate(scenario, solved.cluster)}`).toBeUndefined();
    const closed = play(scenario, declared.incident, MONITORING_SECONDS);
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"], `${scenario.id}: ${result.points} points, ${result.failedCheckouts} lost`).toContain(result.grade);
  });

  it("doesn't recover on the plausible wrong fix", () => {
    const trap = TRAPS[scenario.id];
    trap.check(scenario, playMoves(scenario, trap.moves));
  });

  it("replays exactly", () => {
    expect(play(scenario, openIncident(scenario), 120)).toEqual(play(scenario, openIncident(scenario), 120));
  });

  it("survives a multiplayer frame round trip while the fix lands", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === 20) {
        for (const step of scenario.solution.infrastructure ?? []) {
          const result = runLine(step.command, { cluster: next.cluster, scenario, history: [], role: "infrastructure" });
          if (result.cluster) next = { ...next, cluster: result.cluster };
        }
      }
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
