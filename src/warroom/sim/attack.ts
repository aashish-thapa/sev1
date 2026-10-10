import type { Settlement } from "./commerce-step.ts";
import type { Commerce } from "./commerce.ts";

/** What `commerce.attack` sends at the cluster this second. */
export type AttackLoad = {
  /** Attack requests the WAF lets through; never checkouts, so they add load without adding orders. */
  readonly requestsPerSecond: number;
};

export const NO_ATTACK: AttackLoad = { requestsPerSecond: 0 };

/** Attack load at `t`, after every WAF rule's `attackShare`. Neutral: no attack traffic. */
export function attackLoad(_commerce: Commerce, _t: number): AttackLoad {
  return NO_ATTACK;
}

/** Advances `commerce.attack` by one settled second. Neutral: returns `commerce` itself. */
export function stepAttack(commerce: Commerce, _settlement: Settlement): Commerce {
  return commerce;
}
