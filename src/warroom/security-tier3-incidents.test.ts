import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { SECURITY_TIER3_INCIDENTS } from "./scenarios/security-tier3-incidents.ts";
import { runLine } from "./shell/shell.ts";
import type { Commerce } from "./sim/commerce.ts";
import { BROWSER_JA4, blockedAttackShare, blockedShare } from "./sim/edge.ts";

const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
/** A trap played at this second, the way a hurried analyst would. */
const TRAP_AT = 40;
/** The suggestion chip that pulls the containment everyone reaches for: a top-N playbook, a tight rate limit, or a browser's JA4. */
const TRAP = /^(siem resolve \S+ --disposition true-positive$|waf ratelimit |waf block --ja4 )/;

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, Math.max(0, t - incident.cluster.t), incident);
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" });
}

/** Runs a security command, failing the test if the shell or a tool turns it down. */
function run(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = shell(scenario, incident, line);
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function text(scenario: Scenario, incident: Incident, line: string): string {
  return shell(scenario, incident, line).output.map((output) => output.text).join("\n");
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("no commerce");
  return commerce;
}

const customersBlocked = (incident: Incident) => blockedShare(commerceOf(incident).wafRules);
const attackBlocked = (incident: Incident) => blockedAttackShare(commerceOf(incident).wafRules);

/** The worked solution as solutions.test.ts plays it: first move at 20 s, 8 s apart, then 180 s to settle. */
function solved(scenario: Scenario): Incident {
  let incident = play(scenario, FIRST_MOVE_AT, openIncident(scenario));
  for (const step of scenario.solution.security ?? []) incident = play(scenario, THINKING_SECONDS, run(scenario, incident, step.command));
  return play(scenario, SETTLE_SECONDS, incident);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, 700, declared.incident);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

function trapLine(scenario: Scenario): string {
  const trap = scenario.suggestions?.security?.find((line) => TRAP.test(line));
  if (!trap) throw new Error(`${scenario.id} has no trap chip`);
  return trap;
}

function trapped(scenario: Scenario): Incident {
  return play(scenario, SETTLE_SECONDS, run(scenario, playTo(scenario, TRAP_AT, openIncident(scenario)), trapLine(scenario)));
}

const playbookOf = (scenario: Scenario) => commerceOf(openIncident(scenario)).alerts[0];
const customersObjective = (result: ReturnType<typeof closeOut>["result"]) => result.objectives?.find((objective) => objective.label.includes("customers"));

describe("security tier 3 incidents: catalogue", () => {
  it("has fourteen distinct security tier 3 incidents", () => {
    expect(SECURITY_TIER3_INCIDENTS).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) expect(new Set(SECURITY_TIER3_INCIDENTS.map((scenario) => scenario[field])).size).toBe(14);
    expect(new Set(SECURITY_TIER3_INCIDENTS.map((scenario) => playbookOf(scenario).id)).size).toBe(14);
    expect(new Set(SECURITY_TIER3_INCIDENTS.map((scenario) => scenario.evidence?.[0]?.name)).size).toBe(14);
    expect(new Set(SECURITY_TIER3_INCIDENTS.map((scenario) => scenario.postmortem.question)).size).toBe(14);
    for (const scenario of SECURITY_TIER3_INCIDENTS) {
      expect(scenario.id).toMatch(/^sec-t3-[a-z0-9-]+$/);
      expect(scenario.tier).toBe(3);
      expect(scenario.roles).toEqual(["security"]);
      expect(scenario.roleBriefings?.security).toBeTruthy();
    }
  });
});

describe.each(SECURITY_TIER3_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("follows the content rules: hints, chips, evidence and a postmortem whose answer isn't the longest", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = scenario.solution.security?.map((step) => step.command) ?? [];
    for (const hint of scenario.hints) {
      for (const command of commands) expect(hint).not.toContain(command);
      expect(hint).not.toMatch(/\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/);
    }
    const fixes = commands.filter((command) => command.startsWith("waf block") || command.includes("--contained-by") || command.startsWith("siem resolve"));
    for (const chip of scenario.suggestions?.security ?? []) expect(fixes).not.toContain(chip);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
    expect(explanation.cause.length).toBeLessThanOrEqual(90);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
    const opened = openIncident(scenario);
    for (const view of scenario.evidence ?? []) expect(text(scenario, opened, `siem search ${view.name}`)).not.toMatch(/NaN|Infinity|undefined|unknown saved search/);
  });

  it("gets worse if nobody acts for ten minutes", () => {
    const opened = openIncident(scenario);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.05);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    const idle = playTo(scenario, 600, opened);
    expect(debrief(idle, scenario, true).points).toBeLessThan(debrief(opened, scenario, true).points - 30);
  });

  it("closes at S or A with the worked solution, no customer blocked", () => {
    const incident = solved(scenario);
    expect(incident.cluster.errorRate).toBe(0);
    expect(customersBlocked(incident)).toBe(0);
    const { refused, closed, result } = closeOut(scenario, incident);
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("backfires on customers when the obvious containment is pulled", () => {
    const blunt = trapped(scenario);
    expect(customersBlocked(blunt)).toBeGreaterThan(0.02);
    expect(attackBlocked(blunt)).toBeLessThan(0.5);
    const { result } = closeOut(scenario, blunt);
    expect(customersObjective(result)?.isMet).toBe(false);
    expect(result.points).toBeLessThan(closeOut(scenario, solved(scenario)).result.points - 15);
    const trap = trapLine(scenario);
    if (trap.startsWith("siem resolve")) expect(commerceOf(blunt).wafRules.at(-1)?.createdBy).toContain("soar:playbook");
    const ja4 = /^waf block --ja4 (\S+)$/.exec(trap)?.[1];
    if (ja4) {
      expect(customersBlocked(blunt)).toBeCloseTo(BROWSER_JA4.find((entry) => entry.ja4 === ja4)?.customerShare ?? -1, 9);
      expect(attackBlocked(blunt)).toBe(0);
    }
  });

  it("lets the playbook block customers by itself if the timer runs out", () => {
    const alert = playbookOf(scenario);
    if (alert.autoContainAt === null) {
      expect(customersBlocked(playTo(scenario, 600, openIncident(scenario)))).toBe(0);
      return;
    }
    const before = playTo(scenario, alert.autoContainAt - 1, openIncident(scenario));
    expect(customersBlocked(before)).toBe(0);
    const after = playTo(scenario, alert.autoContainAt + 1, before);
    expect(customersBlocked(after)).toBeGreaterThan(0.2);
    expect(attackBlocked(after)).toBeLessThan(0.2);
    expect(after.cluster.logs.waf?.at(-1)?.text).toContain("soar:playbook/auto-contain");
  });

  it("is deterministic", () => {
    expect(solved(scenario).cluster).toEqual(solved(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips its attack, rules and alerts through multiplayer frames", () => {
    const relay = (previous: Incident | null, next: Incident) => applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.security ?? [];
    let server = openIncident(scenario);
    let client = relay(null, server);
    for (let second = 0; second < 100; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(second - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = run(scenario, next, step.command);
      client = relay(client, next);
      server = next;
    }
    expect(attackBlocked(server)).toBeGreaterThan(0.5);
    expect(client).toEqual(server);
  });
});
