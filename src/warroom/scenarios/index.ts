import type { Role } from "../../domain/incident.ts";
import type { Scenario } from "../scenario.ts";
import { checkoutMeltdown } from "./checkout-meltdown.ts";
import { checkoutPoolLeak } from "./checkout-pool-leak.ts";

/** Every live incident the game ships; the app and the room server read this one list. */
export const SCENARIOS: readonly Scenario[] = [checkoutPoolLeak, checkoutMeltdown];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** The incident that pages a solo player of `role`: infra gets the pure infra outage; everyone else the cross-team one. */
export function soloScenarioFor(role: Role): Scenario {
  return role === "infrastructure" ? checkoutPoolLeak : checkoutMeltdown;
}

/** Shared rooms always play the cross-team incident: it's the one nobody can fix alone. */
export const TEAM_SCENARIO = checkoutMeltdown;
