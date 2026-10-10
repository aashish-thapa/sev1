import { z } from "zod";
import { IncidentPackSchema, type IncidentCard } from "../domain/incident.ts";

export type IncidentLibrary = {
  readonly cards: readonly IncidentCard[];
  byId(id: string): IncidentCard | undefined;
};

export type PackProblem = { readonly path: string; readonly message: string };

/**
 * Builds the playable library. `pnpm build` validates every pack first, so a bad pack
 * only reaches here in development; it is skipped and reported instead of breaking the app.
 */
export function createLibrary(packs: Record<string, unknown>, onProblem: (problem: PackProblem) => void = () => {}): IncidentLibrary {
  const cards = Object.entries(packs)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, raw]) => {
      const parsed = IncidentPackSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      onProblem({ path, message: z.prettifyError(parsed.error) });
      return [];
    });
  const index = new Map(cards.map((card) => [card.id, card]));
  return { cards, byId: (id) => index.get(id) };
}
