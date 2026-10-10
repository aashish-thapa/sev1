import { z } from "zod";
import { TaskPackSchema, type Task } from "../domain/work/task.ts";
import type { PackProblem } from "./library.ts";

/** Builds the daily-work library; like incident packs, a bad pack is skipped and reported rather than breaking the app. */
export function createTaskLibrary(packs: Record<string, unknown>, onProblem: (problem: PackProblem) => void = () => {}): readonly Task[] {
  return Object.entries(packs)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, raw]) => {
      const parsed = TaskPackSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      onProblem({ path, message: z.prettifyError(parsed.error) });
      return [];
    });
}
