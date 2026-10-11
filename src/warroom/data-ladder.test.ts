import { describe, expect, it } from "vitest";
import type { Role } from "../domain/incident.ts";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, alertRate, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { checkoutCluster } from "./scenarios/checkout-cluster.ts";
import { checkoutCommerce } from "./scenarios/checkout-commerce.ts";
import { checkoutMeltdown } from "./scenarios/checkout-meltdown.ts";
import { fraudModelRegression } from "./scenarios/fraud-model-regression.ts";
import { scorerOf } from "./scenarios/fraud-scorer.ts";
import { FRAUD_CAPTURE_BOUND, fraudThresholdFailOpen } from "./scenarios/fraud-threshold-fail-open.ts";
import { refundDoubleCharges, SETTLEMENT_CUTOFF } from "./scenarios/refund-double-charges.ts";
import { SCENARIOS, unlockedWarRooms } from "./scenarios/index.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { FEATURE_DAG, staleFraudFeatures } from "./scenarios/stale-fraud-features.ts";
import { airflowCompact, airflowLine } from "./shell/commands/pipelines.ts";
import { SSO_GROUPS } from "./shell/identity.ts";
import { completeLine, runLine } from "./shell/shell.ts";
import { pendingRefunds, visibleOrphans } from "./sim/commerce-actions.ts";
import { customerLossRate, type Settlement } from "./sim/commerce-step.ts";
import type { Commerce, FraudScoring } from "./sim/commerce.ts";
import { FEATURE_MAX_AGE_SECONDS, fraudDeclines, NO_FRAUD, scoredAt, stepFraud } from "./sim/fraud.ts";

const HOUR = 3600;
/** How `solutions.test.ts` tells the shell or a tool turning a command down from red log lines. */
const REFUSAL = /^(bash:|error:|Error from server|usage:|ERROR:|psql: error|[a-z-]+: )/;
const ORGANIC_CHECKOUTS = 300 * 0.4;

const SCORER: FraudScoring = {
  model: "fraud-scorer",
  versions: [
    { version: "v11", deployedAt: -40 * 24 * HOUR, note: "baseline", falseDeclineShare: 0.005, catchShare: 0.9 },
    { version: "v12", deployedAt: -9 * 24 * HOUR, note: "weekly retrain", falseDeclineShare: 0.004, catchShare: 0.95 },
  ],
  active: "v12",
  threshold: 0.85,
  tunedThreshold: 0.85,
  mode: "enforce",
  features: [
    { name: "customer_orders_90d", pipeline: "features_customer_daily", lastSuccessAt: -6 * HOUR, refresh: null },
    { name: "device_accounts_30d", pipeline: "features_device_daily", lastSuccessAt: -5 * HOUR, refresh: null },
  ],
  staleFeatureDeclineShare: 0.1,
  fraudAttemptsPerSecond: 10,
};

function withFraud(fraud: Partial<FraudScoring> = {}): Commerce {
  return checkoutCommerce({ fraud: { ...SCORER, ...fraud } });
}

/** A calm builder-made shop with a fraud scorer in front of the gateway, paging on lost customers. */
function shop(commerce: Commerce): Scenario {
  return {
    ...scaledToZero,
    id: "fraud-example",
    seed: "fraud-example",
    roles: ["data"],
    alertMetric: { label: "customers lost", rate: (state) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) },
    initialState: () =>
      checkoutCluster({ seed: "fraud-example", revisions: [{ number: 1, tag: "v4.11.3", changeCause: "v4.11.3 order-status webhooks", traits: [] }], revision: 1, commerce }),
  };
}

function play(scenario: Scenario, seconds: number, incident: Incident): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("no commerce in this incident");
  return commerce;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, Math.max(0, t - incident.cluster.t), incident);
}

/** Runs `line` on `role`'s laptop and keeps whatever it changed. */
function shellOn(scenario: Scenario, incident: Incident, line: string, role: Role = "data") {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  return {
    text: result.output.map((output) => output.text).join("\n"),
    errors: result.output.filter((output) => output.tone === "err").map((output) => output.text),
    changed: result.cluster !== undefined,
    incident: result.cluster ? { ...incident, cluster: result.cluster } : incident,
  };
}

/** Plays `steps` (second, command) on the data laptop, then the clock to `until`. */
function scripted(scenario: Scenario, steps: readonly (readonly [number, string])[], until: number): Incident {
  let incident = openIncident(scenario);
  for (const [at, line] of steps) {
    const result = shellOn(scenario, playTo(scenario, at, incident), line);
    if (!result.changed) throw new Error(`${line} changed nothing:\n${result.text}`);
    incident = result.incident;
  }
  return playTo(scenario, until, incident);
}

/** The worked solution as `solutions.test.ts` plays it: first move at 20 s, 8 s apart, 180 s to settle, then declare and monitor. */
function workedSolution(scenario: Scenario) {
  let incident = playTo(scenario, 20, openIncident(scenario));
  for (const step of scenario.solution.data ?? []) {
    const result = shellOn(scenario, incident, step.command);
    expect(result.errors.filter((text) => REFUSAL.test(text)), step.command).toEqual([]);
    incident = play(scenario, 8, result.incident);
  }
  const settled = play(scenario, 180, incident);
  const declared = declareResolved(settled, scenario);
  expect(declared.notice, `${scenario.id} refused to resolve`).toBeUndefined();
  const closed = play(scenario, 700, declared.incident);
  return { settled, closed, result: debrief(closed, scenario, true) };
}

/** The client a room keeps in sync from frames matches the server's state, second by second. */
function expectFramesToRoundTrip(scenario: Scenario, steps: readonly (readonly [number, string])[], seconds: number) {
  const roundTrip = (previous: Incident | null, next: Incident) =>
    applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
  let server = openIncident(scenario);
  let client = roundTrip(null, server);
  for (let second = 0; second < seconds; second += 1) {
    let next = advance(server, scenario).incident;
    for (const [at, line] of steps) if (at === next.cluster.t) next = shellOn(scenario, next, line).incident;
    client = roundTrip(client, next);
    server = next;
  }
  expect(client).toEqual(server);
  return server;
}

function expectChipsToRun(scenario: Scenario) {
  const opened = openIncident(scenario);
  for (const line of scenario.suggestions?.data ?? []) {
    expect(shellOn(scenario, opened, line).errors, line).toEqual([]);
  }
}

describe("fraud scoring physics", () => {
  const [, v12] = SCORER.versions;

  it("scores a version as tuned at its tuned threshold", () => {
    expect(scoredAt(v12, 0.85, 0.85)).toEqual({ falseDeclineShare: 0.004, catchShare: 0.95 });
  });

  it("declines more good customers and catches more fraud as the threshold drops, and less of both as it rises", () => {
    const lowered = scoredAt(v12, 0.35, 0.85);
    expect(lowered.falseDeclineShare).toBeCloseTo(0.004 * 2.2 ** 5, 9);
    expect(lowered.catchShare).toBeCloseTo(1 - 0.05 / 1.5 ** 5, 9);
    const raised = scoredAt(v12, 0.95, 0.85);
    expect(raised.falseDeclineShare).toBeLessThan(0.004);
    expect(raised.catchShare).toBeLessThan(0.95);
  });

  it("stays a share at the extremes, and treats a non-number as the tuned threshold", () => {
    expect(scoredAt(v12, 0, 0.85).falseDeclineShare).toBeLessThanOrEqual(1);
    expect(scoredAt(v12, 1, 0.85).catchShare).toBeGreaterThanOrEqual(0);
    expect(scoredAt({ ...v12, catchShare: 0.2 }, 1, 0.3).catchShare).toBe(0);
    expect(scoredAt(v12, Number.NaN, 0.85)).toEqual(scoredAt(v12, 0.85, 0.85));
  });

  it("is neutral without a scorer", () => {
    expect(fraudDeclines(checkoutCommerce(), 0)).toBe(NO_FRAUD);
  });

  it("declines the active version's false positives and passes the fraud it misses", () => {
    expect(fraudDeclines(withFraud(), 0)).toEqual({ declinedCheckoutShare: 0.004, gatewayCallsPerSecond: expect.closeTo(0.5, 9) });
    expect(fraudDeclines(withFraud({ active: "v11" }), 0)).toEqual({ declinedCheckoutShare: 0.005, gatewayCallsPerSecond: expect.closeTo(1, 9) });
  });

  it("adds a decline share for each stale feature, from the moment it crosses the freshness guard", () => {
    const commerce = withFraud();
    const ordersStaleAt = -6 * HOUR + FEATURE_MAX_AGE_SECONDS + 1;
    expect(fraudDeclines(commerce, ordersStaleAt - 1).declinedCheckoutShare).toBeCloseTo(0.004, 9);
    expect(fraudDeclines(commerce, ordersStaleAt).declinedCheckoutShare).toBeCloseTo(0.104, 9);
    expect(fraudDeclines(commerce, ordersStaleAt + HOUR).declinedCheckoutShare).toBeCloseTo(0.204, 9);
    expect(fraudDeclines(withFraud({ staleFeatureDeclineShare: 0.7 }), ordersStaleAt + HOUR).declinedCheckoutShare).toBe(1);
  });

  it("fails open by declining nobody and letting every fraud attempt through", () => {
    expect(fraudDeclines(withFraud({ mode: "fail-open", staleFeatureDeclineShare: 0.5 }), 30 * HOUR)).toEqual({ declinedCheckoutShare: 0, gatewayCallsPerSecond: 10 });
  });

  it("finishes a feature refresh after its seconds run out", () => {
    const refreshing = withFraud({ features: [{ ...SCORER.features[0], lastSuccessAt: -30 * HOUR, refresh: { startedAt: 40, secondsLeft: 2 } }] });
    const settle = (commerce: Commerce, t: number): Commerce =>
      stepFraud(commerce, { t, processedCharges: 0, demand: { fraudGatewayCallsPerSecond: 0 } } as unknown as Settlement);
    const once = settle(refreshing, 41);
    expect(once.fraud?.features[0].refresh).toEqual({ startedAt: 40, secondsLeft: 1 });
    expect(fraudDeclines(once, 41).declinedCheckoutShare).toBeCloseTo(0.104, 9);
    const done = settle(once, 42);
    expect(done.fraud?.features[0]).toEqual({ ...SCORER.features[0], lastSuccessAt: 42, refresh: null });
    expect(fraudDeclines(done, 42).declinedCheckoutShare).toBeCloseTo(0.004, 9);
  });

  it("returns the very same commerce when there is no scorer", () => {
    const commerce = checkoutCommerce();
    expect(stepFraud(commerce, { t: 1, processedCharges: 100, demand: { fraudGatewayCallsPerSecond: 0 } } as unknown as Settlement)).toBe(commerce);
  });

  it("loses declined customers without 5xx, and captures the fraud it passes", () => {
    const scenario = shop(withFraud({ active: "v11", features: [], fraudAttemptsPerSecond: 20 }));
    const before = play(scenario, 5, openIncident(scenario));
    const after = play(scenario, 60, before);
    expect(after.cluster.errorRate).toBe(0);
    expect(customerLossRate(commerceOf(after), after.cluster.t)).toBeCloseTo(0.005, 9);
    expect(commerceOf(after).pulse.gatewayCallsPerSecond).toBeCloseTo(ORGANIC_CHECKOUTS * 0.995, 6);
    const captured = (commerceOf(after).ledger.fraudulentCaptures ?? 0) - (commerceOf(before).ledger.fraudulentCaptures ?? 0);
    expect(captured).toBeCloseTo(60 * 20 * 0.1, 6);
  });

  it("floods a gateway with no headroom when it fails open", () => {
    const scenario = shop(checkoutCommerce({ fraud: { ...SCORER, mode: "fail-open", fraudAttemptsPerSecond: 60 }, gateway: { chargesPerSecond: 150 } }));
    const flooded = play(scenario, 120, openIncident(scenario));
    expect(commerceOf(flooded).gateway.timeoutShare).toBe(1);
    expect(flooded.cluster.errorRate).toBeGreaterThan(0.3);
    expect(commerceOf(flooded).ledger.fraudulentCaptures).toBeGreaterThan(120 * 40);
  });
});

describe("the models command", () => {
  const scenario = shop(withFraud({ features: [...SCORER.features, { name: "customer_refunds_90d", pipeline: "features_customer_daily", lastSuccessAt: -30 * HOUR, refresh: null }] }));
  const opened = play(scenario, 5, openIncident(scenario));
  const run = (line: string, role: Role = "data", incident: Incident = opened) => runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  const text = (line: string, role: Role = "data", incident: Incident = opened) =>
    run(line, role, incident)
      .output.map((output) => output.text)
      .join("\n");
  const fraudAfter = (line: string) => run(line).cluster?.commerce?.fraud;

  it("lists the scorer and shows its versions, live decline rate and inputs", () => {
    expect(text("models list")).toMatch(/fraud-scorer\s+v12\s+enforce\s+0\.85\s+/);
    const shown = text("models show fraud-scorer");
    expect(shown).toMatch(/v12 \*\s+9d ago\s+10\.4% live/);
    expect(shown).toMatch(/v11\s+40d ago\s+0\.5% while serving/);
    expect(text("models features fraud-scorer")).toMatch(/customer_refunds_90d\s+features_customer_daily\s+30h ago\s+30h\s+STALE: served as default 0/);
    expect(text("models features fraud-scorer")).toMatch(/customer_orders_90d\s+features_customer_daily\s+\S+\s+6h0m\s+fresh/);
    expect(text("models show nope")).toContain('model "nope" not found');
  });

  it("rolls back to the version before, or the one named", () => {
    expect(fraudAfter("models rollback fraud-scorer")?.active).toBe("v11");
    expect(text("models rollback fraud-scorer")).toContain("rolled back v12 → v11");
    const rolledBack = { ...opened, cluster: run("models rollback fraud-scorer").cluster ?? opened.cluster };
    expect(text("models rollback fraud-scorer", "data", rolledBack)).toContain("v11 is the oldest version");
    expect(run("models rollback fraud-scorer --to v12", "data", rolledBack).cluster?.commerce?.fraud?.active).toBe("v12");
    expect(text("models rollback fraud-scorer --to v9")).toContain('version "v9" not found');
    expect(text("models rollback fraud-scorer --to v12")).toContain("already serving v12");
  });

  it("moves the threshold, and refuses anything that isn't a score", () => {
    expect(fraudAfter("models threshold fraud-scorer 0.9")?.threshold).toBe(0.9);
    expect(text("models threshold fraud-scorer 0.9")).toContain("threshold 0.85 → 0.9");
    for (const bad of ["abc", "1.5", "0", "1", "-0.2"]) {
      expect(run(`models threshold fraud-scorer ${bad}`).cluster, bad).toBeUndefined();
      expect(text(`models threshold fraud-scorer ${bad}`), bad).toContain("between 0 and 1");
    }
  });

  it("switches between enforce and fail-open", () => {
    expect(fraudAfter("models mode fraud-scorer fail-open")?.mode).toBe("fail-open");
    expect(text("models mode fraud-scorer fail-open")).toContain("enforce → fail-open");
    expect(text("models mode fraud-scorer enforce")).toContain("already in enforce mode");
    expect(text("models mode fraud-scorer off")).toContain('unknown mode "off"');
  });

  it("completes subcommands, the model, modes and versions", () => {
    const complete = (line: string) => completeLine(line, { cluster: opened.cluster, scenario, history: [], role: "data" });
    expect(complete("mod").line).toBe("models ");
    expect(complete("models sh").line).toBe("models show ");
    expect(complete("models show f").line).toBe("models show fraud-scorer ");
    expect(complete("models mode fraud-scorer f").line).toBe("models mode fraud-scorer fail-open ");
    expect(complete("models rollback fraud-scorer --to v1").candidates).toEqual(["v11", "v12"]);
  });

  it("turns away other roles the way the platform's SSO does, and changes nothing", () => {
    for (const role of ["infrastructure", "frontend", "mobile", "security"] as const) {
      expect(text("models list", role)).toBe(
        `models: 403 Forbidden: oncall-${role}@marlow.example is not in ml-platform\nmodels: your groups: ${SSO_GROUPS[role].join(", ")} — ask in #access-requests`,
      );
      expect(run("models mode fraud-scorer fail-open", role).cluster).toBeUndefined();
    }
  });

  it("isn't installed where no model serves checkout", () => {
    const meltdown = { cluster: openIncident(checkoutMeltdown).cluster, scenario: checkoutMeltdown, history: [], role: "data" as const };
    expect(runLine("models list", meltdown).output[0].text).toBe("bash: models: command not found");
    expect(runLine("help", meltdown).output.map((line) => line.text).join("\n")).not.toContain("models");
    expect(text("help")).toContain("models");
  });
});

describe("the pipelines command", () => {
  const DAG = "features_customer_daily";
  const failedRun = [
    { t: -6 * HOUR, source: DAG, level: "INFO" as const, text: airflowLine(8 * HOUR, -6 * HOUR, "taskinstance.py:2867", "INFO", "Starting attempt 3 of 3") },
    { t: -6 * HOUR, source: DAG, level: "ERROR" as const, text: airflowLine(8 * HOUR, -6 * HOUR, "taskinstance.py:3313", "ERROR", "Task failed with exception") },
  ];
  const commerce = withFraud({
    features: [
      { name: "customer_orders_90d", pipeline: DAG, lastSuccessAt: -30 * HOUR, refresh: null },
      { name: "customer_refunds_90d", pipeline: DAG, lastSuccessAt: -25 * HOUR, refresh: null },
      { name: "device_accounts_30d", pipeline: "features_device_daily", lastSuccessAt: -5 * HOUR, refresh: null },
    ],
  });
  const base = shop(commerce);
  const scenario: Scenario = { ...base, opensAtSecondOfDay: 8 * HOUR, initialState: () => ({ ...base.initialState(), logs: { [DAG]: failedRun } }) };
  const opened = openIncident(scenario);
  const run = (line: string, incident: Incident = opened, role: Role = "data") => runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  const text = (line: string, incident: Incident = opened, role: Role = "data") =>
    run(line, incident, role)
      .output.map((output) => output.text)
      .join("\n");
  const apply = (line: string, incident: Incident) => ({ ...incident, cluster: run(line, incident).cluster ?? incident.cluster });

  it("stamps lines the way Airflow 2.10's task log formatter does", () => {
    expect(airflowLine(8 * HOUR, 0, "taskinstance.py:3313", "ERROR", "Task failed with exception")).toBe(
      "[2026-10-10T08:00:00.000+0000] {taskinstance.py:3313} ERROR - Task failed with exception",
    );
    expect(airflowLine(2 * HOUR, -3 * HOUR, "x.py:1", "INFO", "m")).toBe("[2026-10-09T23:00:00.400+0000] {x.py:1} INFO - m");
    expect(airflowCompact(2 * HOUR, 14 * 60 + 7)).toBe("20261010T021407");
  });

  it("lists each DAG behind the features with its state", () => {
    expect(text("pipelines list")).toMatch(new RegExp(`${DAG}\\s+customer_orders_90d, customer_refunds_90d\\s+25h ago\\s+failed`));
    expect(text("pipelines list")).toMatch(/features_device_daily\s+device_accounts_30d\s+03:00:00\s+success/);
  });

  it("prints a failed run's kept task log, and says when there's nothing to see", () => {
    expect(text(`pipelines logs ${DAG}`)).toContain("{taskinstance.py:3313} ERROR - Task failed with exception");
    expect(run(`pipelines logs ${DAG}`).output.find((line) => line.text.includes("Task failed"))?.tone).toBe("err");
    expect(text("pipelines logs features_device_daily")).toContain("last scheduled run succeeded");
    expect(text("pipelines logs nope")).toContain('DAG "nope" not found');
  });

  it("runs a DAG: its features refresh for a minute, then go fresh and stop costing declines", () => {
    const triggered = apply(`pipelines run ${DAG}`, opened);
    expect(text(`pipelines run ${DAG}`)).toMatch(new RegExp(`Triggered ${DAG}: manual__2026-10-10T08:00:00\\.\\d{6}\\+00:00 by oncall-data \\(2 tasks\\)`));
    expect(text(`pipelines run ${DAG}`, triggered)).toContain("already has a run in progress");
    expect(text("pipelines run nope")).toContain('DAG "nope" not found');

    const midway = play(scenario, 30, triggered);
    expect(text("pipelines list", midway)).toMatch(new RegExp(`${DAG}.*running`));
    expect(text("models features fraud-scorer", midway)).toContain("refreshing (30 s left)");
    expect(text(`pipelines logs ${DAG}`, midway)).toMatch(/Running <TaskInstance: features_customer_daily\.build_customer_orders_90d manual__\S+ \[running\]> on host /);
    expect(customerLossRate(commerceOf(midway), midway.cluster.t)).toBeCloseTo(0.104, 9);

    const done = play(scenario, 30, midway);
    expect(text("pipelines list", done)).toMatch(new RegExp(`${DAG}.*success`));
    expect(customerLossRate(commerceOf(done), done.cluster.t)).toBeCloseTo(0.004, 9);
    const log = text(`pipelines logs ${DAG}`, done);
    expect(log).toMatch(/Marking task as SUCCESS\. dag_id=features_customer_daily, task_id=build_customer_refunds_90d, run_id=manual__\S+, execution_date=20261010T080000, start_date=20261010T080002, end_date=20261010T080100/);
    expect(log).toContain("{local_task_job_runner.py:266} INFO - Task exited with return code 0");
  });

  it("completes subcommands and DAGs", () => {
    const complete = (line: string) => completeLine(line, { cluster: opened.cluster, scenario, history: [], role: "data" });
    expect(complete("pip").line).toBe("pipelines ");
    expect(complete("pipelines logs features_c").line).toBe(`pipelines logs ${DAG} `);
  });

  it("turns away other roles at the data-eng group", () => {
    expect(text("pipelines list", opened, "infrastructure")).toContain("pipelines: 403 Forbidden: oncall-infrastructure@marlow.example is not in data-eng");
    expect(run(`pipelines run ${DAG}`, opened, "security").cluster).toBeUndefined();
  });
});

describe("tier 1: refund last night's double charges", () => {
  const scenario = refundDoubleCharges;
  const dataObjective = (incident: Incident) => scenario.objectives?.(incident.cluster).find((objective) => objective.role === "data");

  it("opens with the storm's orphaned charges all visible, and pending refunds keep rising if nobody acts", () => {
    const opened = openIncident(scenario);
    const atPage = pendingRefunds(commerceOf(opened));
    expect(atPage).toBeGreaterThan(5000);
    expect(visibleOrphans(commerceOf(opened))).toBe(Math.floor(commerceOf(opened).ledger.orphanedCaptures));
    expect(alertRate(scenario, opened.cluster)).toBeGreaterThan(0.01);
    expect(opened.cluster.errorRate).toBeLessThan(0.01);

    const tenMinutes = playTo(scenario, 600, opened);
    expect(pendingRefunds(commerceOf(tenMinutes))).toBeGreaterThan(atPage + 60);
    expect(alertRate(scenario, tenMinutes.cluster)).toBeGreaterThan(alertRate(scenario, opened.cluster));
    expect(dataObjective(playTo(scenario, SETTLEMENT_CUTOFF + 1, tenMinutes))?.isMet).toBe(false);
  });

  it("refuses to resolve before a refund batch is submitted", () => {
    const early = playTo(scenario, 60, openIncident(scenario));
    expect(declareResolved(early, scenario).notice).toEqual({ kind: "refused", rate: expect.any(Number), label: "charges to refund, vs 15 min of checkouts" });
    const previewed = shellOn(scenario, early, "reconcile preview");
    expect(previewed.changed).toBe(false);
    expect(declareResolved(previewed.incident, scenario).notice?.kind).toBe("refused");
  });

  it("closes at S or A with the worked solution, the batch queued before the cut-off", () => {
    const { result } = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("tells data the gateway is still trickling orphans in, and a later batch sweeps them up", () => {
    const submitted = scripted(scenario, [[30, "reconcile submit"]], 400);
    expect(alertRate(scenario, submitted.cluster)).toBeLessThan(0.01);
    expect(shellOn(scenario, submitted, "reconcile preview").text).toMatch(/Trickling in: about 9 new orphaned captures a minute/);
    const swept = shellOn(scenario, submitted, "reconcile submit").incident;
    expect(pendingRefunds(commerceOf(swept))).toBe(0);
    expect(commerceOf(swept).ledger.refundBatches).toHaveLength(2);
  });

  it("costs the objective, and points, to submit after the settlement cut-off", () => {
    const onTime = scripted(scenario, [[60, "reconcile submit"]], SETTLEMENT_CUTOFF + 300);
    const late = scripted(scenario, [[SETTLEMENT_CUTOFF + 5, "reconcile submit"]], SETTLEMENT_CUTOFF + 300);
    expect(dataObjective(onTime)?.isMet).toBe(true);
    expect(dataObjective(late)?.isMet).toBe(false);
    expect(debrief(late, scenario, true).points).toBeLessThan(debrief(onTime, scenario, true).points - 9);
  });

  it("is deterministic", () => {
    const steps = [[40, "reconcile submit"]] as const;
    expect(scripted(scenario, steps, 300)).toEqual(scripted(scenario, steps, 300));
  });

  it("round-trips through multiplayer frames", () => {
    const server = expectFramesToRoundTrip(scenario, [[50, "reconcile submit"]], 120);
    expect(commerceOf(server).ledger.refundBatches).toHaveLength(1);
  });

  it("offers chips the data laptop can run", () => expectChipsToRun(scenario));
});

describe("tier 2: good customers declined", () => {
  const scenario = fraudModelRegression;
  const loss = (incident: Incident) => alertRate(scenario, incident.cluster);

  it("opens declining 14% of customers without a single 5xx, and loses more of them every minute", () => {
    const opened = openIncident(scenario);
    expect(loss(opened)).toBeCloseTo(0.14, 9);
    expect(opened.cluster.errorRate).toBe(0);
    const twoMinutes = playTo(scenario, 120, opened);
    const tenMinutes = playTo(scenario, 600, twoMinutes);
    expect(tenMinutes.cluster.failedCheckouts).toBeGreaterThan(twoMinutes.cluster.failedCheckouts * 4);
    expect(commerceOf(tenMinutes).ledger.fraudulentCaptures).toBeGreaterThan(commerceOf(twoMinutes).ledger.fraudulentCaptures ?? 0);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(twoMinutes, scenario, true).points);
    expect(declareResolved(tenMinutes, scenario).notice?.kind).toBe("refused");
  });

  it("shows the declined customers are regulars, and the top reason a feature new in v13", () => {
    const opened = openIncident(scenario);
    const view = shellOn(scenario, opened, "warehouse run declined-checkouts").text;
    expect(view).toMatch(/3\+ paid orders\s+\|\s+\d+\s+\|\s+5\d\.\d/);
    expect(view).toContain("v13's score explanations: device_age_days < 1");
    expect(shellOn(scenario, scripted(scenario, [[30, "models rollback fraud-scorer"]], 40), "warehouse run declined-checkouts").text).toContain("v12's score explanations: card_bin_velocity_1h");
  });

  it("closes at S or A with the worked solution", () => {
    const { result } = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("raising the threshold on v13 only halves the damage, and resolve stays refused", () => {
    const raised = scripted(scenario, [[30, "models threshold fraud-scorer 0.95"]], 120);
    expect(loss(raised)).toBeGreaterThan(0.05);
    expect(declareResolved(raised, scenario).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(raised.cluster)).toBe(false);
  });

  it("failing open clears the page but lets every fraud attempt through, and the debrief knows", () => {
    const rolledBack = scripted(scenario, [[30, "models rollback fraud-scorer"]], 300);
    const failedOpen = scripted(scenario, [[30, "models mode fraud-scorer fail-open"]], 300);
    expect(loss(failedOpen)).toBe(0);
    expect(scenario.isRootCauseFixed(failedOpen.cluster)).toBe(false);
    const capturedSince = (incident: Incident) => commerceOf(incident).ledger.fraudulentCaptures ?? 0;
    expect(capturedSince(failedOpen)).toBeGreaterThan(capturedSince(rolledBack) * 5);
    expect(debrief(failedOpen, scenario, true).points).toBeLessThan(debrief(rolledBack, scenario, true).points - 20);
  });

  it("is deterministic", () => {
    const steps = [[45, "models rollback fraud-scorer"]] as const;
    expect(scripted(scenario, steps, 200)).toEqual(scripted(scenario, steps, 200));
  });

  it("round-trips through multiplayer frames", () => {
    const server = expectFramesToRoundTrip(scenario, [[40, "models rollback fraud-scorer"]], 90);
    expect(scorerOf(server.cluster)?.active).toBe("v12");
  });

  it("offers chips the data laptop can run", () => expectChipsToRun(scenario));
});

describe("tier 3: the threshold nobody tuned", () => {
  const scenario = fraudThresholdFailOpen;
  const loss = (incident: Incident) => alertRate(scenario, incident.cluster);
  const captured = (incident: Incident) => commerceOf(incident).ledger.fraudulentCaptures ?? 0;
  const fraudObjective = (incident: Incident) => scenario.objectives?.(incident.cluster)[0];

  it("opens declining a fifth of customers during a live card-testing ring, and loses more of them every minute", () => {
    const opened = openIncident(scenario);
    expect(loss(opened)).toBeGreaterThan(0.19);
    expect(opened.cluster.errorRate).toBe(0);
    expect(captured(opened)).toBe(0);
    const twoMinutes = playTo(scenario, 120, opened);
    const tenMinutes = playTo(scenario, 600, twoMinutes);
    expect(tenMinutes.cluster.failedCheckouts).toBeGreaterThan(twoMinutes.cluster.failedCheckouts * 4);
    expect(captured(tenMinutes)).toBeGreaterThan(captured(twoMinutes));
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(twoMinutes, scenario, true).points);
    expect(declareResolved(tenMinutes, scenario).notice?.kind).toBe("refused");
  });

  it("closes at S or A with the worked solution, the ring's captures under the bound", () => {
    const { closed, result } = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(captured(closed)).toBeLessThan(FRAUD_CAPTURE_BOUND / 2);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("failing open floods the gateway with the ring: 5xx for everyone and fraud captures piling up", () => {
    const failedOpen = scripted(scenario, [[30, "models mode fraud-scorer fail-open"]], 150);
    expect(commerceOf(failedOpen).gateway.timeoutShare).toBe(1);
    expect(failedOpen.cluster.errorRate).toBeGreaterThan(0.3);
    expect(loss(failedOpen)).toBeGreaterThan(0.9);
    expect(captured(failedOpen)).toBeGreaterThan(FRAUD_CAPTURE_BOUND);
    expect(fraudObjective(failedOpen)?.isMet).toBe(false);
    expect(declareResolved(failedOpen, scenario).notice?.kind).toBe("refused");

    const fixed = scripted(scenario, [[30, "models threshold fraud-scorer 0.85"]], 150);
    expect(debrief(failedOpen, scenario, true).points).toBeLessThan(debrief(fixed, scenario, true).points - 30);
  });

  it("counts a threshold a little above the tuned one as fixed, but not one that waves the ring through", () => {
    const nearlyTuned = scripted(scenario, [[30, "models threshold fraud-scorer 0.9"]], 60);
    expect(scenario.isRootCauseFixed(nearlyTuned.cluster)).toBe(true);
    expect(loss(nearlyTuned)).toBeLessThan(0.01);
    expect(scenario.isRootCauseFixed(scripted(scenario, [[30, "models threshold fraud-scorer 0.97"]], 60).cluster)).toBe(false);
  });

  it("rolling back the model does nothing: the threshold is serving config, not part of a version", () => {
    const rolledBack = shellOn(scenario, playTo(scenario, 30, openIncident(scenario)), "models rollback fraud-scorer");
    expect(rolledBack.changed).toBe(true);
    expect(scorerOf(rolledBack.incident.cluster)?.active).toBe("v11");
    const later = playTo(scenario, 150, rolledBack.incident);
    expect(loss(later)).toBeGreaterThan(0.19);
    expect(declareResolved(later, scenario).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(later.cluster)).toBe(false);
  });

  it("shows the declines sit between the new threshold and the tuned one", () => {
    const view = shellOn(scenario, openIncident(scenario), "warehouse run declined-checkouts").text;
    expect(view).toMatch(/0\.35-0\.85\s+\|\s+\d{4,}/);
    expect(shellOn(scenario, scripted(scenario, [[30, "models threshold fraud-scorer 0.85"]], 40), "warehouse run declined-checkouts").text).not.toContain("0.35-0.85");
  });

  it("is deterministic", () => {
    const steps = [[45, "models threshold fraud-scorer 0.85"]] as const;
    expect(scripted(scenario, steps, 200)).toEqual(scripted(scenario, steps, 200));
  });

  it("round-trips through multiplayer frames", () => {
    const server = expectFramesToRoundTrip(
      scenario,
      [
        [30, "models mode fraud-scorer fail-open"],
        [60, "models mode fraud-scorer enforce"],
        [70, "models threshold fraud-scorer 0.85"],
      ],
      120,
    );
    expect(scorerOf(server.cluster)?.threshold).toBe(0.85);
  });

  it("offers chips the data laptop can run", () => expectChipsToRun(scenario));
});

describe("tier 4: every model declines them", () => {
  const scenario = staleFraudFeatures;
  const loss = (incident: Incident) => alertRate(scenario, incident.cluster);
  const refresh = `pipelines run ${FEATURE_DAG}`;

  it("opens with a stale feature declining regulars, and declines double as the DAG's next feature goes stale", () => {
    const opened = openIncident(scenario);
    expect(loss(opened)).toBeCloseTo(0.115, 9);
    expect(opened.cluster.errorRate).toBe(0);
    const twoMinutes = playTo(scenario, 120, opened);
    const tenMinutes = playTo(scenario, 600, twoMinutes);
    expect(loss(twoMinutes)).toBeCloseTo(0.115, 9);
    expect(loss(tenMinutes)).toBeCloseTo(0.225, 9);
    expect(tenMinutes.cluster.failedCheckouts).toBeGreaterThan(twoMinutes.cluster.failedCheckouts * 6);
    expect(debrief(tenMinutes, scenario, true).points).toBeLessThan(debrief(twoMinutes, scenario, true).points);
  });

  it("keeps last night's failed task log, verbatim from Airflow and Postgres", () => {
    const log = shellOn(scenario, openIncident(scenario), `pipelines logs ${FEATURE_DAG}`).text.split("\n");
    expect(log).toContain("[2026-10-10T02:10:10.570+0000] {taskinstance.py:3313} ERROR - Task failed with exception");
    expect(log).toContain("psycopg2.errors.UndefinedColumn: column o.placed_at does not exist");
    const line = log.findIndex((text) => text.startsWith("LINE 5: "));
    expect(log[line]).toBe("LINE 5:   and o.placed_at >= current_date - 90");
    expect(log[line + 1].indexOf("^")).toBe(log[line].indexOf("o.placed_at"));
    expect(log).toContain('HINT:  Perhaps you meant to reference the column "o.updated_at".');
    expect(log.some((text) => text.endsWith("{taskinstance.py:1226} INFO - Marking task as FAILED. dag_id=features_customer_daily, task_id=build_customer_orders_90d, run_id=scheduled__2026-10-09T02:00:00+00:00, execution_date=20261009T020000, start_date=20261010T021007, end_date=20261010T021010"))).toBe(true);
  });

  it("shows declined regulars were scored on zero recent orders until the features refresh", () => {
    expect(shellOn(scenario, openIncident(scenario), "warehouse run declined-checkouts").text).toMatch(/3\+ paid orders\s+\|\s+\d+\s+\|\s+0\s+\|\s+7/);
    const refreshed = scripted(scenario, [[30, refresh]], 100);
    expect(shellOn(scenario, refreshed, "warehouse run declined-checkouts").text).toMatch(/3\+ paid orders\s+\|\s+\d+\s+\|\s+7\s+\|\s+7/);
  });

  it("closes at S or A with the worked solution", () => {
    const { result } = workedSolution(scenario);
    expect(result.isRootCauseFixed).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("rolling back does nothing: every version reads the stale feature", () => {
    const rolledBack = shellOn(scenario, playTo(scenario, 30, openIncident(scenario)), "models rollback fraud-scorer");
    expect(rolledBack.changed).toBe(true);
    expect(scorerOf(rolledBack.incident.cluster)?.active).toBe("v13");
    const later = playTo(scenario, 150, rolledBack.incident);
    expect(loss(later)).toBeCloseTo(0.115, 9);
    expect(declareResolved(later, scenario).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(later.cluster)).toBe(false);
  });

  it("failing open floods the gateway with the card-testing bots", () => {
    const failedOpen = scripted(scenario, [[30, "models mode fraud-scorer fail-open"]], 150);
    const fixed = scripted(scenario, [[30, refresh]], 150);
    expect(commerceOf(failedOpen).gateway.timeoutShare).toBe(1);
    expect(failedOpen.cluster.errorRate).toBeGreaterThan(0.3);
    expect(loss(failedOpen)).toBeGreaterThan(0.9);
    expect(commerceOf(failedOpen).ledger.fraudulentCaptures).toBeGreaterThan((commerceOf(fixed).ledger.fraudulentCaptures ?? 0) * 10);
    expect(declareResolved(failedOpen, scenario).notice?.kind).toBe("refused");
    expect(debrief(failedOpen, scenario, true).points).toBeLessThan(debrief(fixed, scenario, true).points - 30);
  });

  it("is deterministic", () => {
    const steps = [[45, refresh]] as const;
    expect(scripted(scenario, steps, 200)).toEqual(scripted(scenario, steps, 200));
  });

  it("round-trips through multiplayer frames while a refresh runs and lands", () => {
    const server = expectFramesToRoundTrip(scenario, [[40, refresh]], 120);
    expect(scorerOf(server.cluster)?.features.every((feature) => feature.refresh === null)).toBe(true);
    expect(scenario.isRootCauseFixed(server.cluster)).toBe(true);
  });

  it("offers chips the data laptop can run", () => expectChipsToRun(scenario));
});

describe("the data ladder", () => {
  const ladder = [refundDoubleCharges, fraudModelRegression, fraudThresholdFailOpen, staleFraudFeatures];

  it("climbs one tier per career level, and adds the cross-team incident at Staff", () => {
    expect(ladder.map((scenario) => scenario.tier)).toEqual([1, 2, 3, 4]);
    for (const level of [0, 1, 2, 3] as const) expect(unlockedWarRooms("data", level)).toEqual(ladder.slice(0, level + 1).toReversed());
    expect(unlockedWarRooms("data", 4)).toEqual([checkoutMeltdown, ...ladder.toReversed()]);
    for (const scenario of ladder) expect(SCENARIOS).toContain(scenario);
  });

  it.each(ladder.map((scenario) => [scenario.id, scenario] as const))("%s pages data alone, with a postmortem whose answer length gives nothing away", (_id, scenario) => {
    expect(scenario.roles).toEqual(["data"]);
    expect(scenario.releasedAt).toBeUndefined();
    expect(scenario.teamPlaybook).toBeUndefined();
    const { options, answerIndex } = scenario.postmortem;
    expect(options).toHaveLength(4);
    const longestOther = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length - longestOther).toBeLessThanOrEqual(4);
  });
});
