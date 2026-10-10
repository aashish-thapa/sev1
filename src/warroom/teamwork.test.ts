import { describe, expect, it } from "vitest";
import { ROLE_IDS, type Role } from "../domain/incident.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import { checkoutMeltdown as scenario } from "./scenarios/checkout-meltdown.ts";
import { runLine } from "./shell/shell.ts";
import { applyTeamwork } from "./teamwork.ts";

/** What a competent solo player of `role` types, a little after the page. */
const PLAYER_MOVE: Record<Role, { at: number; line: string }> = {
  infrastructure: { at: 60, line: "kubectl rollout undo deployment/checkout-api" },
  frontend: { at: 50, line: "flags set checkout.auto_retry off" },
  mobile: { at: 75, line: "remote-config set checkout_retry_policy backoff" },
  security: { at: 100, line: "siem resolve SEC-4471 --disposition benign" },
  data: { at: 340, line: "reconcile submit" },
};

function playSolo(role: Role): Incident {
  let incident = openIncident(scenario);
  let done: ReadonlySet<number> = new Set();
  let hasMoved = false;
  let isDeclared = false;
  for (let second = 0; second < 1400 && incident.phase.name !== "closed"; second += 1) {
    incident = advance(incident, scenario).incident;
    const team = applyTeamwork(incident, scenario, role, done);
    incident = team.incident;
    done = team.done;
    if (!hasMoved && incident.cluster.t >= PLAYER_MOVE[role].at) {
      const result = runLine(PLAYER_MOVE[role].line, { cluster: incident.cluster, scenario, history: [], role });
      if (result.cluster) incident = { ...incident, cluster: result.cluster };
      hasMoved = true;
    }
    if (!isDeclared && hasMoved && incident.cluster.t > 360 && incident.cluster.errorRate < 0.01) {
      incident = declareResolved(incident).incident;
      isDeclared = incident.phase.name === "monitoring";
    }
  }
  return incident;
}

describe("solo play with colleagues covering the other roles", () => {
  it.each(ROLE_IDS)("closes the meltdown when a %s player makes their own move", (role) => {
    const incident = playSolo(role);
    expect(incident.phase.name).toBe("closed");
    expect(debrief(incident, scenario, true).objectives?.every((objective) => objective.isMet)).toBe(true);
  });

  it("never plays the player's own role for them", () => {
    let incident = openIncident(scenario);
    let done: ReadonlySet<number> = new Set();
    for (let second = 0; second < 400; second += 1) {
      incident = advance(incident, scenario).incident;
      ({ incident, done } = applyTeamwork(incident, scenario, "frontend", done));
    }
    expect(debrief(incident, scenario, true).objectives?.find((objective) => objective.role === "frontend")?.isMet).toBe(false);
  });
});
