import type { Level } from "../../domain/career.ts";
import { isPro, isReleasedFor, type Entitlements } from "../../domain/entitlements.ts";
import type { Role } from "../../domain/incident.ts";
import type { Scenario } from "../scenario.ts";
import { checkoutMeltdown } from "./checkout-meltdown.ts";
import { checkoutPoolLeak } from "./checkout-pool-leak.ts";
import { crashOnCheckout } from "./crash-on-checkout.ts";
import { oomAfterDeploy } from "./oom-after-deploy.ts";
import { ordersIndexInvalid } from "./orders-index-invalid.ts";
import { scaledToZero } from "./scaled-to-zero.ts";

/** Every live incident the game ships; the app and the room server read this one list. */
export const SCENARIOS: readonly Scenario[] = [scaledToZero, crashOnCheckout, oomAfterDeploy, checkoutPoolLeak, ordersIndexInvalid, checkoutMeltdown];

/** Infra's own outages, easiest first. */
const INFRA_SOLO: readonly Scenario[] = [scaledToZero, crashOnCheckout, oomAfterDeploy, checkoutPoolLeak, ordersIndexInvalid];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** A War Room opens at the career level one below its tier: interns get tier 1, staff everything. */
export function isUnlocked(scenario: Scenario, level: Level): boolean {
  return scenario.tier <= level + 1;
}

/**
 * Solo War Rooms a player of `role` at `level` may play, hardest first, for a replay picker.
 * Roles without their own ladder yet only have the cross-team incident, and keep it at every level.
 */
export function unlockedWarRooms(role: Role, level: Level): readonly Scenario[] {
  if (role !== "infrastructure") return [checkoutMeltdown];
  return INFRA_SOLO.filter((scenario) => isUnlocked(scenario, level)).toReversed();
}

/**
 * The incident that pages a solo player of `role` at career `level`. `rotation` (e.g. War Rooms
 * played so far) cycles through everything unlocked, hardest first, so new incidents arrive with a
 * promotion and the easier ones keep coming back as practice.
 */
export function soloScenarioFor(role: Role, rotation = 0, level: Level = 0): Scenario {
  const pool = unlockedWarRooms(role, level);
  const turn = ((Math.trunc(rotation) % pool.length) + pool.length) % pool.length;
  return pool[turn];
}

/** Shared rooms always play the cross-team incident: it's the one nobody can fix alone. */
export const TEAM_SCENARIO = checkoutMeltdown;

/**
 * War Rooms a player may pick to practice (no pay, no experience): whatever their level unlocked,
 * and with Pro every released War Room for their role, hardest first.
 */
export function practiceWarRooms(role: Role, level: Level, entitlements: Entitlements | null, now: number): readonly Scenario[] {
  const pool = role === "infrastructure" ? INFRA_SOLO : [checkoutMeltdown];
  return pool
    .filter((scenario) => isReleasedFor(scenario.releasedAt, entitlements, now) && (isUnlocked(scenario, level) || isPro(entitlements, now)))
    .toReversed();
}
