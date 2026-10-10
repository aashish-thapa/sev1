import type { Role } from "../../domain/incident.ts";
import type { Scenario } from "../scenario.ts";
import { checkoutMeltdown } from "./checkout-meltdown.ts";
import { checkoutPoolLeak } from "./checkout-pool-leak.ts";
import { ordersIndexInvalid } from "./orders-index-invalid.ts";

/** Every live incident the game ships; the app and the room server read this one list. */
export const SCENARIOS: readonly Scenario[] = [checkoutPoolLeak, ordersIndexInvalid, checkoutMeltdown];

/** Infra's own outages, handed out in turn so a solo SRE doesn't see the same page every shift. */
const INFRA_SOLO: readonly Scenario[] = [checkoutPoolLeak, ordersIndexInvalid];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/**
 * The incident that pages a solo player of `role`: infra gets one of its pure infra outages
 * (`rotation`, e.g. War Rooms played so far, picks which); everyone else the cross-team one.
 */
export function soloScenarioFor(role: Role, rotation = 0): Scenario {
  if (role !== "infrastructure") return checkoutMeltdown;
  const turn = ((Math.trunc(rotation) % INFRA_SOLO.length) + INFRA_SOLO.length) % INFRA_SOLO.length;
  return INFRA_SOLO[turn];
}

/** Shared rooms always play the cross-team incident: it's the one nobody can fix alone. */
export const TEAM_SCENARIO = checkoutMeltdown;
