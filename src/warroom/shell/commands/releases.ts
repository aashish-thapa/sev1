import { segmentId, segmentStats } from "../../sim/clients.ts";
import { setReleasePaused } from "../../sim/commerce-actions.ts";
import { findPlatform, type Commerce, type Platform } from "../../sim/commerce.ts";
import { rolloutLabel } from "../../sim/rollout.ts";
import { applied, commerceCommand, percent, runEvidence, viewNames } from "../commerce-command.ts";
import { ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type ShellContext, type ShellResult } from "../types.ts";

const MOBILE = ["ios", "android"];
const COMMANDS = ["status", "halt", "resume", "rollback"];
const DISPLAY_NAME: Record<string, string> = { ios: "iOS", android: "Android" };

function crashFree(version: string): string {
  let hash = 0;
  for (const char of version) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  return `${(99.4 + (hash % 40) / 100).toFixed(2)}%`;
}

function status(filter: string | undefined, context: ShellContext, commerce: Commerce): ShellResult {
  if (filter && !MOBILE.includes(filter)) return { output: err(`releases: unknown platform "${filter}" (ios, android)`) };
  const stats = new Map(segmentStats(commerce, context.cluster.t).map((segment) => [segment.id, segment]));
  const requestsPerCheckout = (platform: Platform, version: Platform["current"]) => stats.get(segmentId(platform.id, version))?.amplification.toFixed(2) ?? "—";
  const rows = commerce.platforms
    .filter((platform) => MOBILE.includes(platform.id) && (!filter || platform.id === filter))
    .flatMap((platform) => [
      [platform.id, platform.current.version, rolloutLabel(platform), percent(platform.adoption), crashFree(platform.current.version), requestsPerCheckout(platform, platform.current)],
      ...(platform.previous
        ? [[platform.id, platform.previous.version, "superseded", percent(1 - platform.adoption), crashFree(platform.previous.version), requestsPerCheckout(platform, platform.previous)]]
        : []),
      ...(platform.inReview ? [[platform.id, platform.inReview, "in review", "—", "—", "—"]] : []),
    ]);
  return {
    output: [
      ...out(...table([["PLATFORM", "VERSION", "STATUS", "SESSIONS", "CRASH-FREE", "CHECKOUT REQ/ORDER"], ...rows])),
      ...dim("SESSIONS = share of the platform's sessions in the last hour. CHECKOUT REQ/ORDER from app network telemetry, last 5 min."),
    ],
  };
}

function setPaused(args: readonly string[], isPaused: boolean, context: ShellContext, commerce: Commerce): ShellResult {
  const [platformId, version] = args;
  const verb = isPaused ? "halt" : "resume";
  if (!platformId || !version) return { output: err(`usage: releases ${verb} <ios|android> <version>`) };
  const platform = findPlatform(commerce, platformId);
  return applied("releases", setReleasePaused(context.cluster, platformId, version, isPaused), () =>
    isPaused
      ? [
          ...out(`Phased release of Marlow ${DISPLAY_NAME[platformId] ?? platformId} ${version} paused at day ${platform?.rollout.kind === "phased" ? platform.rollout.day : "?"}.`),
          ...dim(
            `Automatic updates stop. Anyone can still update manually from the App Store, and the ${percent(platform?.adoption ?? 0)} of sessions already on ${version} keep it. A pause can last up to 30 days in total.`,
          ),
        ]
      : out(`Phased release of Marlow ${DISPLAY_NAME[platformId] ?? platformId} ${version} resumed.`),
  );
}

function rollback(args: readonly string[]): ShellResult {
  const [platformId] = args;
  if (platformId === "android") {
    return { output: err("releases: error: Play Console can halt a staged rollout but cannot downgrade installed apps; ship a higher versionCode or use remote-config") };
  }
  return {
    output: err(
      "releases: error: the App Store has no rollback — installed apps keep the build they have.",
      "Options: ship 7.3.1 (request expedited review), pause the phased release, or change behaviour with remote-config.",
    ),
  };
}

export const releases = commerceCommand({
  name: "releases",
  usage: "releases status [ios|android] | halt <platform> <version> | resume <platform> <version>",
  summary: "App Store / Play release status and phased rollouts",
  roles: ["mobile"],
  refuse: (_args, { role }) => ssoRefusal("releases", "app-store-release-managers", role),
  run([sub, ...rest], context, commerce) {
    const scenarioView = runEvidence(context, "releases", sub);
    if (scenarioView) return scenarioView;
    switch (sub) {
      case undefined:
      case "status":
        return status(rest[0], context, commerce);
      case "halt":
      case "pause":
        return setPaused(rest, true, context, commerce);
      case "resume":
        return setPaused(rest, false, context, commerce);
      case "rollback":
        return rollback(rest);
      default:
        return { output: err(`releases: unknown command "${sub}"`, `Commands: ${viewNames(context, "releases", COMMANDS).join(", ")}`) };
    }
  },
  complete(args, _partial, context, commerce) {
    if (args.length === 0) return viewNames(context, "releases", COMMANDS);
    if (args.length === 1) return MOBILE;
    if (args.length === 2 && ["halt", "resume", "rollback"].includes(args[0])) {
      const platform = findPlatform(commerce, args[1]);
      return platform ? [platform.current.version] : [];
    }
    return [];
  },
});
