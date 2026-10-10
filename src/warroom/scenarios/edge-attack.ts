import type { Objective } from "../scenario.ts";
import { count, percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import type { AlertDisposition, Commerce } from "../sim/commerce.ts";
import { attackRequestsPerSecond, blockedAttackShare, blockedShare } from "../sim/edge.ts";
import type { ClusterState } from "../sim/model.ts";
import { checkoutCluster } from "./checkout-cluster.ts";

/** A WAF that blocks more customers than this has blocked customers. */
const CUSTOMERS_BLOCKED_TOLERANCE = 0.001;

/** checkout-api on a clean build: the attack is the only thing wrong. */
export function attackedCluster(seed: string, commerce: Commerce): ClusterState {
  return checkoutCluster({
    seed,
    revisions: [
      { number: 11, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
      { number: 12, tag: "v4.13.0", changeCause: "v4.13.0 order-status webhooks: retry with backoff", traits: [] },
    ],
    revision: 12,
    // Nothing was deployed today: the pods have been up since yesterday.
    podsStartedAgo: 26 * 3600,
    commerce,
  });
}

/** True once the WAF stops at least `share` of the attack. */
export function isAttackStopped(state: ClusterState, share: number): boolean {
  return !!state.commerce && blockedAttackShare(state.commerce.wafRules) >= share;
}

export function noCustomersBlocked(commerce: Commerce): Objective {
  const blocked = blockedShare(commerce.wafRules);
  return {
    role: "security",
    label: blocked > CUSTOMERS_BLOCKED_TOLERANCE ? `WAF rules are turning away ${percent(blocked, 0)} of checkout customers` : "No checkout customers blocked at the WAF",
    isMet: blocked <= CUSTOMERS_BLOCKED_TOLERANCE,
  };
}

export function alertClosedAs(commerce: Commerce, id: string, disposition: AlertDisposition): Objective {
  const closed = commerce.alerts.find((alert) => alert.id === id)?.resolution?.disposition;
  return { role: "security", label: `${id} closed as ${disposition} (${closed ?? "still open"})`, isMet: closed === disposition };
}

/** Attack requests per minute at the edge, blocked or not, and the share the WAF lets through. */
export function attackAtEdge(commerce: Commerce, t: number): { readonly perMinute: number; readonly passed: number } {
  if (!commerce.attack) return { perMinute: 0, passed: 0 };
  return { perMinute: attackRequestsPerSecond(commerce.attack, t) * 60, passed: 1 - blockedAttackShare(commerce.wafRules) };
}

/** A SIEM sign-in summary: the shop's usual sign-ins plus whatever the stuffing sends, against the 7-day baseline. */
export function signInSummary(state: ClusterState, attackSuccess: number, usernamesPerAddress: number, fromHosting: number): string[] {
  const { commerce } = state;
  if (!commerce) return [];
  const baseline = 604;
  const { perMinute } = attackAtEdge(commerce, state.t);
  const attempts = baseline + perMinute;
  const success = (baseline * 0.976 + perMinute * attackSuccess) / attempts;
  return [
    "Sign-ins · POST /session · last 15 min vs the same hour over the last 7 days",
    ...table([
      ["METRIC", "NOW", "7-DAY BASELINE"],
      ["sign-in attempts / min (at the edge)", count(attempts), count(baseline)],
      ["sign-in success ratio", percent(success), "97.6%"],
      ["distinct usernames per source IP (p99)", count(Math.max(3, usernamesPerAddress)), "3"],
      ["sign-ins from hosting / VPN ASNs", percent((baseline * 0.005 + perMinute * fromHosting) / attempts), "0.5%"],
      ["accounts locked out (failed-attempt limit)", count((perMinute * (1 - attackSuccess)) / 40), "2"],
    ]),
  ];
}
