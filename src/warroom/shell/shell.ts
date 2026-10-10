import { curl } from "./commands/curl.ts";
import { flags } from "./commands/flags.ts";
import { kubectl } from "./commands/kubectl.ts";
import { psql } from "./commands/psql.ts";
import { reconcile } from "./commands/reconcile.ts";
import { releases } from "./commands/releases.ts";
import { remoteConfig } from "./commands/remote-config.ts";
import { rum } from "./commands/rum.ts";
import { siem } from "./commands/siem.ts";
import { waf } from "./commands/waf.ts";
import { warehouse } from "./commands/warehouse.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import { tokenize } from "./tokenize.ts";
import { dim, err, out, type Command, type ShellContext, type ShellResult } from "./types.ts";

const help: Command = {
  name: "help",
  usage: "help",
  summary: "List what you can run from here",
  run: (_args, context) => ({
    output: [
      ...out(`Commands you can run (${ROLE_INFO[context.role].label}):`),
      ...installed(context)
        .filter((command) => command.name !== "help" && isPermitted(command, context))
        .flatMap((command) => [...out(`  ${command.name.padEnd(13)} ${command.summary}`), ...dim(`                ${command.usage}`)]),
      ...dim("Tab completes · ↑/↓ walks history"),
    ],
  }),
};

const clear: Command = {
  name: "clear",
  usage: "clear",
  summary: "Clear the screen",
  run: () => ({ output: [], clearScreen: true }),
};

const history: Command = {
  name: "history",
  usage: "history",
  summary: "Show the commands you ran",
  run: (_args, context) => ({
    output: out(...context.history.map((line, index) => `${String(index + 1).padStart(5)}  ${line}`)),
  }),
};

const COMMANDS: readonly Command[] = [help, kubectl, psql, curl, flags, rum, remoteConfig, releases, siem, waf, warehouse, reconcile, history, clear];

function installed(context: ShellContext): readonly Command[] {
  return COMMANDS.filter((command) => command.isAvailable?.(context) ?? true);
}

function isPermitted(command: Command, context: ShellContext): boolean {
  return !command.roles || command.roles.includes(context.role);
}

function resolve(name: string, context: ShellContext): Command | undefined {
  return installed(context).find((command) => command.name === name || command.aliases?.includes(name));
}

export function runLine(line: string, context: ShellContext): ShellResult {
  const { tokens, error } = tokenize(line);
  if (error) return { output: err(`bash: ${error}`) };
  const [name, ...args] = tokens;
  if (!name) return { output: [] };
  const command = resolve(name, context);
  if (!command) return { output: err(`bash: ${name}: command not found`) };
  if (!isPermitted(command, context)) return { output: command.refuse?.(args, context) ?? err(`${name}: permission denied`) };
  return command.run(args, context);
}

/** Completes the last word of `line`; returns the new line and the candidates when ambiguous. */
export function completeLine(line: string, context: ShellContext): { line: string; candidates: readonly string[] } {
  const endsWithSpace = /\s$/.test(line);
  const { tokens } = tokenize(line);
  const partial = endsWithSpace ? "" : (tokens.at(-1) ?? "");
  const before = endsWithSpace ? tokens : tokens.slice(0, -1);

  const pool =
    before.length === 0
      ? installed(context)
          .filter((command) => isPermitted(command, context))
          .flatMap((command) => [command.name, ...(command.aliases ?? [])])
      : completeArgs(resolve(before[0], context), before.slice(1), partial, context);
  const candidates = pool.filter((candidate) => candidate.startsWith(partial));
  if (candidates.length === 0) return { line, candidates: [] };

  const prefix = commonPrefix(candidates);
  const quote = (word: string) => (/\s/.test(word) ? `"${word}"` : word);
  const head = before.map(quote).join(" ");
  const completed = candidates.length === 1 ? `${quote(candidates[0])} ` : prefix;
  return { line: `${head}${head ? " " : ""}${completed}`, candidates: candidates.length > 1 ? candidates : [] };
}

function completeArgs(command: Command | undefined, args: readonly string[], partial: string, context: ShellContext): readonly string[] {
  if (!command || !isPermitted(command, context)) return [];
  return command.complete?.(args, partial, context) ?? [];
}

function commonPrefix(words: readonly string[]): string {
  return words.reduce((prefix, word) => {
    let length = 0;
    while (length < prefix.length && prefix[length] === word[length]) length += 1;
    return prefix.slice(0, length);
  });
}
