import type { Level } from "../../domain/career.ts";
import { isPro, isReleasedFor, type Entitlements } from "../../domain/entitlements.ts";
import type { Role } from "../../domain/incident.ts";
import type { Scenario } from "../scenario.ts";
import { botFloodSingleIp } from "./bot-flood-single-ip.ts";
import { checkoutMeltdown } from "./checkout-meltdown.ts";
import { checkoutPoolLeak } from "./checkout-pool-leak.ts";
import { crashOnCheckout } from "./crash-on-checkout.ts";
import { oomAfterDeploy } from "./oom-after-deploy.ts";
import { ordersIndexInvalid } from "./orders-index-invalid.ts";
import { scaledToZero } from "./scaled-to-zero.ts";

/** Every live incident the game ships; the app and the room server read this one list. */
export const SCENARIOS: readonly Scenario[] = [scaledToZero, crashOnCheckout, oomAfterDeploy, checkoutPoolLeak, ordersIndexInvalid, checkoutMeltdown, botFloodSingleIp];

/** Each role's own War Rooms, easiest first. A role's ladder grows as its incidents are written. */
const LADDERS: Readonly<Record<Role, readonly Scenario[]>> = {
  infrastructure: [scaledToZero, crashOnCheckout, oomAfterDeploy, checkoutPoolLeak, ordersIndexInvalid],
  frontend: [],
  mobile: [],
  security: [botFloodSingleIp],
  data: [],
};

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** A War Room opens at the career level one below its tier: interns get tier 1, staff everything. */
export function isUnlocked(scenario: Scenario, level: Level): boolean {
  return scenario.tier <= level + 1;
}

/** A role's ladder and the cross-team incident, easiest first. */
function warRoomsFor(role: Role): readonly Scenario[] {
  return [...LADDERS[role], checkoutMeltdown];
}

/**
 * Solo War Rooms a player of `role` at `level` may play, hardest first, for a replay picker. When
 * the level unlocks none of them (a ladder still empty, or one whose easiest rung is out of reach),
 * the cross-team incident stands in at any level, so solo play always has an incident.
 */
export function unlockedWarRooms(role: Role, level: Level): readonly Scenario[] {
  const unlocked = warRoomsFor(role).filter((scenario) => isUnlocked(scenario, level)).toReversed();
  return unlocked.length > 0 ? unlocked : [checkoutMeltdown];
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

/** The cross-team incident: every room may play it, and a new room starts on it. */
export const TEAM_SCENARIO = checkoutMeltdown;

/** War Rooms a host may open a room on: the cross-team incident first, whatever their level, then what they've unlocked. */
export function roomWarRooms(role: Role, level: Level): readonly Scenario[] {
  return [TEAM_SCENARIO, ...unlockedWarRooms(role, level).filter((scenario) => scenario !== TEAM_SCENARIO)];
}

/**
 * War Rooms a player may pick to practice (no pay, no experience): whatever their level unlocked,
 * and with Pro every released War Room for their role, hardest first.
 */
export function practiceWarRooms(role: Role, level: Level, entitlements: Entitlements | null, now: number): readonly Scenario[] {
  const pool = isPro(entitlements, now) ? warRoomsFor(role).toReversed() : unlockedWarRooms(role, level);
  return pool.filter((scenario) => isReleasedFor(scenario.releasedAt, entitlements, now));
}
