import type { Settlement } from "./commerce-step.ts";
import type { Commerce } from "./commerce.ts";
import { attackRequestsPerSecond, blockedAttackShare } from "./edge.ts";

/** What `commerce.attack` sends at the cluster this second. */
export type AttackLoad = {
  /** Attack requests the WAF lets through; never checkouts, so they add load without adding orders. */
  readonly requestsPerSecond: number;
};

export const NO_ATTACK: AttackLoad = { requestsPerSecond: 0 };

/** The attack's rate at `t`, less what the WAF's rules stop between them. */
export function attackLoad(commerce: Commerce, t: number): AttackLoad {
  const { attack } = commerce;
  if (!attack) return NO_ATTACK;
  return { requestsPerSecond: attackRequestsPerSecond(attack, t) * (1 - blockedAttackShare(commerce.wafRules)) };
}

/**
 * Advances `commerce.attack` by one settled second. The attack is a pure function of time and the
 * rules in place, so there is nothing to carry from one second to the next: returns `commerce` itself.
 */
export function stepAttack(commerce: Commerce, _settlement: Settlement): Commerce {
  return commerce;
}
