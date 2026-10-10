import { createContext, useContext } from "react";
import type { Role } from "../../domain/incident.ts";
import type { SpendOutcome } from "../../domain/purchases.ts";
import type { Scenario } from "../scenario.ts";

/** What the laptop's Help tab needs for the current run: whose steps to show, and how to pay for them. */
export type IncidentHelp = {
  readonly scenario: Scenario;
  readonly role: Role;
  /** Epoch ms this run began; one purchase per run. */
  readonly runStartedAt: number;
  buy(): SpendOutcome;
};

export const IncidentHelpContext = createContext<IncidentHelp | null>(null);

export function useIncidentHelp(): IncidentHelp | null {
  return useContext(IncidentHelpContext);
}
