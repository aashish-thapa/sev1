import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident, type IncidentNotice } from "./incident.ts";
import { ordersIndexInvalid as scenario } from "./scenarios/orders-index-invalid.ts";
import { soloScenarioFor, unlockedWarRooms } from "./scenarios/index.ts";
import { runLine } from "./shell/shell.ts";
import { rolloutRestart, rolloutUndo, scale, type ActionResult } from "./sim/actions.ts";

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

function psql(incident: Incident, sql: string) {
  const result = runLine(`psql -c "${sql}"`, { cluster: incident.cluster, scenario, history: [], role: "infrastructure" });
  return { text: result.output.map((line) => line.text).join("\n"), incident: result.cluster ? { ...incident, cluster: result.cluster } : incident };
}

describe("orders index left invalid by a migration", () => {
  it("opens slow but mostly working, and gets worse as seq scans evict the cache", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.01);
    expect(opened.cluster.errorRate).toBeLessThan(0.2);
    const fourMinutes = play(240, opened).incident;
    expect(fourMinutes.cluster.errorRate).toBeGreaterThan(0.6);
  });

  it("is fixed by REINDEX CONCURRENTLY and closes cleanly", () => {
    let incident = play(60, openIncident(scenario)).incident;
    incident = psql(incident, `REINDEX INDEX CONCURRENTLY ${scenario.initialState().database.hotIndex?.name}`).incident;
    incident = play(60, incident).incident;
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);
    expect(incident.cluster.errorRate).toBeLessThan(0.01);

    const declared = declareResolved(incident, scenario);
    expect(declared.notice).toBeUndefined();
    const { incident: closed, notices } = play(700, declared.incident);
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);
    expect(["S", "A"]).toContain(debrief(closed, scenario, true).grade);
  });

  it("doesn't recover when the deploy is rolled back: the schema stays broken", () => {
    let incident = play(30, openIncident(scenario)).incident;
    incident = apply(incident, rolloutUndo(incident.cluster, "checkout-api"));
    incident = play(120, incident).incident;
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.05);
  });

  it("doesn't recover on a restart either", () => {
    let incident = play(30, openIncident(scenario)).incident;
    incident = apply(incident, rolloutRestart(incident.cluster, "checkout-api"));
    incident = play(120, incident).incident;
    expect(incident.cluster.errorRate).toBeGreaterThan(0.05);
  });

  it("costs far more checkouts when the index is rebuilt with a plain, table-locking REINDEX", () => {
    const opened = play(30, openIncident(scenario)).incident;
    const name = opened.cluster.database.hotIndex?.name ?? "";
    const concurrent = play(90, psql(opened, `REINDEX INDEX CONCURRENTLY ${name}`).incident).incident;
    const locking = psql(opened, `REINDEX INDEX ${name}`).incident;
    const duringLock = play(10, locking).incident;
    expect(duringLock.cluster.errorRate).toBeGreaterThan(0.9);
    const afterLock = play(80, duringLock).incident;
    expect(scenario.isRootCauseFixed(afterLock.cluster)).toBe(true);
    expect(afterLock.cluster.failedCheckouts).toBeGreaterThan(concurrent.cluster.failedCheckouts);
  });

  it("crash-loops new pods when scaling past max_connections", () => {
    const opened = openIncident(scenario);
    const incident = play(60, apply(opened, scale(opened.cluster, "checkout-api", 6))).incident;
    expect(incident.cluster.crashLoopsCaused).toBeGreaterThan(0);
  });

  it("shows the evidence in psql: invalid index, seq scan, busy active sessions", () => {
    const opened = openIncident(scenario);
    expect(psql(opened, "\\d orders").text).toMatch(/orders_customer_status_created_idx.*INVALID/);
    expect(psql(opened, `EXPLAIN ${opened.cluster.database.hotIndex?.query}`).text).toContain("Seq Scan on orders");
    const states = psql(opened, "select state, count(*) from pg_stat_activity group by state").text;
    const active = Number(/active\s*\|\s*(\d+)/.exec(states)?.[1]);
    const idle = Number(/idle\s*\|\s*(\d+)/.exec(states)?.[1]);
    expect(active).toBeGreaterThan(idle);
    expect(opened.cluster.logs["migrate-0142"]?.some((line) => line.text.includes("statement timeout"))).toBe(true);
  });

  it("leaves the failed index build in the migration job's logs", () => {
    const opened = openIncident(scenario);
    const shell = (line: string) =>
      runLine(line, { cluster: opened.cluster, scenario, history: [], role: "infrastructure" }).output.map((output) => output.text).join("\n");
    expect(shell("kubectl get jobs")).toMatch(/migrate-0142\s+Complete/);
    expect(shell("kubectl logs job/migrate-0142")).toContain("canceling statement due to statement timeout");
    expect(shell("kubectl logs job/nope")).toContain("NotFound");
  });

  it("round-trips the index and job state through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === 20) next = psql(next, "REINDEX INDEX CONCURRENTLY orders_customer_status_created_idx").incident;
      client = roundTrip(client, next);
      server = next;
    }
    expect(server.cluster.database.hotIndex?.isValid).toBe(true);
    expect(client).toEqual(server);
  });

  it("pages senior SREs first, and stays locked below senior", () => {
    expect(soloScenarioFor("infrastructure", 0, 3).tier).toBe(4);
    expect(unlockedWarRooms("infrastructure", 3)).toContain(scenario);
    expect(unlockedWarRooms("infrastructure", 2)).not.toContain(scenario);
  });
});
