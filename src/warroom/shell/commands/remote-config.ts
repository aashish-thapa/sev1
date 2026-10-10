import { REMOTE_CONFIG_PROPAGATION_SECONDS, RETRY_POLICIES } from "../../sim/clients.ts";
import { setRemoteConfig } from "../../sim/commerce-actions.ts";
import {
  configValue,
  configVersion,
  findConfig,
  isRetryPolicyName,
  latestChange,
  RETRY_POLICY_NAMES,
  type Commerce,
  type RemoteConfigEntry,
} from "../../sim/commerce.ts";
import { applied, commerceCommand, json, stamp } from "../commerce-command.ts";
import { operatorName, ssoRefusal } from "../identity.ts";
import { takeFlag } from "../tokenize.ts";
import { dim, err, out, table, type ShellContext, type ShellResult } from "../types.ts";

function isRetryPolicyKey(entry: RemoteConfigEntry): boolean {
  return entry.allowed !== null && entry.allowed.length === RETRY_POLICY_NAMES.length && entry.allowed.every(isRetryPolicyName);
}

function unknownKey(key: string): ShellResult {
  return { output: err(`remote-config: error: key "${key}" not found in template (try: remote-config list)`) };
}

function list(context: ShellContext, commerce: Commerce): ShellResult {
  const rows = commerce.remoteConfig.map((entry) => {
    const change = latestChange(entry.history);
    return [entry.key, JSON.stringify(configValue(entry)), entry.readBy, `v${configVersion(entry)}`, stamp(context, change.at), change.by];
  });
  return { output: out(...table([["KEY", "VALUE", "READ BY", "VERSION", "UPDATED", "BY"], ...rows])) };
}

function get(key: string, context: ShellContext, commerce: Commerce): ShellResult {
  const entry = findConfig(commerce, key);
  if (!entry) return unknownKey(key);
  const change = latestChange(entry.history);
  const allowedValues = isRetryPolicyKey(entry)
    ? Object.fromEntries(RETRY_POLICY_NAMES.map((name) => [name, RETRY_POLICIES[name].summary]))
    : entry.allowed;
  return {
    output: json({
      key: entry.key,
      value: configValue(entry),
      description: entry.description,
      readBy: entry.readBy,
      allowedValues,
      version: configVersion(entry),
      updated: stamp(context, change.at),
      updatedBy: change.by,
      note: change.note,
    }),
  };
}

function history(key: string, context: ShellContext, commerce: Commerce): ShellResult {
  const entry = findConfig(commerce, key);
  if (!entry) return unknownKey(key);
  const rows = [...entry.history].reverse().map((change, index) => [
    `v${configVersion(entry) - index}`,
    stamp(context, change.at),
    change.by,
    `${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`,
    change.note,
  ]);
  return { output: out(...table([["VERSION", "WHEN", "BY", "CHANGE", "NOTE"], ...rows])) };
}

function set(args: readonly string[], context: ShellContext, commerce: Commerce): ShellResult {
  const { value: note, rest } = takeFlag(args, "--note", "-m");
  const [key, value] = rest;
  if (!key || value === undefined) return { output: err('usage: remote-config set <key> <value> [--note "why"]') };
  const entry = findConfig(commerce, key);
  const result = setRemoteConfig(context.cluster, key, value, operatorName(context.role), note ?? "published from CLI during incident");
  return applied("remote-config", result, (state) => {
    const version = entry && state.commerce ? configVersion(findConfig(state.commerce, key) ?? entry) : 0;
    return [
      ...out(`Published ${key} = ${JSON.stringify(value)} (template v${version}).`),
      ...dim(
        `Read by ${entry?.readBy ?? "?"}. Apps apply it on their next fetch: realtime listeners within ~${REMOTE_CONFIG_PROPAGATION_SECONDS / 60} min, backgrounded apps when they come back to the foreground.`,
      ),
    ];
  });
}

export const remoteConfig = commerceCommand({
  name: "remote-config",
  usage: 'remote-config list | get <key> | history <key> | set <key> <value> [--note "why"]',
  summary: "Read and publish mobile app remote config",
  roles: ["mobile"],
  refuse: (_args, { role }) => ssoRefusal("remote-config", "remote-config-publishers", role),
  run([sub, ...rest], context, commerce) {
    switch (sub) {
      case "list":
      case "ls":
        return list(context, commerce);
      case "get":
        return rest[0] ? get(rest[0], context, commerce) : { output: err("usage: remote-config get <key>") };
      case "history":
        return rest[0] ? history(rest[0], context, commerce) : { output: err("usage: remote-config history <key>") };
      case "set":
        return set(rest, context, commerce);
      default:
        return { output: sub ? err(`remote-config: unknown command "${sub}"`, "Commands: list, get, history, set") : out("remote-config — Marlow app config template (prod)", "", "Commands: list, get, history, set") };
    }
  },
  complete(args, _partial, _context, commerce) {
    if (args.length === 0) return ["list", "get", "history", "set"];
    if (args.length === 1 && ["get", "history", "set"].includes(args[0])) return commerce.remoteConfig.map((entry) => entry.key);
    if (args.length === 2 && args[0] === "set") return [...(findConfig(commerce, args[1])?.allowed ?? [])];
    return [];
  },
});
