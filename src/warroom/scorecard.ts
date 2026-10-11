import type { Role } from "../domain/incident.ts";

/** What one engineer did in a shared incident, counted by the room as their commands land. */
export type Tally = {
  readonly playerId: string;
  readonly name: string;
  readonly role: Role;
  readonly commands: number;
  /** Commands that changed the cluster, rather than only looking at it. */
  readonly changes: number;
  /** "Resolved" calls the pager turned down because the alert was still firing. */
  readonly earlyDeclares: number;
  /** True for at most one engineer: whoever last changed the cluster before the root cause went away. */
  readonly isFixer: boolean;
};

export type Scorecard = readonly Tally[];

export type Engineer = Pick<Tally, "playerId" | "name" | "role">;

/** How the root cause moved between two states of the cluster, judged by the scenario. */
export type RootCauseShift = "fixed" | "reintroduced" | "unchanged";

export const EMPTY_SCORECARD: Scorecard = [];

export function rootCauseShift(wasFixed: boolean, isFixed: boolean): RootCauseShift {
  if (wasFixed === isFixed) return "unchanged";
  return isFixed ? "fixed" : "reintroduced";
}

export function recordCommand(card: Scorecard, who: Engineer, didChangeCluster: boolean): Scorecard {
  return update(card, who, (tally) => ({ ...tally, commands: tally.commands + 1, changes: tally.changes + (didChangeCluster ? 1 : 0) }));
}

/**
 * A fix often lands seconds after the command behind it (a rollout replacing pods), so the credit
 * goes to `lastChanger`: whoever last changed the cluster. Nobody is credited when the cause comes
 * back, or when only colleagues had touched the cluster.
 */
export function recordRootCause(card: Scorecard, shift: RootCauseShift, lastChanger: Engineer | null): Scorecard {
  if (shift === "unchanged") return card;
  const credited = shift === "fixed" ? lastChanger : null;
  const withCredited = credited ? update(card, credited, (tally) => tally) : card;
  return withCredited.map((tally) => ({ ...tally, isFixer: tally.playerId === credited?.playerId }));
}

export function recordEarlyDeclare(card: Scorecard, who: Engineer): Scorecard {
  return update(card, who, (tally) => ({ ...tally, earlyDeclares: tally.earlyDeclares + 1 }));
}

/** The fixer if there is one, else whoever changed the most (then ran the most); null when nobody did anything. */
export function mostValuable(card: Scorecard): Tally | null {
  const fixer = card.find((tally) => tally.isFixer);
  if (fixer) return fixer;
  const ranked = [...card].filter((tally) => tally.commands > 0).sort((left, right) => right.changes - left.changes || right.commands - left.commands);
  return ranked[0] ?? null;
}

function update(card: Scorecard, who: Engineer, change: (tally: Tally) => Tally): Scorecard {
  const existing = card.find((tally) => tally.playerId === who.playerId);
  if (!existing) return [...card, change({ ...who, commands: 0, changes: 0, earlyDeclares: 0, isFixer: false })];
  return card.map((tally) => (tally === existing ? change(tally) : tally));
}
