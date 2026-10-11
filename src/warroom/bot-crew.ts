/**
 * A rival team made of bots, for a versus match nobody else turned up to. The crew plays the
 * scenario's worked solution at a human pace, then calls it resolved once production has settled,
 * so a player who reads the system well can beat it.
 */
import type { Role } from "../domain/incident.ts";
import type { Random } from "../domain/random.ts";
import { declareResolved, isRollingOut, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { runLine } from "./shell/shell.ts";

export type BotMove = { readonly at: number; readonly role: Role; readonly command: string };

export type BotPlan = {
  readonly moves: readonly BotMove[];
  /** How many moves have been played. */
  readonly played: number;
};

/** Simulated seconds: when the crew first acts, and the gap between moves (a base plus a seeded spread). */
const FIRST_MOVE_AT = 25;
const MOVE_GAP_MIN = 12;
const MOVE_GAP_SPREAD = 12;
/** In a cross-team incident data refunds wait out the retry storm, as the worked solutions say. */
const DATA_WAITS_UNTIL = 420;
/** After its last move the crew watches this long before calling it, so a rollout can finish first. */
const SETTLE_SECONDS = 90;

/** Every role's steps in the order the solutions are written to be played: data last. */
export function planCrew(scenario: Scenario, random: Random): BotPlan {
  const order = [...scenario.roles.filter((role) => role !== "data"), ...scenario.roles.filter((role) => role === "data")];
  const moves: BotMove[] = [];
  let at = FIRST_MOVE_AT;
  for (const role of order) {
    if (role === "data" && scenario.roles.length > 1) at = Math.max(at, DATA_WAITS_UNTIL);
    for (const step of scenario.solution[role] ?? []) {
      moves.push({ at: Math.round(at), role, command: step.command });
      at += MOVE_GAP_MIN + random() * MOVE_GAP_SPREAD;
    }
  }
  return { moves, played: 0 };
}

/** Plays every move that's due, then, once the plan is done and production has settled, declares. */
export function crewTurn(plan: BotPlan, incident: Incident, scenario: Scenario): { plan: BotPlan; incident: Incident } {
  if (incident.phase.name !== "live") return { plan, incident };
  let cluster = incident.cluster;
  let played = plan.played;
  for (const move of plan.moves.slice(played)) {
    if (move.at > cluster.t) break;
    const result = runLine(move.command, { cluster, scenario, history: [], role: move.role });
    if (result.cluster) cluster = result.cluster;
    played += 1;
  }
  const next = { ...plan, played };
  const acted = cluster === incident.cluster ? incident : { ...incident, cluster };
  const lastMoveAt = plan.moves.at(-1)?.at ?? 0;
  const isSettled = played === plan.moves.length && cluster.t >= lastMoveAt + SETTLE_SECONDS && !isRollingOut(cluster);
  if (!isSettled) return { plan: next, incident: acted };
  // The pager refuses while the alert still fires; then the crew simply tries again next second.
  return { plan: next, incident: declareResolved(acted, scenario).incident };
}
