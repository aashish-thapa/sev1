import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { SECURITY_TIER4_INCIDENTS } from "./scenarios/security-tier4-incidents.ts";
import { runLine } from "./shell/shell.ts";
import { blockedAttackShare, blockedShare } from "./sim/edge.ts";

const THINKING_SECONDS = 8;
const FIRST_MOVE_AT = 20;
const SETTLE_SECONDS = 180;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const FIX = /^waf block (--ja4 \S+|\d+\.\d+\.\d+\.\d+\/\d+)$/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function text(scenario: Scenario, incident: Incident, line: string): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" })
    .output.map((output) => output.text)
    .join("\n");
}

function steps(scenario: Scenario) {
  return scenario.solution.security ?? [];
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

describe("security tier 4 catalogue", () => {
  it("has fourteen incidents with unique ids, seeds, titles and alerts", () => {
    expect(SECURITY_TIER4_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(SECURITY_TIER4_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(SECURITY_TIER4_INCIDENTS.length);
    }
    const alerts = SECURITY_TIER4_INCIDENTS.map((scenario) => scenario.initialState().commerce?.alerts[0]?.id);
    expect(new Set(alerts).size).toBe(SECURITY_TIER4_INCIDENTS.length);
    const paths = SECURITY_TIER4_INCIDENTS.map((scenario) => scenario.initialState().commerce?.attack?.path);
    expect(new Set(paths).size).toBe(SECURITY_TIER4_INCIDENTS.length);
  });
});

describe.each(SECURITY_TIER4_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  const commerce = scenario.initialState().commerce;
  const attack = commerce?.attack;
  if (!attack) throw new Error(`${scenario.id} has no attack`);
  const isProxies = attack.sources.kind === "residential-proxies";

  it("is a security-only tier 4 incident with a well-formed card", () => {
    expect(scenario.id.startsWith("sec-t4-")).toBe(true);
    expect(scenario.tier).toBe(4);
    expect(scenario.roles).toEqual(["security"]);
    expect(scenario.roleBriefings?.security).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = steps(scenario).map((step) => step.command);
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => FIX.test(command));
    expect(fixes.length).toBeGreaterThan(0);
    for (const suggestion of scenario.suggestions?.security ?? []) expect(fixes).not.toContain(suggestion);
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const answer = options[answerIndex] ?? "";
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(answer.length).toBeLessThan(longestDistractor);
  });

  it("shows its tell in the saved searches", () => {
    const opened = play(scenario, openIncident(scenario), 30);
    const views = scenario.evidence ?? [];
    expect(views).toHaveLength(2);
    const tell = text(scenario, opened, `siem search ${views[1].name}`);
    expect(tell).toContain(attack.ja4);
    expect(text(scenario, opened, `siem search ${views[0].name}`)).toContain(attack.path);
  });

  it("gets worse when nobody acts for 600 s", () => {
    const opened = openIncident(scenario);
    const later = play(scenario, opened, 600);
    expect(debrief(later, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points);
    expect(alertRate(scenario, later.cluster)).toBeGreaterThan(alertRate(scenario, play(scenario, opened, 60).cluster));
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
    // Every address is slower than the limit: the rate limit matches nothing and checkout stays down.
    const limited = play(scenario, run(scenario, opened, "waf ratelimit 20/1m"), 120);
    expect(scenario.isRootCauseFixed(limited.cluster)).toBe(false);
    expect(blockedAttackShare(limited.cluster.commerce?.wafRules ?? [])).toBe(0);
    expect(blockedShare(limited.cluster.commerce?.wafRules ?? [])).toBeLessThan(0.001);
    expect(limited.cluster.errorRate).toBeGreaterThan(0.05);
    // Below hundreds of customers, a top-talker block takes shoppers and barely any attackers.
    const topped = play(scenario, run(scenario, opened, "waf block --top 500"), 120);
    expect(scenario.isRootCauseFixed(topped.cluster)).toBe(false);
    expect(blockedAttackShare(topped.cluster.commerce?.wafRules ?? [])).toBeLessThan(0.1);
    expect(blockedShare(topped.cluster.commerce?.wafRules ?? [])).toBeGreaterThan(0.3);
    if (!isProxies) {
      // The farm drives a real browser: its fingerprint block stops the attack and a slice of customers with it.
      const fingerprinted = play(scenario, run(scenario, opened, `waf block --ja4 ${attack.ja4}`), 60);
      expect(blockedShare(fingerprinted.cluster.commerce?.wafRules ?? [])).toBeGreaterThan(0.01);
      const result = debrief(fingerprinted, scenario, true);
      expect(result.objectives?.find((objective) => objective.label.includes("WAF rules are turning away"))?.isMet).toBe(false);
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
