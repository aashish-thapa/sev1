/**
 * Your coffee, start to finish: brewing at the machine, a cup in your hand, a few sips, and
 * a little extra pace while the caffeine lasts. Times are seconds on any steady clock.
 */

export const BREW_SECONDS = 4;
export const SIPS_PER_CUP = 4;
export const CAFFEINE_SECONDS = 300;
/** Coffee speeds your walk a little — it's a perk, not a sprint button. */
const CAFFEINATED_SPEED = 1.2;

export type Cup = { readonly kind: "none" } | { readonly kind: "brewing"; readonly readyAt: number } | { readonly kind: "holding"; readonly sipsLeft: number };

export type Coffee = { readonly cup: Cup; readonly caffeinatedUntil: number };

export const NO_COFFEE: Coffee = { cup: { kind: "none" }, caffeinatedUntil: 0 };

/** Only with empty hands: one cup at a time. */
export function canBrew(coffee: Coffee): boolean {
  return coffee.cup.kind === "none";
}

export function startBrewing(coffee: Coffee, now: number): Coffee {
  return canBrew(coffee) ? { ...coffee, cup: { kind: "brewing", readyAt: now + BREW_SECONDS } } : coffee;
}

/** Hands you the cup once the machine is done. */
export function settle(coffee: Coffee, now: number): Coffee {
  return coffee.cup.kind === "brewing" && now >= coffee.cup.readyAt ? { ...coffee, cup: { kind: "holding", sipsLeft: SIPS_PER_CUP } } : coffee;
}

/** Each sip tops the caffeine back up; the last one leaves you with nothing to hold. */
export function sip(coffee: Coffee, now: number): Coffee {
  if (coffee.cup.kind !== "holding") return coffee;
  const sipsLeft = coffee.cup.sipsLeft - 1;
  return { cup: sipsLeft > 0 ? { kind: "holding", sipsLeft } : { kind: "none" }, caffeinatedUntil: now + CAFFEINE_SECONDS };
}

export function caffeineLeft(coffee: Coffee, now: number): number {
  return Math.max(0, coffee.caffeinatedUntil - now);
}

export function walkSpeedScale(coffee: Coffee, now: number): number {
  return caffeineLeft(coffee, now) > 0 ? CAFFEINATED_SPEED : 1;
}

/** 0…1 through the brew, for the steam and the progress ring. */
export function brewProgress(coffee: Coffee, now: number): number {
  if (coffee.cup.kind !== "brewing") return coffee.cup.kind === "holding" ? 1 : 0;
  return Math.min(1, Math.max(0, 1 - (coffee.cup.readyAt - now) / BREW_SECONDS));
}
