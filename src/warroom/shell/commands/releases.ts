import { mixGiveUp, segmentId, segmentStats } from "../../sim/clients.ts";
import { setReleasePaused } from "../../sim/commerce-actions.ts";
import { commerceDemand, type DemandSegment } from "../../sim/commerce-step.ts";
import { findPlatform, type Commerce, type Platform } from "../../sim/commerce.ts";
import { rolloutLabel } from "../../sim/rollout.ts";
import { applied, commerceCommand, percent, runEvidence, viewNames } from "../commerce-command.ts";
import { ssoRefusal } from "../identity.ts";
import { dim, err, out, table, type OutputLine, type ShellContext, type ShellResult } from "../types.ts";

const MOBILE = ["ios", "android"];
const COMMANDS = ["status", "halt", "resume", "rollback"];
const DISPLAY_NAME: Record<string, string> = { ios: "iOS", android: "Android" };

function crashFree(version: string): string {
  let hash = 0;
  for (const char of version) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  return `${(99.4 + (hash % 40) / 100).toFixed(2)}%`;
}

/**
 * Share of a build's checkout customers who end without an order, as the app's own telemetry counts
 * them: stuck on the update screen, failed in the app, or out of retries against `otherFailure`, the
 * share of requests failing for reasons no build caused (a slow gateway, shedding pods).
 */
function checkoutFailure(segment: DemandSegment, otherFailure: number): number {
  const requestFailure = segment.rejectedShare + (1 - segment.rejectedShare) * otherFailure;
  const inApp = segment.clientFailureShare + (1 - segment.clientFailureShare) * mixGiveUp(segment.mix, requestFailure);
  return segment.walledShare + (1 - segment.walledShare) * inApp;
}

function status(filter: string | undefined, context: ShellContext, commerce: Commerce): ShellResult {
  if (filter && !MOBILE.includes(filter)) return { output: err(`releases: unknown platform "${filter}" (ios, android)`) };
  const stats = new Map(segmentStats(commerce, context.cluster.t).map((segment) => [segment.id, segment]));
  const demand = commerceDemand(context.cluster, commerce);
  const segments = new Map(demand.segments.map((segment) => [segment.id, segment]));
  const rejected = demand.rejectedCheckoutShare;
  const otherFailure = rejected < 1 ? Math.min(1, Math.max(0, (commerce.pulse.checkoutFailureRate - rejected) / (1 - rejected))) : 0;
  const telemetry = (platform: Platform, build: Platform["current"]) => {
    const id = segmentId(platform.id, build);
    const segment = segments.get(id);
    return [stats.get(id)?.amplification.toFixed(2) ?? "—", segment ? percent(checkoutFailure(segment, otherFailure)) : "—"];
  };
  const shown = commerce.platforms.filter((platform) => MOBILE.includes(platform.id) && (!filter || platform.id === filter));
  const rows = shown.flatMap((platform) => [
    [platform.id, platform.current.version, rolloutLabel(platform), percent(platform.adoption), crashFree(platform.current.version), ...telemetry(platform, platform.current)],
    ...(platform.previous
      ? [[platform.id, platform.previous.version, "superseded", percent(1 - platform.adoption), crashFree(platform.previous.version), ...telemetry(platform, platform.previous)]]
      : []),
    ...(platform.inReview ? [[platform.id, platform.inReview, "in review", "—", "—", "—", "—"]] : []),
  ]);
  const walls = demand.segments
    .filter((segment) => segment.walledShare > 0.005 && shown.some((platform) => platform.id === segment.platform))
    .map((segment) => `${DISPLAY_NAME[segment.platform] ?? segment.platform} ${segment.version}: ${percent(segment.walledShare)} of sessions are on the forced-update screen.`);
  return {
    output: [
      ...out(...table([["PLATFORM", "VERSION", "STATUS", "SESSIONS", "CRASH-FREE", "REQ/ORDER", "FAILED"], ...rows])),
      ...out(...walls),
      ...dim(
        "SESSIONS = share of the platform's sessions in the last hour. From app telemetry, last 5 min: REQ/ORDER = checkout requests sent per order; FAILED = share of checkouts started on the build that ended without an order.",
      ),
    ],
  };
}

function haltedLines(platform: Platform | undefined, platformId: string, version: string): readonly OutputLine[] {
  const kept = `the ${percent(platform?.adoption ?? 0)} of sessions already on ${version} keep it`;
  if (platformId === "android") {
    return [...out(`Staged rollout of Marlow Android ${version} halted.`), ...dim(`Google Play stops offering it to anyone new, and ${kept}: Play can't downgrade an installed app.`)];
  }
  return [
    ...out(`Phased release of Marlow ${DISPLAY_NAME[platformId] ?? platformId} ${version} paused at day ${platform?.rollout.kind === "phased" ? platform.rollout.day : "?"}.`),
    ...dim(`Automatic updates stop. Anyone can still update manually from the App Store, and ${kept}. A pause can last up to 30 days in total.`),
  ];
}

function setPaused(args: readonly string[], isPaused: boolean, context: ShellContext, commerce: Commerce): ShellResult {
  const [platformId, version] = args;
  const verb = isPaused ? "halt" : "resume";
  if (!platformId || !version) return { output: err(`usage: releases ${verb} <ios|android> <version>`) };
  const platform = findPlatform(commerce, platformId);
  const release = platformId === "android" ? "Staged rollout" : "Phased release";
  return applied("releases", setReleasePaused(context.cluster, platformId, version, isPaused), () =>
    isPaused ? haltedLines(platform, platformId, version) : out(`${release} of Marlow ${DISPLAY_NAME[platformId] ?? platformId} ${version} resumed.`),
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
