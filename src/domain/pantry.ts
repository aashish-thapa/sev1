/**
 * The office pantry: what's on offer, what each item costs the company, and a log of what you've
 * taken. In job mode the pantry is free to you — the costs are here for startup mode, where a
 * founder's pantry becomes an operating expense. Nothing here touches the wallet yet.
 */
import { z } from "zod";
import type { Refuel } from "./wellbeing.ts";

export type Consumable = {
  readonly id: string;
  readonly title: string;
  /** Which meter it refills. */
  readonly refuels: Refuel;
  /** What one serving costs the company, in cents — used by startup mode later; job mode pantry is free. */
  readonly unitCostCents: number;
};

export const CONSUMABLES = [
  { id: "coffee", title: "Coffee", refuels: "coffee", unitCostCents: 85 },
  { id: "granola-bar", title: "Granola bar", refuels: "snack", unitCostCents: 120 },
  { id: "apple", title: "Apple", refuels: "snack", unitCostCents: 60 },
  { id: "chips", title: "Chips", refuels: "snack", unitCostCents: 150 },
] as const satisfies readonly Consumable[];

export type ConsumableId = (typeof CONSUMABLES)[number]["id"];
export type SnackId = Extract<(typeof CONSUMABLES)[number], { refuels: "snack" }>["id"];

export const SNACKS: readonly SnackId[] = CONSUMABLES.filter((item): item is Extract<(typeof CONSUMABLES)[number], { refuels: "snack" }> => item.refuels === "snack").map((item) => item.id);

export function consumableById(id: ConsumableId): Consumable {
  const found = CONSUMABLES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown consumable ${id}`);
  return found;
}

/** How many days of per-day counts a save keeps; older days only survive in the lifetime totals. */
export const PANTRY_DAYS = 30;

const Count = z.int().nonnegative();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PerItemSchema = z.record(z.string(), Count);

export const PantryLogSchema = z.object({
  /** Servings taken since the account began, by consumable id. */
  lifetime: PerItemSchema,
  /** Servings per day, newest first, at most PANTRY_DAYS days. */
  days: z.array(z.object({ day: Day, taken: PerItemSchema })).max(PANTRY_DAYS),
});
export type PantryLog = z.output<typeof PantryLogSchema>;

export const EMPTY_PANTRY: PantryLog = { lifetime: {}, days: [] };

/** Logs one serving taken on `day` (YYYY-MM-DD). */
export function recordTaken(log: PantryLog, id: ConsumableId, day: string): PantryLog {
  const bump = (counts: Readonly<Record<string, number>>) => ({ ...counts, [id]: (counts[id] ?? 0) + 1 });
  const [today, ...earlier] = log.days[0]?.day === day ? log.days : [{ day, taken: {} }, ...log.days];
  return { lifetime: bump(log.lifetime), days: [{ day, taken: bump(today.taken) }, ...earlier].slice(0, PANTRY_DAYS) };
}

/** What the logged servings would have cost the company, in cents — startup mode's pantry line. */
export function pantryCostCents(taken: Readonly<Record<string, number>>): number {
  return CONSUMABLES.reduce((sum, item) => sum + (taken[item.id] ?? 0) * item.unitCostCents, 0);
}

/** What one day's logged servings cost (YYYY-MM-DD); 0 for a day nothing was taken. */
export function pantryCostOn(log: PantryLog, day: string): number {
  const entry = log.days.find((candidate) => candidate.day === day);
  return entry ? pantryCostCents(entry.taken) : 0;
}
