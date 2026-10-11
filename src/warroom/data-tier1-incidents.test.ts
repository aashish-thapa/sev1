import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { DATA_TIER1_INCIDENTS } from "./scenarios/data-tier1-incidents.ts";
import { runLine } from "./shell/shell.ts";

/** Paced like solutions.test.ts: first move 20 s in, a command every 8 s, then time to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
const TRAP_AT = 40;
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const FIX = /^(reconcile submit|models (rollback|threshold|mode)|pipelines run)\b/;
const TOOL_IN_HINT = /\b(kubectl|psql|flags|remote-config|siem|waf|reconcile|releases|rum|warehouse|curl|models|pipelines)\s/;

/** The hurried move each story tempts the player with. "late" waits past the settlement cut-off to submit the refund batch. */
const TRAPS: Readonly<Record<string, string>> = {
  "data-t1-lunch-flash-voids": "late",
  "data-t1-gift-card-promo-refunds": "late",
  "data-t1-push-notification-surge": "late",
  "data-t1-payday-sale-cutoff": "late",
  "data-t1-postcode-feature-retrain": "models mode fraud-scorer fail-open",
  "data-t1-shadow-model-promoted": "models threshold fraud-scorer 0.95",
  "data-t1-uncalibrated-scores": "models mode fraud-scorer fail-open",
  "data-t1-loyalty-feature-grant": "models rollback fraud-scorer",
  "data-t1-address-feature-disk-full": "models rollback fraud-scorer",
  "data-t1-basket-feature-statement-timeout": "models rollback fraud-scorer",
  "data-t1-experiment-threshold-left": "models rollback fraud-scorer",
  "data-t1-threshold-transposed-digits": "models mode fraud-scorer fail-open",
  "data-t1-fail-open-after-maintenance": "models rollback fraud-scorer",
  "data-t1-fail-open-quiet-fraud": "models threshold fraud-scorer 0.7",
};

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

function shell(scenario: Scenario, line: string, incident: Incident) {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "data" });
}

/** Runs one line on the data laptop and keeps what it changed; fails on anything the tool turns down. */
function as(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = shell(scenario, line, incident);
  const refusals = result.output.filter((output) => output.tone === "err" && REFUSAL.test(output.text)).map((output) => output.text);
  if (refusals.length > 0) throw new Error(`${line}: ${refusals.join("\n")}`);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function solved(scenario: Scenario): Incident {
  let incident = playTo(scenario, FIRST_MOVE_AT, openIncident(scenario));
  for (const step of scenario.solution.data ?? []) incident = play(scenario, as(scenario, step.command, incident), THINKING_SECONDS);
  return play(scenario, incident, SETTLE_SECONDS);
}

function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, declared.incident, 700);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

function fixCommand(scenario: Scenario): string {
  const fix = scenario.solution.data?.find((step) => FIX.test(step.command));
  if (!fix) throw new Error(`${scenario.id} has no fix step`);
  return fix.command;
}

/** The incident second its settlement cut-off falls on, read back from the objective's own clock label. */
function cutoffOf(scenario: Scenario): number {
  const label = scenario.objectives?.(openIncident(scenario).cluster)[0]?.label ?? "";
  const [, hours, minutes] = /(\d\d):(\d\d)/.exec(label) ?? [];
  return Number(hours) * 3600 + Number(minutes) * 60 - scenario.opensAtSecondOfDay;
}

describe("data tier 1 incidents", () => {
  it("are fourteen distinct guided data incidents, each with a trap", () => {
    expect(DATA_TIER1_INCIDENTS).toHaveLength(14);
    for (const key of ["id", "seed", "title"] as const) {
      expect(new Set(DATA_TIER1_INCIDENTS.map((scenario) => scenario[key])).size, key).toBe(14);
    }
    expect(new Set(DATA_TIER1_INCIDENTS.map((scenario) => scenario.evidence?.[0]?.name)).size).toBe(14);
    expect(new Set(DATA_TIER1_INCIDENTS.map((scenario) => scenario.opensAtSecondOfDay)).size).toBe(14);
    expect(Object.keys(TRAPS).sort()).toEqual(DATA_TIER1_INCIDENTS.map((scenario) => scenario.id).sort());
  });
});

describe.each(DATA_TIER1_INCIDENTS.map((scenario) => [scenario.id, scenario] as const))("%s", (id, scenario) => {
  it("is a guided data incident with fair hints, chips and postmortem", () => {
    expect(id.startsWith("data-t1-")).toBe(true);
    expect(scenario.seed).toBe(id);
    expect(scenario.tier).toBe(1);
    expect(scenario.roles).toEqual(["data"]);
    expect(scenario.roleBriefings?.data).toBeTruthy();
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const fix = fixCommand(scenario);
    for (const hint of scenario.hints) {
      for (const step of scenario.solution.data ?? []) expect(hint).not.toContain(step.command);
      expect(hint).not.toMatch(TOOL_IN_HINT);
    }
    const chips = scenario.suggestions?.data ?? [];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips).not.toContain(fix);
    const opened = openIncident(scenario);
    for (const chip of chips) {
      expect(shell(scenario, chip, opened).output.filter((line) => line.tone === "err").map((line) => line.text), chip).toEqual([]);
    }
    for (const view of scenario.evidence ?? []) {
      const text = shell(scenario, `warehouse run ${view.name}`, opened).output.map((line) => line.text).join("\n");
      expect(text).toMatch(/\(\d+ rows?\)/);
      expect(text).not.toMatch(/NaN|Infinity|undefined/);
    }
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length).toBeLessThan(longestOther);
  });

  it("gets worse if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    const minute = playTo(scenario, 60, opened);
    const tenMinutes = playTo(scenario, 600, minute);
    const isRising = alertRate(scenario, tenMinutes.cluster) > alertRate(scenario, opened.cluster);
    const isCostlier = debrief(tenMinutes, scenario, true).points < debrief(minute, scenario, true).points;
    expect(isRising || isCostlier).toBe(true);
    expect(declareResolved(tenMinutes, scenario).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(tenMinutes.cluster)).toBe(false);
  });

  it("closes at S or A when the worked solution is followed", () => {
    const { refused, closed, result } = closeOut(scenario, solved(scenario));
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet) ?? true).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("springs its trap: the tempting move leaves the incident unfixed or costs the objective", () => {
    const trap = TRAPS[id];
    const correct = closeOut(scenario, solved(scenario)).result;
    if (trap === "late") {
      const cutoff = cutoffOf(scenario);
      const late = playTo(scenario, cutoff + 300, as(scenario, "reconcile submit", playTo(scenario, cutoff + 5, openIncident(scenario))));
      const onTime = playTo(scenario, cutoff + 300, as(scenario, "reconcile submit", playTo(scenario, 60, openIncident(scenario))));
      expect(scenario.objectives?.(late.cluster)[0]?.isMet).toBe(false);
      expect(scenario.objectives?.(onTime.cluster)[0]?.isMet).toBe(true);
      expect(debrief(late, scenario, true).points).toBeLessThan(debrief(onTime, scenario, true).points - 9);
      return;
    }
    const trapped = play(scenario, as(scenario, trap, playTo(scenario, TRAP_AT, openIncident(scenario))), SETTLE_SECONDS);
    expect(scenario.isRootCauseFixed(trapped.cluster)).toBe(false);
    expect(debrief(trapped, scenario, true).points).toBeLessThan(correct.points - 15);
  });

  it("is deterministic", () => {
    expect(solved(scenario).cluster).toEqual(solved(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips through multiplayer frames while the solution is played", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.data ?? [];
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(next.cluster.t - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = as(scenario, step.command, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });
});
