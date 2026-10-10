import { describe, expect, it } from "vitest";
import { advance, debrief, declareResolved, openIncident, type Incident, type IncidentNotice } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { crashOnCheckout } from "./scenarios/crash-on-checkout.ts";
import { SCENARIOS, soloScenarioFor, unlockedWarRooms } from "./scenarios/index.ts";
import { oomAfterDeploy } from "./scenarios/oom-after-deploy.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";

function play(scenario: Scenario, seconds: number, incident: Incident) {
  const notices: IncidentNotice[] = [];
  let current = incident;
  for (let index = 0; index < seconds; index += 1) {
    const result = advance(current, scenario);
    current = result.incident;
    if (result.notice) notices.push(result.notice);
  }
  return { incident: current, notices };
}

function shell(scenario: Scenario, incident: Incident, line: string) {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  return { text: result.output.map((output) => output.text).join("\n"), incident: result.cluster ? { ...incident, cluster: result.cluster } : incident };
}

/** Plays `fix` 40 s into the page and reports how the incident ends. */
function resolveWith(scenario: Scenario, fix: string) {
  let incident = play(scenario, 40, openIncident(scenario)).incident;
  incident = shell(scenario, incident, fix).incident;
  incident = play(scenario, 120, incident).incident;
  const declared = declareResolved(incident);
  const { incident: closed, notices } = play(scenario, 700, declared.incident);
  return { before: incident, refused: declared.notice, closed, notices };
}

describe("intern: checkout scaled to zero", () => {
  it("opens as a full outage with no pods and the scale-down in the events", () => {
    const opened = openIncident(scaledToZero);
    expect(opened.cluster.errorRate).toBe(1);
    expect(shell(scaledToZero, opened, "kubectl get pods").text).toContain("No resources found");
    expect(shell(scaledToZero, opened, "kubectl get events").text).toContain("to 0 from 3");
  });

  it("is fixed by scaling back to three and grades well", () => {
    const { refused, notices, closed } = resolveWith(scaledToZero, "kubectl scale deployment/checkout-api --replicas=3");
    expect(refused).toBeUndefined();
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);
    expect(["S", "A"]).toContain(debrief(closed, scaledToZero, true).grade);
  });

  it("doesn't come back from a rollback or a restart", () => {
    expect(resolveWith(scaledToZero, "kubectl rollout undo deployment/checkout-api").before.cluster.errorRate).toBe(1);
    expect(resolveWith(scaledToZero, "kubectl rollout restart deployment/checkout-api").before.cluster.errorRate).toBe(1);
  });
});

describe("intern: a deploy that crashes on the first checkout", () => {
  it("opens crash-looping, and the logs name the missing property", () => {
    const opened = openIncident(crashOnCheckout);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.5);
    const pods = shell(crashOnCheckout, opened, "kubectl get pods").text;
    expect(pods).toContain("CrashLoopBackOff");
    const podName = opened.cluster.deployments[0].pods[0].name;
    expect(shell(crashOnCheckout, opened, `kubectl logs ${podName}`).text).toContain("payments.default-currency");
  });

  it("is fixed by rolling back", () => {
    const { refused, notices, closed } = resolveWith(crashOnCheckout, "kubectl rollout undo deployment/checkout-api");
    expect(refused).toBeUndefined();
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);
    expect(["S", "A"]).toContain(debrief(closed, crashOnCheckout, true).grade);
  });

  it("keeps crashing after a restart", () => {
    expect(resolveWith(crashOnCheckout, "kubectl rollout restart deployment/checkout-api").before.cluster.errorRate).toBeGreaterThan(0.3);
  });
});

describe("junior: OOMKilled after a deploy", () => {
  it("flaps instead of failing outright, and describe shows OOMKilled", () => {
    const rates: number[] = [];
    let incident = openIncident(oomAfterDeploy);
    for (let second = 0; second < 240; second += 1) {
      incident = advance(incident, oomAfterDeploy).incident;
      rates.push(incident.cluster.errorRate);
    }
    expect(Math.max(...rates)).toBeGreaterThan(0.3);
    expect(Math.min(...rates)).toBeLessThan(0.05);
    const crashed = incident.cluster.deployments[0].pods.find((pod) => pod.lastTermination);
    expect(crashed).toBeDefined();
    expect(shell(oomAfterDeploy, incident, `kubectl describe pod ${crashed?.name}`).text).toMatch(/OOMKilled[\s\S]*Exit Code:\s+137/);
  });

  it("is fixed by rolling back, and only for a while by restarting", () => {
    const rolledBack = resolveWith(oomAfterDeploy, "kubectl rollout undo deployment/checkout-api");
    expect(rolledBack.notices.map((notice) => notice.kind)).toEqual(["closed"]);
    expect(oomAfterDeploy.isRootCauseFixed(rolledBack.closed.cluster)).toBe(true);
    expect(oomAfterDeploy.isRootCauseFixed(resolveWith(oomAfterDeploy, "kubectl rollout restart deployment/checkout-api").closed.cluster)).toBe(false);
  });
});

describe("the War Room ladder", () => {
  it("gives every scenario a unique id and a tier", () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) expect(scenario.tier).toBeGreaterThanOrEqual(1);
  });

  it("only pages an intern SRE with tier-1 incidents", () => {
    const paged = [0, 1, 2, 3].map((rotation) => soloScenarioFor("infrastructure", rotation, 0));
    expect(paged.every((scenario) => scenario.tier === 1)).toBe(true);
    expect(new Set(paged.map((scenario) => scenario.id)).size).toBe(2);
  });

  it("opens harder incidents with each promotion, hardest first", () => {
    const counts = ([0, 1, 2, 3, 4] as const).map((level) => unlockedWarRooms("infrastructure", level).length);
    expect(counts).toEqual([...counts].sort((left, right) => left - right));
    expect(unlockedWarRooms("infrastructure", 4)[0].tier).toBeGreaterThan(unlockedWarRooms("infrastructure", 4).at(-1)?.tier ?? 0);
  });

  it("keeps the cross-team incident for roles without their own ladder yet", () => {
    expect(soloScenarioFor("frontend", 0, 0).id).toBe("checkout-meltdown");
  });
});
