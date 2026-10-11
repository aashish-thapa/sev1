import { useCallback, useEffect, useReducer } from "react";
import { advance, declareResolved, openIncident, type Incident, type IncidentNotice } from "../incident.ts";
import { applyTeamwork } from "../teamwork.ts";
import { laptopBanner, promptFor } from "./laptop-identity.ts";
import type { CommsMessage, Scenario } from "../scenario.ts";
import { completeLine, runLine } from "../shell/shell.ts";
import type { OutputTone } from "../shell/types.ts";
import type { Role } from "../../domain/incident.ts";

export type TerminalLine = { readonly id: number; readonly text: string; readonly tone: OutputTone | "input" };

type State = {
  readonly incident: Incident;
  /** Playbook steps colleagues have already played in solo mode. */
  readonly teamworkDone: ReadonlySet<number>;
  readonly terminal: readonly TerminalLine[];
  readonly history: readonly string[];
  readonly notices: readonly CommsMessage[];
  readonly nextLineId: number;
};

type Action = { type: "tick" } | { type: "run"; line: string } | { type: "declare" };

const LIVE_TICK_MS = 1000;
/** Monitoring fast-forwards: ten simulated minutes play out in about thirty seconds. */
const MONITORING_TICK_MS = 50;
const SCROLLBACK_LIMIT = 400;

/** `isRunning` false keeps the clock stopped — the office before the pager goes off. */
export function useIncident(scenario: Scenario, role: Role, isRunning = true) {
  const [state, dispatch] = useReducer((current: State, action: Action) => reduce(current, action, scenario, role), { scenario, role }, initialState);
  const phase = state.incident.phase.name;

  useEffect(() => {
    if (phase === "closed" || !isRunning) return;
    const timer = window.setInterval(() => dispatch({ type: "tick" }), phase === "monitoring" ? MONITORING_TICK_MS : LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, phase]);

  const run = useCallback((line: string) => dispatch({ type: "run", line }), []);
  const declare = useCallback(() => dispatch({ type: "declare" }), []);
  const complete = useCallback(
    (line: string) => completeLine(line, { cluster: state.incident.cluster, scenario, history: state.history, role }),
    [role, scenario, state.history, state.incident.cluster],
  );

  const comms = [...scenario.comms.filter((message) => message.at <= state.incident.cluster.t), ...state.notices].sort(
    (left, right) => left.at - right.at,
  );

  return { incident: state.incident, terminal: state.terminal, history: state.history, comms, run, declare, complete };
}

function initialState({ scenario, role }: { scenario: Scenario; role: Role }): State {
  const banner = laptopBanner(scenario, role);
  return {
    incident: openIncident(scenario),
    teamworkDone: new Set(),
    terminal: banner.map((text, id) => ({ id, text, tone: "dim" as const })),
    history: [],
    notices: [],
    nextLineId: banner.length,
  };
}

function reduce(state: State, action: Action, scenario: Scenario, role: Role): State {
  switch (action.type) {
    case "tick": {
      const advanced = advance(state.incident, scenario);
      const team = applyTeamwork(advanced.incident, scenario, new Set([role]), state.teamworkDone);
      const notices = [...state.notices, ...(advanced.notice ? [commsFor(advanced.notice, team.incident)] : []), ...team.messages];
      return { ...state, incident: team.incident, teamworkDone: team.done, notices };
    }
    case "declare": {
      const { incident, notice } = declareResolved(state.incident, scenario);
      const message: CommsMessage | null = notice
        ? commsFor(notice, incident)
        : { at: incident.cluster.t, from: "PagerDuty", text: "Marked resolved by you. Monitoring for 10 minutes before closing." };
      return { ...state, incident, notices: message ? [...state.notices, message] : state.notices };
    }
    case "run": {
      const trimmed = action.line.trim();
      const echo: TerminalLine = { id: state.nextLineId, text: `${promptFor(role)} ${action.line}`, tone: "input" };
      const result = runLine(trimmed, { cluster: state.incident.cluster, scenario, history: state.history, role });
      const output = result.output.map((line, index) => ({ id: state.nextLineId + 1 + index, ...line }));
      const terminal = result.clearScreen ? [] : [...state.terminal, echo, ...output].slice(-SCROLLBACK_LIMIT);
      return {
        ...state,
        incident: result.cluster ? { ...state.incident, cluster: result.cluster } : state.incident,
        terminal,
        history: trimmed ? [...state.history, trimmed] : state.history,
        nextLineId: state.nextLineId + 1 + output.length,
      };
    }
  }
}

function commsFor(notice: IncidentNotice, incident: Incident): CommsMessage {
  const percent = (rate: number) => `${Math.round(rate * 100)}%`;
  const at = incident.cluster.t;
  switch (notice.kind) {
    case "refused":
      return { at, from: "PagerDuty", text: `Can’t resolve: ${notice.label} is still ${percent(notice.rate)}.` };
    case "reopened":
      return {
        at,
        from: "PagerDuty",
        text: `Re-triggered — ${notice.label} back at ${percent(notice.rate)}${notice.wasRollingOut ? " while the rollout was still replacing pods" : ""}. The incident is open again.`,
      };
    case "closed":
      return { at, from: "PagerDuty", text: "Quiet for 10 minutes. Incident closed — time for the postmortem." };
  }
}
