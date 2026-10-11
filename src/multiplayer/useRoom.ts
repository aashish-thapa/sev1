import { useCallback, useEffect, useReducer, useState } from "react";
import type { Role } from "../domain/incident.ts";
import type { Incident } from "../warroom/incident.ts";
import type { CommsMessage } from "../warroom/scenario.ts";
import { promptFor } from "../warroom/shell/prompt.ts";
import type { TerminalLine } from "../warroom/ui/useIncident.ts";
import { RoomClient, seatOf, type Engineer, type RoomEvents, type RoomStatus, type Seat, type SocketConstructor } from "./client.ts";
import type { Team } from "../warroom/versus.ts";
import type { Player, Position, Resume, RoomMode, RoomPhase, RoomVisibility, ServerMessageOf, Signal } from "./protocol.ts";

export type RoomInfo = {
  readonly code: string;
  readonly playerId: string;
  readonly scenarioId: string;
  /** Persist it (e.g. sessionStorage) and pass `seat.resume` to `join` to keep the seat across a page reload. */
  readonly seat: Seat;
  /** This player's side in a versus match; null in a co-op room. */
  readonly team: Team | null;
};

export type RoomView = {
  readonly status: RoomStatus;
  readonly room: RoomInfo | null;
  readonly players: readonly Player[];
  readonly incident: Incident | null;
  /** "quiet" in a company office until the pager goes off; ordinary rooms are an incident from the start. */
  readonly phase: RoomPhase;
  readonly terminal: readonly TerminalLine[];
  /** This player's own commands, for ↑/↓ and tab completion. */
  readonly history: readonly string[];
  readonly comms: readonly CommsMessage[];
  /** What everyone else is running, newest last. */
  readonly activity: readonly ServerMessageOf<"activity">[];
  readonly debrief: ServerMessageOf<"closed">["debrief"] | null;
  /** What each engineer did, once the incident has closed. */
  readonly scorecard: ServerMessageOf<"closed">["scorecard"];
  /** A versus match's latest standings; null in a co-op room. */
  readonly match: Omit<ServerMessageOf<"match">, "type"> | null;
  /** The last error the server reported; a failed handshake also lands here. */
  readonly error: ServerMessageOf<"error"> | null;
};

const SCROLLBACK_LIMIT = 400;
const ACTIVITY_LIMIT = 50;

const INITIAL_VIEW: RoomView = {
  status: "idle",
  room: null,
  players: [],
  incident: null,
  phase: "incident",
  terminal: [],
  history: [],
  comms: [],
  activity: [],
  debrief: null,
  scorecard: [],
  match: null,
  error: null,
};

/** Events that change what the room shows; voice signals bypass state and go straight to their listener. */
type StateEvent = Exclude<keyof RoomEvents, "signal">;
type Event = { [Type in StateEvent]: { readonly type: Type; readonly event: RoomEvents[Type] } }[StateEvent];

/** A multiplayer war room as React state. `url` is read once; pass `WebSocket` only to substitute the browser's. */
export function useRoom(options: { url: string; WebSocket?: SocketConstructor }) {
  const { url, WebSocket = globalThis.WebSocket } = options;
  const [client] = useState(() => new RoomClient({ url, WebSocket }));
  const [view, dispatch] = useReducer(reduce, INITIAL_VIEW);

  useEffect(() => {
    const forward = <Type extends StateEvent>(type: Type) =>
      client.on(type, (event) => dispatch({ type, event } as Event));
    const unsubscribe = [
      forward("status"),
      forward("welcome"),
      forward("incident"),
      forward("players"),
      forward("presence"),
      forward("terminal"),
      forward("activity"),
      forward("comms"),
      forward("error"),
      forward("closed"),
      forward("phase"),
      forward("match"),
    ];
    return () => {
      for (const off of unsubscribe) off();
      client.close();
    };
  }, [client]);

  const create = useCallback(
    (scenarioId: string, engineer: Engineer, visibility: RoomVisibility, mode: RoomMode = "coop") => client.create({ scenarioId, visibility, mode, ...engineer }),
    [client],
  );
  const join = useCallback(
    (roomCode: string, engineer: Engineer, resume?: Resume) => client.join({ roomCode, resume, ...engineer }),
    [client],
  );
  const leave = useCallback(() => client.leave(), [client]);
  const run = useCallback((line: string) => client.run(line), [client]);
  const declare = useCallback(() => client.declare(), [client]);
  const page = useCallback(() => client.page(), [client]);
  const chat = useCallback((text: string) => client.chat(text), [client]);
  const sendPresence = useCallback((position: Position) => client.presence(position), [client]);
  const sendSignal = useCallback((to: string, signal: Signal) => client.signal(to, signal), [client]);
  const onSignal = useCallback(
    (listener: (from: string, signal: Signal) => void) => client.on("signal", (message) => listener(message.from, message.signal)),
    [client],
  );
  const announceMic = useCallback((isMicOn: boolean) => client.voice(isMicOn), [client]);

  return { ...view, create, join, leave, run, declare, page, chat, sendPresence, sendSignal, onSignal, announceMic };
}

function reduce(view: RoomView, { type, event }: Event): RoomView {
  switch (type) {
    case "status":
      if (event.status === "left" || event.status === "idle") return { ...INITIAL_VIEW, status: event.status };
      return { ...view, status: event.status, error: event.error ?? view.error };
    case "welcome":
      return {
        ...view,
        room: { code: event.roomCode, playerId: event.playerId, scenarioId: event.scenarioId, seat: seatOf(event), team: event.team },
        players: event.players,
        comms: event.comms,
        history: event.history,
        terminal: event.isResumed ? view.terminal : [],
        phase: event.phase,
        error: null,
      };
    case "phase":
      // A new incident (or a quiet office) starts every laptop clean; chat history stays. The scorecard
      // outlives the quiet that follows a close, since players read it after their postmortem.
      return { ...view, phase: event.phase, terminal: [], activity: [], debrief: null, scorecard: event.phase === "incident" ? [] : view.scorecard };
    case "incident":
      return { ...view, incident: event };
    case "players":
      return { ...view, players: event.players };
    case "presence":
      return {
        ...view,
        players: view.players.map((player) => (player.id === event.playerId ? { ...player, position: event.position } : player)),
      };
    case "terminal":
      return appendTerminal(view, event);
    case "activity":
      return { ...view, activity: [...view.activity, event].slice(-ACTIVITY_LIMIT) };
    case "comms":
      return { ...view, comms: [...view.comms, event.message] };
    case "error":
      return { ...view, error: event };
    case "closed":
      return { ...view, debrief: event.debrief, scorecard: event.scorecard };
    case "match":
      return { ...view, match: { stage: event.stage, lanes: event.lanes } };
  }
}

/** The role this client joined with — the server lists us among the players. */
function myRole(view: RoomView): Role {
  return view.players.find((player) => player.id === view.room?.playerId)?.role ?? "infrastructure";
}

function appendTerminal(view: RoomView, result: ServerMessageOf<"terminal">): RoomView {
  const trimmed = result.line.trim();
  const history = trimmed ? [...view.history, trimmed] : view.history;
  if (result.isClearScreen) return { ...view, terminal: [], history };
  const nextId = (view.terminal.at(-1)?.id ?? -1) + 1;
  const lines: TerminalLine[] = [
    { id: nextId, text: `${promptFor(myRole(view))} ${result.line}`, tone: "input" },
    ...result.output.map((line, index) => ({ id: nextId + 1 + index, ...line })),
  ];
  return { ...view, terminal: [...view.terminal, ...lines].slice(-SCROLLBACK_LIMIT), history };
}
