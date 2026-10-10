import type { Role } from "../../domain/incident.ts";
import type { Scenario } from "../scenario.ts";
import type { ClusterState } from "../sim/model.ts";

export type OutputTone = "out" | "err" | "dim";

export type OutputLine = { readonly text: string; readonly tone: OutputTone };

export type ShellContext = {
  readonly cluster: ClusterState;
  readonly scenario: Scenario;
  readonly history: readonly string[];
  /** Whose laptop this is; role-specific tools only answer to their role. */
  readonly role: Role;
};

export type ShellResult = {
  readonly output: readonly OutputLine[];
  /** Present when the command changed the cluster. */
  readonly cluster?: ClusterState;
  readonly clearScreen?: boolean;
};

export type Command = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly summary: string;
  /** Roles allowed to use the tool; absent means everyone. */
  readonly roles?: readonly Role[];
  /** How the tool turns away a role outside `roles`, the way the real tool reports an auth failure. */
  refuse?(args: readonly string[], context: ShellContext): readonly OutputLine[];
  /** False when the incident has nothing for this tool to talk to; the shell then doesn't offer it. */
  isAvailable?(context: ShellContext): boolean;
  run(args: readonly string[], context: ShellContext): ShellResult;
  /** Candidates for the argument currently being typed (`args` excludes it). */
  complete?(args: readonly string[], partial: string, context: ShellContext): readonly string[];
};

export const out = (...lines: readonly string[]): OutputLine[] => lines.map((text) => ({ text, tone: "out" }));
export const err = (...lines: readonly string[]): OutputLine[] => lines.map((text) => ({ text, tone: "err" }));
export const dim = (...lines: readonly string[]): OutputLine[] => lines.map((text) => ({ text, tone: "dim" }));

/** Left-aligned columns separated by three spaces, the way kubectl prints tables. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] + 3)))
      .join("")
      .trimEnd(),
  );
}

export function age(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 180) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) return `${hours}h${minutes % 60}m`;
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
