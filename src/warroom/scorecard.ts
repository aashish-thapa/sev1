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
  /** True for at most one engineer: whoever's command last took the root cause out. */
  readonly isFixer: boolean;
};

export type Scorecard = readonly Tally[];

export type Engineer = Pick<Tally, "playerId" | "name" | "role">;

/** How one command moved the root cause, judged by the scenario before and after it. */
export type RootCauseShift = "fixed" | "reintroduced" | "unchanged";

export type CommandEffect = { readonly didChangeCluster: boolean; readonly rootCause: RootCauseShift };

export const EMPTY_SCORECARD: Scorecard = [];

export function rootCauseShift(wasFixed: boolean, isFixed: boolean): RootCauseShift {
  if (wasFixed === isFixed) return "unchanged";
  return isFixed ? "fixed" : "reintroduced";
}

export function recordCommand(card: Scorecard, who: Engineer, effect: CommandEffect): Scorecard {
  const counted = update(card, who, (tally) => ({
    ...tally,
    commands: tally.commands + 1,
    changes: tally.changes + (effect.didChangeCluster ? 1 : 0),
  }));
  if (effect.rootCause === "unchanged") return counted;
  // Credit moves to whoever fixed it last; a command that brings the cause back leaves nobody credited.
  return counted.map((tally) => ({ ...tally, isFixer: effect.rootCause === "fixed" && tally.playerId === who.playerId }));
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
