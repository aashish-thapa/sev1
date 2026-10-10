/** A snack from the kitchen shelf: in your hand until the last bite. */
import { SNACKS, type SnackId } from "../../../domain/pantry.ts";

export const BITES_PER_SNACK = 3;

export type Snack = { readonly kind: "none" } | { readonly kind: "holding"; readonly item: SnackId; readonly bitesLeft: number };

export const NO_SNACK: Snack = { kind: "none" };

/** The shelf hands out its snacks in turn, so you get a different one each time. */
export function snackAt(turn: number): SnackId {
  return SNACKS[((turn % SNACKS.length) + SNACKS.length) % SNACKS.length];
}

export function grab(item: SnackId): Snack {
  return { kind: "holding", item, bitesLeft: BITES_PER_SNACK };
}

/** One bite; after the last one your hand is empty. */
export function bite(snack: Snack): Snack {
  if (snack.kind !== "holding") return snack;
  return snack.bitesLeft > 1 ? { ...snack, bitesLeft: snack.bitesLeft - 1 } : NO_SNACK;
}
