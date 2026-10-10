import type { Role } from "../domain/incident.ts";
import { ROLE_INFO } from "../domain/roles.ts";
import type { Incident } from "./incident.ts";
import type { CommsMessage, Scenario } from "./scenario.ts";
import { runLine } from "./shell/shell.ts";

/**
 * Lets colleagues play the roles no player covers: every playbook step whose time has come is
 * run as that role, unless that role is in `coveredRoles`. `done` holds the indices already played.
 */
export function applyTeamwork(
  incident: Incident,
  scenario: Scenario,
  coveredRoles: ReadonlySet<Role>,
  done: ReadonlySet<number>,
): { incident: Incident; done: ReadonlySet<number>; messages: readonly CommsMessage[] } {
  const playbook = scenario.teamPlaybook ?? [];
  if (incident.phase.name === "closed") return { incident, done, messages: [] };
  let cluster = incident.cluster;
  const nextDone = new Set(done);
  const messages: CommsMessage[] = [];
  playbook.forEach((play, index) => {
    if (done.has(index) || coveredRoles.has(play.role) || cluster.t < play.at) return;
    const result = runLine(play.line, { cluster, scenario, history: [], role: play.role });
    if (result.cluster) cluster = result.cluster;
    nextDone.add(index);
    messages.push({ at: cluster.t, from: `${play.by} · ${ROLE_INFO[play.role].label}`, text: play.says });
  });
  return { incident: cluster === incident.cluster ? incident : { ...incident, cluster }, done: nextDone, messages };
}
