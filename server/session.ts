import {
  encodeServerMessage,
  MAX_INBOUND_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type RoomVisibility,
  type ServerMessage,
} from "../src/multiplayer/protocol.ts";
import type { Logger } from "./log.ts";
import type { Connection, JoinRequest, Room } from "./room.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import type { Scenario } from "../src/warroom/scenario.ts";

/** Where a socket's create/join lands: every room in a Node process, or the single room a Durable Object holds. */
export interface RoomDirectory {
  /** Null when no room can be opened here (capacity, or this host already holds its room). */
  create(scenario: Scenario, visibility: RoomVisibility): Room | null;
  find(code: string): Room | undefined;
}

export type SessionOptions = {
  readonly connection: Connection;
  readonly rooms: RoomDirectory;
  readonly findScenario: ScenarioCatalog;
  readonly logger: Logger;
};

/** What a transport hands the session: each text frame, and the socket going away. */
export type Session = {
  receive(text: string, byteLength: number): void;
  end(): void;
};

type Seated = { readonly room: Room; readonly playerId: string };

/** One socket's conversation with the rooms: parse every frame, route it to the player's room, release the seat on close. */
export function openSession({ connection, rooms, findScenario, logger }: SessionOptions): Session {
  const reply = (message: ServerMessage) => connection.send(encodeServerMessage(message));
  const fail = (code: ErrorCode, message: string) => reply({ type: "error", code, message });
  let seated: Seated | null = null;

  const enter = (room: Room, request: JoinRequest) => {
    const outcome = room.join(request, connection);
    if (outcome.ok) seated = { room, playerId: outcome.playerId };
    else fail(outcome.code, outcome.message);
  };

  const inRoom = (act: (room: Room, playerId: string) => void) => {
    if (seated) act(seated.room, seated.playerId);
    else fail("not_in_room", "Create or join a war room first.");
  };

  const handle = (message: ClientMessage) => {
    switch (message.type) {
      case "ping":
        reply({ type: "pong", nonce: message.nonce });
        return;
      case "create": {
        if (seated) return fail("already_in_room", `You are already in room ${seated.room.code}.`);
        const scenario = findScenario(message.scenarioId);
        if (!scenario) return fail("unknown_scenario", `There is no scenario called ${message.scenarioId}.`);
        const room = rooms.create(scenario, message.visibility);
        if (!room) return fail("server_full", "This server is hosting as many war rooms as it can. Try again shortly.");
        return enter(room, { name: message.name, role: message.role });
      }
      case "join": {
        if (seated) return fail("already_in_room", `You are already in room ${seated.room.code}.`);
        const room = rooms.find(message.roomCode);
        if (!room) return fail("room_not_found", `No war room with code ${message.roomCode}.`);
        return enter(room, { name: message.name, role: message.role, resume: message.resume });
      }
      case "leave":
        if (!seated) return fail("not_in_room", "You are not in a war room.");
        seated.room.leave(seated.playerId);
        seated = null;
        return;
      case "presence":
        return inRoom((room, playerId) => room.presence(playerId, { x: message.x, z: message.z, yaw: message.yaw }));
      case "command":
        return inRoom((room, playerId) => room.command(playerId, message.line));
      case "declare":
        return inRoom((room, playerId) => room.declare(playerId));
      case "chat":
        return inRoom((room, playerId) => room.chat(playerId, message.text));
    }
  };

  return {
    receive(text, byteLength) {
      if (byteLength > MAX_INBOUND_BYTES) return fail("too_large", `Messages are limited to ${MAX_INBOUND_BYTES} bytes.`);
      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        logger("warn", "message_rejected", { code: parsed.code, room: seated?.room.code ?? null });
        return fail(parsed.code, parsed.reason);
      }
      try {
        handle(parsed.message);
      } catch (error) {
        // A bug in the simulation or shell must cost one command, not the host and every room on it.
        logger("error", "message_failed", {
          type: parsed.message.type,
          room: seated?.room.code ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
        fail("internal", "The server hit an error handling that message.");
      }
    },
    end() {
      if (seated) seated.room.detach(seated.playerId, connection);
      seated = null;
    },
  };
}
