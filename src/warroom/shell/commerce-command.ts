import { clockAt } from "../scenario.ts";
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
