import type { IncidentCard, Role } from "../domain/incident.ts";
import type { ClusterState } from "./sim/model.ts";

export type CommsMessage = {
  readonly at: number;
  readonly from: string;
  readonly text: string;
  /** Set on lines a teammate typed, so a room can list its chat apart from the incident's traffic. */
  readonly kind?: "chat";
};

export type Postmortem = {
  readonly question: string;
  readonly options: readonly string[];
  readonly answerIndex: number;
  readonly explanation: IncidentCard["explanation"];
  readonly source?: IncidentCard["source"];
};

/** A dependency outside the cluster: shown on the map, never operable. */
export type ExternalService = {
  readonly id: string;
  readonly status: "ok" | "degraded";
  readonly facts: readonly { readonly key: string; readonly value: string }[];
};

/** One role's share of the fix, checked against the final state for the debrief. */
export type TeamPlay = {
  readonly role: Role;
  readonly by: string;
  /** Simulated second the colleague acts. */
  readonly at: number;
  readonly line: string;
  /** What they say in the channel when they've done it. */
  readonly says: string;
};

export type Objective = {
  readonly role: Role;
  readonly label: string;
  readonly isMet: boolean;
};

/** One move of a worked solution: the exact command to run, and in one line why. */
export type SolutionStep = { readonly command: string; readonly why: string };

/**
 * How hard an incident is, matched to the career level that unlocks it (tier = level + 1):
 * 1 guided, one cause, one fix · 2 diagnose · 3 a plausible fix backfires ·
 * 4 the usual fix does nothing · 5 cloud-scale or cross-team.
 */
export type Tier = 1 | 2 | 3 | 4 | 5;

/** One playable live incident: a starting cluster, what "fixed" means, and the story around it. */
export type Scenario = {
  readonly id: string;
  readonly tier: Tier;
  readonly title: string;
  readonly severity: IncidentCard["alert"]["severity"];
  readonly service: string;
  readonly briefing: string;
  /** Roles the incident pages; the first is the incident commander's. */
  readonly roles: readonly Role[];
  /** What each paged role is told when their laptop opens. */
  readonly roleBriefings?: Partial<Record<Role, string>>;
  /** Wall-clock second of day the incident opens at (for log timestamps). */
  readonly opensAtSecondOfDay: number;
  readonly seed: string;
  readonly initialState: () => ClusterState;
  readonly isRootCauseFixed: (state: ClusterState) => boolean;
  /** Lost checkouts that cost one debrief point; scales scoring to the incident's traffic and unavoidable damage. */
  readonly lostCheckoutsPerPoint?: number;
  /** Per-role outcomes beyond the root cause; each unmet one costs points in the debrief. */
  readonly objectives?: (state: ClusterState) => readonly Objective[];
  /**
   * What colleagues do when a solo player can't cover every role: each step is the correct
   * move for one role, made by a named teammate at a realistic moment. The player's own role is never automated.
   */
  readonly teamPlaybook?: readonly TeamPlay[];
  readonly externals: readonly ExternalService[];
  readonly comms: readonly CommsMessage[];
  readonly postmortem: Postmortem;
  /** Two to four nudges, vaguest first. They point at where to look and never give the command. */
  readonly hints: readonly string[];
  /**
   * The worked answer for each role the incident pages: what to look at, the fix, then how to
   * see it worked. Every role in `roles` has steps, and playing them closes the incident well.
   */
  readonly solution: Readonly<Partial<Record<Role, readonly SolutionStep[]>>>;
};

export function clockAt(scenario: Scenario, t: number, withMillis = false, salt = 0): string {
  const total = (((scenario.opensAtSecondOfDay + t) % 86_400) + 86_400) % 86_400;
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  const base = `${hours}:${minutes}:${seconds}`;
  const millis = (((t * 337 + salt * 131) % 1000) + 1000) % 1000;
  return withMillis ? `${base}.${String(millis).padStart(3, "0")}` : base;
}
