import { setFlag } from "../../sim/commerce-actions.ts";
import { findFlag, isFlagOn, latestChange, type Commerce, type FeatureFlag } from "../../sim/commerce.ts";
import { FLAG_PROPAGATION_SECONDS } from "../../sim/clients.ts";
import { applied, commerceCommand, json, stamp } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { dim, err, out, table, type ShellContext, type ShellResult } from "../types.ts";

const ENVIRONMENT = "prod";
const ON_WORDS = ["on", "true", "enable", "enabled"];
const OFF_WORDS = ["off", "false", "disable", "disabled"];

function state(flag: FeatureFlag): string {
  return isFlagOn(flag) ? "on" : "off";
}

function unknownFlag(key: string): ShellResult {
  return { output: err(`flags: error: flag "${key}" not found in ${ENVIRONMENT} (try: flags list)`) };
}

function list(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = commerce.flags.map((flag) => {
    const change = latestChange(flag.history);
    return [flag.key, state(flag), flag.owner, stamp(context, change.at), change.by];
  });
  return { output: out(...table([["KEY", "STATE", "OWNER", "UPDATED", "BY"], ...rows])) };
}

function get(key: string, context: ShellContext, commerce: Commerce): ShellResult {
  const flag = findFlag(commerce, key);
  if (!flag) return unknownFlag(key);
  const change = latestChange(flag.history);
  return {
    output: json({
      key: flag.key,
      environment: ENVIRONMENT,
      enabled: isFlagOn(flag),
      description: flag.description,
      owner: flag.owner,
      updated: stamp(context, change.at),
      updatedBy: change.by,
      lastChange: change.note,
      delivery: { sdk: "web", mode: "streaming", typicalPropagation: `${FLAG_PROPAGATION_SECONDS}s` },
    }),
  };
}

function history(key: string, context: ShellContext, commerce: Commerce): ShellResult {
  const flag = findFlag(commerce, key);
  if (!flag) return unknownFlag(key);
  const rows = [...flag.history].reverse().map((change) => [stamp(context, change.at), change.by, `${change.from ? "on" : "off"} → ${change.to ? "on" : "off"}`, change.note]);
  return { output: out(...table([["WHEN", "BY", "CHANGE", "NOTE"], ...rows])) };
}

function set(args: readonly string[], context: ShellContext): ShellResult {
  const { value: note, rest } = takeFlag(args, "--note", "-m");
  const [key, value] = rest;
  if (!key || !value) return { output: err("usage: flags set <key> on|off [--note \"why\"]") };
  const word = value.toLowerCase();
  const enabled = ON_WORDS.includes(word) ? true : OFF_WORDS.includes(word) ? false : null;
  if (enabled === null) return { output: err(`flags: error: "${value}" is not a boolean; use on or off`) };
  const result = setFlag(context.cluster, key, enabled, operatorName(context.role), note ?? "set from CLI during incident");
  return applied("flags", result, () => [
    ...out(`${key}: ${enabled ? "off → on" : "on → off"} (${ENVIRONMENT})`),
    ...dim(`Streaming to connected clients; open tabs pick it up within ~${FLAG_PROPAGATION_SECONDS}s. New page loads get it immediately.`),
  ]);
}

export const flags = commerceCommand({
  name: "flags",
  usage: "flags list | get <key> | history <key> | set <key> on|off [--note \"why\"]",
  summary: "Read and flip web feature flags (prod)",
  roles: ["frontend"],
  refuse: (_args, { role }) => ssoRefusal("flags", "flags-prod-writers", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case "list":
      case "ls":
        return list(context, commerce);
      case "get":
        return rest[0] ? get(rest[0], context, commerce) : { output: err("usage: flags get <key>") };
      case "history":
        return rest[0] ? history(rest[0], context, commerce) : { output: err("usage: flags history <key>") };
      case "set":
        return set(rest, context);
      default:
        return { output: sub ? err(`flags: unknown command "${sub}"`, "Commands: list, get, history, set") : out("flags — feature flags for checkout-web", "", "Commands: list, get, history, set") };
    }
  },
  complete(args, _partial, _context, commerce) {
    if (args.length === 0) return ["list", "get", "history", "set"];
    if (args.length === 1 && ["get", "history", "set"].includes(args[0])) return commerce.flags.map((flag) => flag.key);
    if (args.length === 2 && args[0] === "set") return ["on", "off"];
    return [];
  },
});
