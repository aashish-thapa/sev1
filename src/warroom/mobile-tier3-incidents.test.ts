import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { MOBILE_TIER3_INCIDENTS } from "./scenarios/mobile-tier3-incidents.ts";
import { runLine } from "./shell/shell.ts";

/** As solutions.test.ts plays a worked answer: the first move 20 s after the page, a command every 8 s, then 180 s to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const MONITORING_SECONDS = 700;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const TOOL_WORDS = /\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

/** Runs a line on the mobile laptop; fails the test if the shell or a tool turns it down. */
function shell(scenario: Scenario, incident: Incident, line: string): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "mobile" });
  const errors = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  expect(errors, `${scenario.id} · ${line}`).toEqual([]);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function solve(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.mobile ?? []) incident = play(scenario, shell(scenario, incident, step.command), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function resolve(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  return { refused: declared.notice, closed: play(scenario, declared.incident, MONITORING_SECONDS) };
}

/** The tempting move at t=20, then the same settle a fix gets. */
function tempted(scenario: Scenario, line: string): Incident {
  return play(scenario, shell(scenario, play(scenario, openIncident(scenario), FIRST_MOVE_AT), line), SETTLE_SECONDS);
}

/** The tempting move each incident's room argues for, which must make things worse than doing nothing. */
const TRAPS: Readonly<Record<string, string>> = {
  "mob-t3-android-wall-in-review": "remote-config set min_supported_version 7.4.1",
  "mob-t3-ios-floor-strands-stragglers": "remote-config set min_supported_version 7.2.0",
  "mob-t3-shared-floor-walls-ios": "remote-config set min_supported_version 7.9.4",
  "mob-t3-kill-switch-legacy-webview": "remote-config set checkout_native_sheet_enabled false",
  "mob-t3-runbook-retired-host": "remote-config set checkout_api_host api-v1.marlow.shop",
  "mob-t3-resume-ios-crashing-release": "releases resume ios 7.4.2",
  "mob-t3-wildcard-allowlist": 'remote-config set webview_allowed_hosts "*"',
  "mob-t3-autocomplete-off-locks-address": "remote-config set checkout_address_autocomplete off",
  "mob-t3-hide-express-pay": "remote-config set checkout_express_pay_enabled false",
  "mob-t3-payment-sheet-web-fallback": "remote-config set checkout_payment_sheet web-fallback",
  "mob-t3-token-refresh-legacy": "remote-config set auth_refresh_strategy legacy",
  "mob-t3-quote-ttl-zero": "remote-config set checkout_quote_ttl_seconds 0",
  "mob-t3-cart-sync-off-stale-prices": "remote-config set cart_sync_mode off",
  "mob-t3-resume-android-cronet": "releases resume android 7.6.0",
};

describe("mobile tier-3 incidents", () => {
  it("has fourteen incidents with unique ids, seeds and titles, and a trap for each", () => {
    expect(MOBILE_TIER3_INCIDENTS).toHaveLength(14);
    for (const field of ["id", "seed", "title"] as const) {
      expect(new Set(MOBILE_TIER3_INCIDENTS.map((scenario) => scenario[field])).size).toBe(MOBILE_TIER3_INCIDENTS.length);
    }
    expect(Object.keys(TRAPS).sort()).toEqual(MOBILE_TIER3_INCIDENTS.map((scenario) => scenario.id).sort());
  });
});

describe.each(MOBILE_TIER3_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (id, scenario) => {
  it("pages the mobile role alone at tier 3, with a fair card", () => {
    expect(id).toMatch(/^mob-t3-[a-z0-9-]+$/);
    expect(scenario.roles).toEqual(["mobile"]);
    expect(scenario.tier).toBe(3);
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const commands = (scenario.solution.mobile ?? []).map((step) => step.command);
    const fix = commands[0].replace(/\s+--note\s.*$/, "");
    expect(commands[0]).toMatch(/^remote-config set /);
    for (const hint of scenario.hints) {
      expect(hint).not.toMatch(TOOL_WORDS);
      for (const command of [...commands, fix]) expect(hint).not.toContain(command);
    }
    expect(scenario.suggestions?.mobile).not.toContain(fix);
    expect(scenario.suggestions?.mobile).not.toContain(commands[0]);
    const { options, answerIndex } = scenario.postmortem;
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("gets worse over ten minutes if nobody acts", () => {
    const opened = openIncident(scenario);
    const twoMinutes = play(scenario, opened, 120);
    const tenMinutes = play(scenario, twoMinutes, 480);
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.01);
    expect(alertRate(scenario, tenMinutes.cluster)).toBeGreaterThanOrEqual(alertRate(scenario, opened.cluster) - 1e-9);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(twoMinutes, scenario, true).points);
    expect(declareResolved(tenMinutes, scenario).notice?.kind).toBe("refused");
  });

  it("closes at grade S or A when the worked solution is typed into the shell", () => {
    const { refused, closed } = resolve(scenario, solve(scenario));
    expect(refused).toBeUndefined();
    expect(closed.phase.name).toBe("closed");
    const result = debrief(closed, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("backfires on the tempting move: worse than doing nothing, unresolvable, root cause untouched", () => {
    const trap = TRAPS[id];
    expect(scenario.suggestions?.mobile).toContain(trap);
    const trapped = tempted(scenario, trap);
    const untouched = play(scenario, openIncident(scenario), FIRST_MOVE_AT + SETTLE_SECONDS);
    expect(alertRate(scenario, trapped.cluster)).toBeGreaterThan(alertRate(scenario, untouched.cluster));
    expect(trapped.cluster.failedCheckouts).toBeGreaterThan(untouched.cluster.failedCheckouts);
    expect(declareResolved(trapped, scenario).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(trapped.cluster)).toBe(false);
  });

  it("is deterministic", () => {
    expect(solve(scenario)).toEqual(solve(scenario));
  });

  it("round-trips its state through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const fix = scenario.solution.mobile?.[0].command ?? "";
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 150; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === FIRST_MOVE_AT) next = shell(scenario, next, fix);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
