import { clockAt, type Evidence, type EvidenceTool } from "../scenario.ts";
import type { CommerceResult } from "../sim/commerce-actions.ts";
import type { Commerce } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { age, err, out, type Command, type OutputLine, type ShellContext, type ShellResult } from "./types.ts";

/** Telemetry CLIs summarise the trailing five minutes; the sim keeps per-second rates. */
export const WINDOW_SECONDS = 300;

type CommerceCommandSpec = Omit<Command, "run" | "complete" | "isAvailable"> & {
  run(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult;
  complete?(args: readonly string[], partial: string, context: ShellContext, commerce: Commerce): readonly string[];
};

/** A tool that talks to the services around the cluster; incidents without them don't install it. */
export function commerceCommand(spec: CommerceCommandSpec): Command {
  const { run, complete, ...rest } = spec;
  return {
    ...rest,
    isAvailable: (context) => context.cluster.commerce !== undefined,
    run: (args, context) => (context.cluster.commerce ? run(args, context, context.cluster.commerce) : { output: err(`bash: ${spec.name}: command not found`) }),
    complete: (args, partial, context) => (context.cluster.commerce && complete ? complete(args, partial, context, context.cluster.commerce) : []),
  };
}

/** The scenario's own saved views for `tool`. */
export function evidenceFor(context: ShellContext, tool: EvidenceTool): readonly Evidence[] {
  return context.scenario.evidence?.filter((entry) => entry.tool === tool) ?? [];
}

/** Runs the scenario's view called `name`, if it has one; tools ask before their built-ins, so a scenario can replace one. */
export function runEvidence(context: ShellContext, tool: EvidenceTool, name: string | undefined): ShellResult | null {
  const entry = evidenceFor(context, tool).find((candidate) => candidate.name === name);
  return entry ? { output: out(...entry.run(context.cluster)) } : null;
}

/** A tool's built-in view names followed by the scenario's own, each once. */
export function viewNames(context: ShellContext, tool: EvidenceTool, builtIns: readonly string[]): string[] {
  return [...new Set([...builtIns, ...evidenceFor(context, tool).map((entry) => entry.name)])];
}

export function applied(tool: string, result: CommerceResult, render: (state: ClusterState) => readonly OutputLine[]): ShellResult {
  return result.ok ? { output: render(result.state), cluster: result.state } : { output: err(`${tool}: error: ${result.error}`) };
}

/** Wall-clock time for anything today, relative age for older changes. */
export function stamp(context: ShellContext, at: number): string {
  const elapsed = context.cluster.t - at;
  return elapsed < 10 * 3600 ? clockAt(context.scenario, at) : `${age(elapsed)} ago`;
}

export function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function percent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function json(value: unknown): readonly OutputLine[] {
  return out(...JSON.stringify(value, null, 2).split("\n"));
}
