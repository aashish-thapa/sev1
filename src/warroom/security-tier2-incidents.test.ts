import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { SECURITY_TIER2_INCIDENTS } from "./scenarios/security-tier2-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { blockedAttackShare, blockedShare, BROWSER_JA4, topTalker } from "./sim/edge.ts";

/** As solutions.test.ts plays a worked answer: first move 20 s after the page, a command every 8 s, 180 s to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const MONITORING_SECONDS = 700;
/** A trap played at this second, the way a hurried analyst would. */
const TRAP_AT = 40;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const PYTHON_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
const SAFARI_JA4 = BROWSER_JA4.find((entry) => entry.client === "Safari")?.ja4 ?? "";

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

/** Runs one line on the security laptop; fails the test if the shell turns it down. */
function run(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" });
  const refusals = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(refusals, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function shellText(scenario: Scenario, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" })
    .output.map((output) => output.text)
    .join("\n");
}

function solve(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.security ?? []) incident = play(scenario, run(scenario, step.command, incident), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function trapped(scenario: Scenario, moves: readonly string[]): Incident {
  let incident = playTo(scenario, TRAP_AT, openIncident(scenario));
  for (const move of moves) incident = run(scenario, move, incident);
  return play(scenario, incident, SETTLE_SECONDS);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, declared.incident, MONITORING_SECONDS);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

const customersBlocked = (incident: Incident) => blockedShare(incident.cluster.commerce?.wafRules ?? []);
const attackBlocked = (incident: Incident) => blockedAttackShare(incident.cluster.commerce?.wafRules ?? []);

type Trap = { readonly moves: readonly string[]; readonly check: (scenario: Scenario, after: Incident) => void };

/** Acting on the wrong suspect stops none of the attack: the cause stays, and checkouts keep failing. */
const doesNothing = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(attackBlocked(after)).toBe(0);
    expect(customersBlocked(after)).toBe(0);
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    const later = play(scenario, after, 300);
    expect(later.cluster.failedCheckouts - after.cluster.failedCheckouts).toBeGreaterThan(200);
    expect(closeOut(scenario, after).refused).toBe(true);
  },
});

/** Blocking only part of the attack leaves the pods overloaded. */
const stopsOnlyPart = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(attackBlocked(after)).toBeGreaterThan(0.1);
    expect(attackBlocked(after)).toBeLessThan(0.5);
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
    expect(after.cluster.errorRate).toBeGreaterThan(0.03);
  },
});

/** Blocking the wrong suspect turns customers away and leaves the attack running. */
const blocksCustomers = (...moves: readonly string[]): Trap => ({
  moves,
  check: (scenario, after) => {
    expect(customersBlocked(after)).toBeGreaterThan(0.001);
    expect(attackBlocked(after)).toBe(0);
    expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
  },
});

/** Dismissing the alert closes it while the attack goes on. */
const dismisses = (alert: string, disposition: "benign" | "false-positive"): Trap => ({
  moves: [`siem resolve ${alert} --disposition ${disposition}`],
  check: (scenario, after) => {
    expect(after.cluster.commerce?.alerts.find((candidate) => candidate.id === alert)?.resolution?.disposition).toBe(disposition);
    expect(attackBlocked(after)).toBe(0);
    expect(after.cluster.errorRate).toBeGreaterThan(0.05);
    const { refused, result } = closeOut(scenario, after);
    expect(refused).toBe(true);
    expect(result.objectives?.find((objective) => objective.label.startsWith(alert))?.isMet).toBe(false);
  },
});

const TRAPS: Readonly<Record<string, Trap>> = {
  "sec-t2-gift-card-enumeration": doesNothing("waf block 3.80.0.0/12"),
  "sec-t2-sms-pumping": dismisses("SEC-6214", "benign"),
  "sec-t2-promo-code-brute-force": blocksCustomers("waf block 172.32.0.0/11"),
  "sec-t2-signup-farm": stopsOnlyPart("waf block 44.192.0.0/11"),
  "sec-t2-fake-googlebot": doesNothing("waf block 66.249.64.0/19"),
  "sec-t2-address-api-resale": {
    moves: ["waf ratelimit 600/1m"],
    check: (scenario, after) => {
      expect(attackBlocked(after)).toBeLessThan(0.2);
      expect(scenario.isRootCauseFixed(after.cluster)).toBe(false);
      expect(after.cluster.errorRate).toBeGreaterThan(0.05);
    },
  },
  "sec-t2-otp-brute-force": dismisses("SEC-6704", "false-positive"),
  "sec-t2-cart-hoarding": doesNothing(`waf block --ja4 ${PYTHON_JA4}`),
  "sec-t2-loyalty-points-drain": stopsOnlyPart("waf block 138.68.0.0/16"),
  "sec-t2-search-scraper-safari": blocksCustomers(`waf block --ja4 ${SAFARI_JA4}`),
  "sec-t2-webhook-replay": {
    moves: ["waf block --top 50"],
    check: (scenario, after) => {
      // The replay stops, and with it the 5xx, but dozens of carrier NAT addresses go with it.
      expect(attackBlocked(after)).toBe(1);
      expect(customersBlocked(after)).toBeGreaterThan(0.05);
      const { result } = closeOut(scenario, after);
      expect(result.objectives?.find((objective) => objective.label.includes("customers"))?.isMet).toBe(false);
      expect(result.points).toBeLessThan(closeOut(scenario, solve(scenario)).result.points);
    },
  },
  "sec-t2-graphql-depth-flood": blocksCustomers(`waf block ${topTalker(1).ip}`),
  "sec-t2-two-alerts-one-fire": blocksCustomers("waf block 73.0.0.0/8"),
  "sec-t2-referral-farm-azure": doesNothing("waf ratelimit 20/1m"),
};

describe("security tier 2 incidents", () => {
  it("are fourteen distinct security-only tier 2 incidents", () => {
    expect(SECURITY_TIER2_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title", "opensAtSecondOfDay"] as const) {
      expect(new Set(SECURITY_TIER2_INCIDENTS.map((scenario) => scenario[key])).size).toBe(SECURITY_TIER2_INCIDENTS.length);
    }
    for (const scenario of SECURITY_TIER2_INCIDENTS) {
      expect(scenario.id).toMatch(/^sec-t2-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(2);
      expect(scenario.roles).toEqual(["security"]);
      expect(scenario.roleBriefings?.security).toBeTruthy();
      expect(TRAPS[scenario.id], scenario.id).toBeDefined();
    }
  });
});

describe.each(SECURITY_TIER2_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("follows the content rules: hints, suggestions, SIEM evidence and a postmortem whose answer isn't the longest", () => {
    const commands = (scenario.solution.security ?? []).map((step) => step.command);
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => runLine(command, { cluster: scenario.initialState(), scenario, history: [], role: "security" }).cluster);
    expect(scenario.suggestions?.security?.length).toBeGreaterThan(0);
    for (const suggestion of scenario.suggestions?.security ?? []) expect(fixes).not.toContain(suggestion);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestDistractor);
    expect(explanation.cause.length).toBeLessThanOrEqual(90);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
    const opened = openIncident(scenario);
    expect(scenario.evidence?.length).toBeGreaterThan(0);
    for (const view of scenario.evidence ?? []) {
      expect(shellText(scenario, `siem search ${view.name}`, opened)).not.toMatch(/NaN|Infinity|undefined|unknown saved search/);
    }
  });

  it("gets worse if nobody acts: the pager refuses, and more checkouts are lost each minute", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.03);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    const lostInMinuteTo = (t: number) => {
      const before = playTo(scenario, t - 60, openIncident(scenario));
      return playTo(scenario, t, before).cluster.failedCheckouts - before.cluster.failedCheckouts;
    };
    expect(lostInMinuteTo(600)).toBeGreaterThan(lostInMinuteTo(60) * 1.1);
    const idle = playTo(scenario, 600, opened);
    expect(declareResolved(idle, scenario).notice?.kind).toBe("refused");
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(playTo(scenario, 60, openIncident(scenario)), scenario, true).points);
  });

  it("closes at S or A when the worked solution is followed, with no customer blocked", () => {
    const incident = solve(scenario);
    expect(incident.cluster.errorRate).toBe(0);
    expect(customersBlocked(incident)).toBe(0);
    const { refused, closed, result } = closeOut(scenario, incident);
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("springs its trap: the plausible wrong suspect doesn't fix it", () => {
    const trap = TRAPS[scenario.id];
    trap.check(scenario, trapped(scenario, trap.moves));
  });

  it("is deterministic", () => {
    expect(solve(scenario).cluster).toEqual(solve(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips its attack, rules and alerts through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.security ?? [];
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(second - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = run(scenario, step.command, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
    expect(client.cluster.commerce?.attack).toEqual(openIncident(scenario).cluster.commerce?.attack);
  });
});
