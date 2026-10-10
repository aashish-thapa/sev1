import { describe, expect, it } from "vitest";
import { advance, declareResolved, debrief, openIncident, type Incident, type IncidentNotice } from "./incident.ts";
import { checkoutPoolLeak as scenario } from "./scenarios/checkout-pool-leak.ts";
import { rolloutRestart, rolloutUndo, scale, terminateIdleSessions, type ActionResult } from "./sim/actions.ts";

function play(seconds: number, incident: Incident) {
  const notices: IncidentNotice[] = [];
  let current = incident;
  for (let index = 0; index < seconds; index += 1) {
    const result = advance(current, scenario);
    current = result.incident;
    if (result.notice) notices.push(result.notice);
  }
  return { incident: current, notices };
}

function apply(incident: Incident, result: ActionResult): Incident {
  if (!result.ok) throw new Error(result.output.join("\n"));
  return { ...incident, cluster: result.state };
}

describe("checkout pool leak", () => {
  it("opens already degraded and collapses to a full outage if nobody acts", () => {
    const incident = openIncident(scenario);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.01);
    const fourMinutes = play(240, incident).incident;
    expect(fourMinutes.cluster.errorRate).toBeGreaterThan(0.66);
    const sevenMinutes = play(180, fourMinutes).incident;
    expect(sevenMinutes.cluster.errorRate).toBe(1);
  });

  it("is resolved by rolling back to the previous revision", () => {
    let incident = play(30, openIncident(scenario)).incident;
    incident = apply(incident, rolloutUndo(incident.cluster, "checkout-api"));
    incident = play(120, incident).incident;
    expect(incident.cluster.errorRate).toBeLessThan(0.01);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);

    const declared = declareResolved(incident);
    expect(declared.notice).toBeUndefined();
    const { incident: closed, notices } = play(700, declared.incident);
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);
    expect(["S", "A"]).toContain(debrief(closed, scenario, true).grade);
    expect(debrief(closed, scenario, false).points).toBeLessThan(debrief(closed, scenario, true).points);
  });

  it("reopens when the player only restarts", () => {
    let incident = play(30, openIncident(scenario)).incident;
    incident = apply(incident, rolloutRestart(incident.cluster, "checkout-api"));
    incident = play(120, incident).incident;
    expect(incident.cluster.errorRate).toBeLessThan(0.01);
    const declared = declareResolved(incident);
    const { notices } = play(700, declared.incident);
    expect(notices[0]?.kind).toBe("reopened");
  });

  it("crash-loops new pods when scaling past max_connections", () => {
    const opened = openIncident(scenario);
    let incident = apply(opened, scale(opened.cluster, "checkout-api", 6));
    incident = play(60, incident).incident;
    expect(incident.cluster.crashLoopsCaused).toBeGreaterThan(0);
    expect(incident.cluster.logs["orders-db"]?.some((line) => line.text.includes("too many clients"))).toBe(true);
  });

  it("terminating idle sessions does not refill the starved pool", () => {
    const opened = openIncident(scenario);
    const before = opened.cluster.deployments[0].pods.map((pod) => pod.leaked);
    const incident = apply(opened, terminateIdleSessions(opened.cluster));
    expect(incident.cluster.deployments[0].pods.map((pod) => pod.leaked)).toEqual(before);
  });
});

describe("bastion shell", () => {
  const context = () => ({ cluster: openIncident(scenario).cluster, scenario, history: [], role: "infrastructure" as const });

  it("tokenizes quoted SQL and reports unterminated quotes", async () => {
    const { tokenize } = await import("./shell/tokenize.ts");
    expect(tokenize(`psql -c "select 1"`).tokens).toEqual(["psql", "-c", "select 1"]);
    expect(tokenize(`psql -c "select`).error).toBeDefined();
  });

  it("completes commands, subcommands and pod names", async () => {
    const { completeLine } = await import("./shell/shell.ts");
    expect(completeLine("kub", context()).line).toBe("kubectl ");
    expect(completeLine("kubectl rollout un", context()).line).toBe("kubectl rollout undo ");
    expect(completeLine("kubectl logs ", context()).candidates.length).toBeGreaterThan(1);
  });

  it("shows a healthy shallow probe while the deep health check is down", async () => {
    const { runLine } = await import("./shell/shell.ts");
    expect(runLine("curl -s http://checkout-api:8080/healthz", context()).output[0].text).toBe('{"status":"UP"}');
    expect(runLine("curl -s http://checkout-api:8080/actuator/health", context()).output[0].text).toContain('"status":"DOWN"');
  });

  it("changes the cluster only through operator commands", async () => {
    const { runLine } = await import("./shell/shell.ts");
    expect(runLine("kubectl get pods", context()).cluster).toBeUndefined();
    expect(runLine("kubectl rollout undo deployment/checkout-api", context()).cluster).toBeDefined();
    expect(runLine("rm -rf /", context()).output[0]).toEqual({ text: "bash: rm: command not found", tone: "err" });
  });
});
