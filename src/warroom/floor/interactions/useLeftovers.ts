import { useCallback, useState } from "react";
import type { SnackId } from "../../../domain/pantry.ts";

export type Leftover = { readonly kind: "cup" } | { readonly kind: "wrapper"; readonly item: SnackId };

/** A desk only takes so much clutter before you clear it. */
const MAX_LEFTOVERS = 4;

/** What you've finished this session sits on your desk: empty cups, wrappers, an apple core. */
export function useLeftovers() {
  const [leftovers, setLeftovers] = useState<readonly Leftover[]>([]);
  const leave = useCallback((leftover: Leftover) => setLeftovers((current) => [...current, leftover].slice(-MAX_LEFTOVERS)), []);
  return { leftovers, leave };
}
