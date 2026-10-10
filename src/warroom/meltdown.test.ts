import { describe, expect, it } from "vitest";
import type { Role } from "../domain/incident.ts";
import { advance, debrief, declareResolved, openIncident, type Incident, type IncidentNotice } from "./incident.ts";
import { checkoutMeltdown as scenario, STUFFING_ALERT } from "./scenarios/checkout-meltdown.ts";
import { checkoutPoolLeak } from "./scenarios/checkout-pool-leak.ts";
import { completeLine, runLine } from "./shell/shell.ts";
import { unsafeRetryShare } from "./sim/clients.ts";
import { blockedShare } from "./sim/edge.ts";
import type { Commerce } from "./sim/commerce.ts";

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

function playTo(t: number, incident: Incident): Incident {
  return play(Math.max(0, t - incident.cluster.t), incident).incident;
}

/** Runs a command on `role`'s laptop and applies whatever it changed. */
function as(role: Role, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role });
  const errors = result.output.filter((output) => output.tone === "err");
  if (!result.cluster) throw new Error(`${role}$ ${line} changed nothing:\n${result.output.map((output) => output.text).join("\n")}`);
  if (errors.length > 0 && !line.startsWith("reconcile")) throw new Error(errors.map((output) => output.text).join("\n"));
  return { ...incident, cluster: result.cluster };
}

function text(role: Role, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role })
    .output.map((output) => output.text)
    .join("\n");
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("meltdown has no commerce state");
  return commerce;
}

const rollback = (incident: Incident) => as("infrastructure", "kubectl rollout undo deployment/checkout-api", incident);
const webRetriesOff = (incident: Incident) => as("frontend", 'flags set checkout.auto_retry off --note "retry storm"', incident);
const iosBackoff = (incident: Incident) => as("mobile", "remote-config set checkout_retry_policy backoff", incident);
const triageBenign = (incident: Incident) =>
  as("security", `siem resolve ${STUFFING_ALERT} --disposition benign --note "customers retrying: old sessions, normal logins"`, incident);

/** Every role does its job in the first two minutes after the page. */
function teamPlay(): Incident {
  let incident = openIncident(scenario);
  incident = rollback(playTo(30, incident));
  incident = webRetriesOff(playTo(45, incident));
  incident = iosBackoff(playTo(60, incident));
  incident = triageBenign(playTo(75, incident));
  return incident;
}

describe("checkout meltdown", () => {
  it("opens mid retry storm and collapses to a full outage if nobody acts", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.4);
    expect(commerceOf(opened).pulse.checkoutFailureRate).toBeGreaterThan(0.95);
    expect(commerceOf(opened).ledger.orphanedCaptures).toBeGreaterThan(1000);

    const sevenMinutes = playTo(420, opened);
    expect(sevenMinutes.cluster.errorRate).toBe(1);
    expect(sevenMinutes.cluster.failedCheckouts).toBeGreaterThan(20_000);
    expect(commerceOf(sevenMinutes).ledger.orphanedCaptures).toBeGreaterThan(commerceOf(opened).ledger.orphanedCaptures * 2);
  });

  it("rollback alone fixes the pool, but the client retry storm keeps checkout down", () => {
    let incident = rollback(playTo(30, openIncident(scenario)));
    incident = playTo(330, incident);
    expect(incident.cluster.deployments[0].pods.every((pod) => pod.leaked === 0)).toBe(true);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.4);
    expect(commerceOf(incident).gateway.timeoutShare).toBe(1);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
    expect(declareResolved(incident).notice?.kind).toBe("refused");
  });

  it("stopping the client retries without a rollback leaves pods stranded on the leaking build", () => {
    let incident = webRetriesOff(playTo(30, openIncident(scenario)));
    incident = iosBackoff(incident);
    incident = playTo(600, incident);
    expect(unsafeRetryShare(commerceOf(incident), incident.cluster.t)).toBe(0);
    expect(commerceOf(incident).gateway.timeoutShare).toBe(0);
    expect(incident.cluster.deployments[0].pods.some((pod) => pod.leaked >= 20)).toBe(true);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.3);
    expect(declareResolved(incident).notice?.kind).toBe("refused");
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(false);
  });

  it("closes cleanly when every role plays its part, and data refunds once the storm is over", () => {
    let incident = playTo(420, teamPlay());
    expect(incident.cluster.errorRate).toBeLessThan(0.01);
    expect(scenario.isRootCauseFixed(incident.cluster)).toBe(true);

    expect(text("data", "reconcile preview", incident)).toContain("No new orphaned captures");
    incident = as("data", "reconcile submit", incident);
    const declared = declareResolved(incident);
    expect(declared.notice).toBeUndefined();
    const { incident: closed, notices } = play(700, declared.incident);
    expect(notices.map((notice) => notice.kind)).toEqual(["closed"]);

    const result = debrief(closed, scenario, true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("is deterministic", () => {
    const left = playTo(200, teamPlay());
    const right = playTo(200, teamPlay());
    expect(left.cluster).toEqual(right.cluster);
  });

  // Exact to the last bit: rejection and decline shares this scenario never sets must not move the storm.
  it("plays out the same storm whatever share seams other scenarios use", () => {
    const correct = playTo(900, teamPlay());
    expect(correct.cluster.failedCheckouts).toBe(18454.943714687633);
    expect(commerceOf(correct).ledger.orphanedCaptures).toBe(39042.050289087696);
    expect(commerceOf(correct).ledger.paidOrders).toBe(50334.856835737286);
  });

  it("blocking the top talkers looks good on the 5xx graph but turns customers away", () => {
    const correct = playTo(900, teamPlay());

    let incident = openIncident(scenario);
    incident = rollback(playTo(30, incident));
    incident = webRetriesOff(playTo(45, incident));
    incident = iosBackoff(playTo(60, incident));
    incident = as("security", "waf block --top 500", playTo(75, incident));
    const blocked = playTo(900, incident);

    expect(blocked.cluster.errorRate).toBeLessThan(0.01);
    expect(blockedShare(commerceOf(blocked).wafRules)).toBeGreaterThan(0.3);
    expect(blocked.cluster.failedCheckouts).toBeGreaterThan(correct.cluster.failedCheckouts * 1.3);
    const security = debrief(blocked, scenario, true).objectives?.find((objective) => objective.role === "security");
    expect(security?.isMet).toBe(false);
    expect(debrief(blocked, scenario, true).points).toBeLessThan(debrief(correct, scenario, true).points);
  });

  it("calling the alert a true positive runs the SOAR block, and an untriaged alert gets blocked anyway", () => {
    let incident = as("security", `siem resolve ${STUFFING_ALERT} --disposition true-positive`, playTo(20, openIncident(scenario)));
    expect(blockedShare(commerceOf(incident).wafRules)).toBeGreaterThan(0.3);

    incident = playTo(399, openIncident(scenario));
    expect(blockedShare(commerceOf(incident).wafRules)).toBe(0);
    incident = playTo(401, incident);
    expect(blockedShare(commerceOf(incident).wafRules)).toBeGreaterThan(0.3);
    expect(incident.cluster.logs.waf?.at(-1)?.text).toContain("soar:playbook/auto-contain");
  });

  it("halting the iOS phased release doesn't change the apps already installed", () => {
    let incident = openIncident(scenario);
    incident = rollback(playTo(30, incident));
    incident = webRetriesOff(playTo(45, incident));
    incident = as("mobile", "releases halt ios 7.3.0", playTo(60, incident));
    incident = triageBenign(playTo(75, incident));
    const adoption = commerceOf(incident).platforms.find((platform) => platform.id === "ios")?.adoption;

    incident = playTo(390, incident);
    expect(incident.cluster.errorRate).toBeGreaterThan(0.2);
    expect(commerceOf(incident).platforms.find((platform) => platform.id === "ios")?.adoption).toBe(adoption);
    expect(unsafeRetryShare(commerceOf(incident), incident.cluster.t)).toBeGreaterThan(0.15);
    expect(text("mobile", "releases rollback ios 7.3.0", incident)).toContain("no rollback");

    incident = playTo(750, iosBackoff(incident));
    expect(incident.cluster.errorRate).toBeLessThan(0.01);
  });

  it("a refund batch taken mid-storm misses the charges captured after it", () => {
    let incident = as("data", "reconcile submit", playTo(90, teamPlay()));
    expect(text("data", "reconcile status", incident)).toContain("rb_001");
    incident = playTo(500, incident);
    const data = () => debrief(incident, scenario, true).objectives?.find((objective) => objective.role === "data");
    expect(data()?.isMet).toBe(false);

    incident = as("data", "reconcile submit", incident);
    expect(data()?.isMet).toBe(true);
    expect(commerceOf(incident).ledger.refundBatches).toHaveLength(2);
  });
});

describe("role-gated laptops", () => {
  const opened = openIncident(scenario);
  const context = (role: Role) => ({ cluster: opened.cluster, scenario, history: [], role });

  it("refuses another role's tools the way the real tool would", () => {
    expect(runLine("kubectl get pods", context("frontend")).output[0].text).toMatch(
      /^Error from server \(Forbidden\): pods is forbidden: User "oncall-frontend@.*" cannot list resource "pods"/,
    );
    expect(runLine("kubectl rollout undo deployment/checkout-api", context("security")).cluster).toBeUndefined();
    expect(runLine('psql -c "show max_connections"', context("data")).output[0].text).toContain("no pg_hba.conf entry");
    expect(runLine("flags set checkout.auto_retry off", context("infrastructure")).output[0].text).toContain("403 Forbidden");
    expect(runLine("flags set checkout.auto_retry off", context("infrastructure")).cluster).toBeUndefined();
    expect(runLine("waf block --top 500", context("mobile")).cluster).toBeUndefined();
  });

  it("lists and completes only the tools a role can run", () => {
    const help = (role: Role) => runLine("help", context(role)).output.map((line) => line.text).join("\n");
    expect(help("frontend")).toContain("flags");
    expect(help("frontend")).not.toContain("kubectl");
    expect(help("data")).toContain("warehouse");
    expect(help("data")).not.toContain("siem");
    expect(help("infrastructure")).toContain("kubectl");
    expect(help("infrastructure")).not.toContain("remote-config");
    expect(completeLine("fl", context("frontend")).line).toBe("flags ");
    expect(completeLine("fl", context("infrastructure")).line).toBe("fl");
    expect(completeLine("kubectl ro", context("frontend")).line).toBe("kubectl ro");
  });

  it("doesn't install the commerce tools in a cluster-only incident", () => {
    const leak = { cluster: openIncident(checkoutPoolLeak).cluster, scenario: checkoutPoolLeak, history: [], role: "frontend" as const };
    expect(runLine("flags list", leak).output[0].text).toBe("bash: flags: command not found");
    expect(runLine("help", leak).output.map((line) => line.text).join("\n")).not.toContain("flags");
  });
});
