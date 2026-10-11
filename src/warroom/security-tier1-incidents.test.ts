import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { SECURITY_TIER1_INCIDENTS } from "./scenarios/security-tier1-incidents.ts";
import { runLine } from "./shell/shell.ts";
import type { Commerce } from "./sim/commerce.ts";
import { blockedAttackShare, blockedShare, topSources } from "./sim/edge.ts";

/** Paced like solutions.test.ts: first move 20 s in, a command every 8 s, then time for the edge to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const TRAP_AT = 40;

const CHROMIUM_JA4 = "t13d1517h2_8daaf6152771_cb7bf5808d99";
const SAFARI_JA4 = "t13d2014h2_a09f3c656075_14788d8d241b";

type TrapEffect = "blocks-customers" | "misses-attack" | "both";
type Trap = { readonly line: (incident: Incident) => string; readonly effect: TrapEffect };
const fixed = (line: string, effect: TrapEffect): Trap => ({ line: () => line, effect });

/** The hurried move each incident's story warns against, and what it does. */
const TRAPS: Readonly<Record<string, Trap>> = {
  "sec-t1-gift-card-guesser": fixed("waf block --top 500", "blocks-customers"),
  "sec-t1-promo-code-brute": fixed("waf ratelimit 5/1m", "blocks-customers"),
  "sec-t1-catalogue-scraper": fixed("waf block --top 100", "blocks-customers"),
  "sec-t1-load-test-on-prod": fixed("waf block --top 500", "blocks-customers"),
  "sec-t1-password-reset-flood": {
    line: (incident) => `waf block ${topSources(commerceOf(incident), incident.cluster.t, 1)[0].ip}`,
    effect: "misses-attack",
  },
  "sec-t1-signup-farm": fixed("waf block --top 50", "misses-attack"),
  "sec-t1-restock-watchers": fixed("waf ratelimit 2/1m", "blocks-customers"),
  "sec-t1-review-spam": fixed("waf block --top 500", "blocks-customers"),
  "sec-t1-loyalty-drain": fixed(`waf block --ja4 ${CHROMIUM_JA4}`, "both"),
  "sec-t1-address-check-abuse": fixed("waf block --top 500", "both"),
  "sec-t1-shipping-quote-scrape": fixed(`waf block --ja4 ${SAFARI_JA4}`, "both"),
  "sec-t1-cart-hold-bots": fixed(`waf block --ja4 ${CHROMIUM_JA4}`, "blocks-customers"),
  "sec-t1-sms-otp-pumping": fixed("waf ratelimit 2/1m", "blocks-customers"),
  "sec-t1-search-hammer": fixed("waf block --top 500", "blocks-customers"),
};

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

/** Runs one line on the security laptop and applies whatever it changed; fails on anything the tool turns down. */
function as(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" });
  const errors = result.output.filter((output) => output.tone === "err").map((output) => output.text);
  if (errors.length > 0) throw new Error(`${line}: ${errors.join("\n")}`);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function shellText(scenario: Scenario, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" })
    .output.map((output) => output.text)
    .join("\n");
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("no commerce");
  return commerce;
}

const customersBlocked = (incident: Incident) => blockedShare(commerceOf(incident).wafRules);

function solved(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.security ?? []) incident = play(scenario, as(scenario, step.command, incident), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, declared.incident, 700);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

/** Checkouts lost over the minute that ends at `t`, nobody acting. */
function lostInMinuteTo(scenario: Scenario, t: number): number {
  const before = playTo(scenario, t - 60, openIncident(scenario));
  return playTo(scenario, t, before).cluster.failedCheckouts - before.cluster.failedCheckouts;
}

function fixCommand(scenario: Scenario): string {
  const fix = scenario.solution.security?.find((step) => /^waf (block|ratelimit) /.test(step.command));
  if (!fix) throw new Error(`${scenario.id} has no fix step`);
  return fix.command;
}

describe("security tier 1 incidents", () => {
  it("are fourteen distinct guided security incidents, each with a trap", () => {
    expect(SECURITY_TIER1_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(SECURITY_TIER1_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(14);
    }
    expect(new Set(SECURITY_TIER1_INCIDENTS.map((scenario) => commerceOf(openIncident(scenario)).attack?.path)).size).toBe(14);
    expect(new Set(SECURITY_TIER1_INCIDENTS.map((scenario) => scenario.evidence?.[0]?.name)).size).toBe(14);
    expect(Object.keys(TRAPS).sort()).toEqual(SECURITY_TIER1_INCIDENTS.map((scenario) => scenario.id).sort());
  });
});

describe.each(SECURITY_TIER1_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (id, scenario) => {
  it("is a guided security incident with fair hints, suggestions and postmortem", () => {
    expect(id.startsWith("sec-t1-")).toBe(true);
    expect(scenario.tier).toBe(1);
    expect(scenario.roles).toEqual(["security"]);
    expect(scenario.roleBriefings?.security).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const fix = fixCommand(scenario);
    for (const hint of scenario.hints) {
      expect(hint).not.toContain(fix);
      expect(hint).not.toMatch(/\bwaf (block|ratelimit)\b/);
    }
    expect(scenario.suggestions?.security?.length).toBeGreaterThan(0);
    expect(scenario.suggestions?.security ?? []).not.toContain(fix);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
    expect(explanation.cause.length).toBeLessThanOrEqual(90);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
    const opened = openIncident(scenario);
    for (const view of scenario.evidence ?? []) {
      expect(shellText(scenario, `siem search ${view.name}`, opened)).not.toMatch(/NaN|Infinity|undefined|unknown saved search/);
    }
  });

  it("gets worse if nobody acts: the pager refuses, and more checkouts are lost each minute", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.05);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    expect(lostInMinuteTo(scenario, 600)).toBeGreaterThan(lostInMinuteTo(scenario, 60) * 1.1);
    expect(declareResolved(playTo(scenario, 600, opened), scenario).notice?.kind).toBe("refused");
  });

  it("closes at S or A when the worked solution is followed, with no customer blocked", () => {
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

  it("springs its trap: the hurried move blocks customers or misses the attack", () => {
    const trap = TRAPS[id];
    let incident = playTo(scenario, TRAP_AT, openIncident(scenario));
    incident = play(scenario, as(scenario, trap.line(incident), incident), SETTLE_SECONDS);
    if (trap.effect !== "misses-attack") {
      expect(customersBlocked(incident)).toBeGreaterThan(0.01);
      const correct = closeOut(scenario, solved(scenario)).result;
      const { result } = closeOut(scenario, incident);
      expect(result.objectives?.find((objective) => objective.label.includes("customers"))?.isMet).toBe(false);
      expect(result.points).toBeLessThan(correct.points - 15);
    }
    if (trap.effect !== "blocks-customers") {
      expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
      expect(blockedAttackShare(commerceOf(incident).wafRules)).toBeLessThan(0.5);
      expect(declareResolved(incident, scenario).notice?.kind).toBe("refused");
    }
  });

  it("is deterministic", () => {
    expect(solved(scenario).cluster).toEqual(solved(scenario).cluster);
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
      if (step) next = as(scenario, step.command, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(blockedAttackShare(commerceOf(server).wafRules)).toBeGreaterThan(0.5);
    expect(client).toEqual(server);
  });
});
