/** What colleagues keep on their desks: decided once per desk, so the office looks lived-in and stays the same. */
import type { SnackId } from "../../../domain/pantry.ts";
import { PEOPLE, type Desk } from "../office.ts";

export type DeskThing = { readonly kind: "mug" } | { readonly kind: "cup" } | { readonly kind: "snack"; readonly item: SnackId };
/** `x` in the desk's frame (+x is the occupant's left), `z` toward the monitor. */
export type Clutter = { readonly desk: Desk; readonly thing: DeskThing; readonly x: number; readonly z: number };

const SNACK_TURN: readonly SnackId[] = ["granola-bar", "chips", "apple"];

export const DESK_CLUTTER: readonly Clutter[] = PEOPLE.flatMap((person, index): Clutter[] => {
  if (person.kind !== "seated") return [];
  const { desk } = person;
  const things: Clutter[] = [];
  if (index % 2 === 0) things.push({ desk, thing: { kind: "mug" }, x: -0.46, z: 0.02 });
  if (index % 4 === 1) things.push({ desk, thing: { kind: "cup" }, x: 0.48, z: 0.04 });
  if (index % 3 === 0) things.push({ desk, thing: { kind: "snack", item: SNACK_TURN[index % SNACK_TURN.length] }, x: 0.42, z: -0.1 });
  return things;
});
