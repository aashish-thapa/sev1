import { useCallback, useEffect, useReducer, useState } from "react";
import type { Role } from "../domain/incident.ts";
import type { Incident } from "../warroom/incident.ts";
import type { CommsMessage } from "../warroom/scenario.ts";
import { promptFor } from "../warroom/shell/prompt.ts";
import type { TerminalLine } from "../warroom/ui/useIncident.ts";
import { RoomClient, seatOf, type Engineer, type RoomEvents, type RoomStatus, type Seat, type SocketConstructor } from "./client.ts";
import type { Player, Position, Resume, RoomVisibility, ServerMessageOf } from "./protocol.ts";

export type RoomInfo = {
  readonly code: string;
  readonly playerId: string;
  readonly scenarioId: string;
  /** Persist it (e.g. sessionStorage) and pass `seat.resume` to `join` to keep the seat across a page reload. */
  readonly seat: Seat;
};

export type RoomView = {
  readonly status: RoomStatus;
  readonly room: RoomInfo | null;
  readonly players: readonly Player[];
  readonly incident: Incident | null;
  readonly terminal: readonly TerminalLine[];
  /** This player's own commands, for ↑/↓ and tab completion. */
  readonly history: readonly string[];
  readonly comms: readonly CommsMessage[];
  /** What everyone else is running, newest last. */
  readonly activity: readonly ServerMessageOf<"activity">[];
  readonly debrief: ServerMessageOf<"closed">["debrief"] | null;
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
  terminal: [],
  history: [],
  comms: [],
  activity: [],
  debrief: null,
  error: null,
};

type Event = { [Type in keyof RoomEvents]: { readonly type: Type; readonly event: RoomEvents[Type] } }[keyof RoomEvents];

/** A multiplayer war room as React state. `url` is read once; pass `WebSocket` only to substitute the browser's. */
export function useRoom(options: { url: string; WebSocket?: SocketConstructor }) {
  const { url, WebSocket = globalThis.WebSocket } = options;
  const [client] = useState(() => new RoomClient({ url, WebSocket }));
  const [view, dispatch] = useReducer(reduce, INITIAL_VIEW);

  useEffect(() => {
    const forward = <Type extends keyof RoomEvents>(type: Type) =>
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
    ];
    return () => {
      for (const off of unsubscribe) off();
      client.close();
    };
  }, [client]);

  const create = useCallback(
    (scenarioId: string, engineer: Engineer, visibility: RoomVisibility) => client.create({ scenarioId, visibility, ...engineer }),
    [client],
  );
  const join = useCallback(
    (roomCode: string, engineer: Engineer, resume?: Resume) => client.join({ roomCode, resume, ...engineer }),
    [client],
  );
  const leave = useCallback(() => client.leave(), [client]);
  const run = useCallback((line: string) => client.run(line), [client]);
  const declare = useCallback(() => client.declare(), [client]);
  const chat = useCallback((text: string) => client.chat(text), [client]);
  const sendPresence = useCallback((position: Position) => client.presence(position), [client]);

  return { ...view, create, join, leave, run, declare, chat, sendPresence };
}

function reduce(view: RoomView, { type, event }: Event): RoomView {
  switch (type) {
    case "status":
      if (event.status === "left" || event.status === "idle") return { ...INITIAL_VIEW, status: event.status };
      return { ...view, status: event.status, error: event.error ?? view.error };
    case "welcome":
      return {
        ...view,
        room: { code: event.roomCode, playerId: event.playerId, scenarioId: event.scenarioId, seat: seatOf(event) },
        players: event.players,
        comms: event.comms,
        history: event.history,
        terminal: event.isResumed ? view.terminal : [],
        error: null,
      };
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
      return { ...view, debrief: event.debrief };
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
