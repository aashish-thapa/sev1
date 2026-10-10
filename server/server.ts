import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  encodeServerMessage,
  MAX_INBOUND_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "../src/multiplayer/protocol.ts";
import type { Logger } from "./log.ts";
import { RoomRegistry } from "./registry.ts";
import type { Connection, Room, RoomTiming } from "./room.ts";
import type { ScenarioCatalog } from "./scenarios.ts";

export type ServerOptions = {
  readonly port: number;
  readonly host?: string;
  /** Null accepts any Origin; browsers always send one, so this is what keeps other sites from opening sockets. */
  readonly allowedOrigins: readonly string[] | null;
  readonly maxRooms: number;
  readonly roomGraceMs: number;
  readonly heartbeatMs: number;
  readonly timing: RoomTiming;
  readonly findScenario: ScenarioCatalog;
  readonly random: () => number;
  readonly logger: Logger;
};

export type RunningServer = {
  readonly port: number;
  close(): Promise<void>;
};

/** Frames past this are cut off by `ws` itself; between it and MAX_INBOUND_BYTES the client gets an error reply instead. */
const HARD_MAX_PAYLOAD = MAX_INBOUND_BYTES * 8;
const GOING_AWAY = 1001;

type Session = { readonly room: Room; readonly playerId: string };

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { logger } = options;
  const registry = new RoomRegistry({
    maxRooms: options.maxRooms,
    roomGraceMs: options.roomGraceMs,
    timing: options.timing,
    random: options.random,
    logger,
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: HARD_MAX_PAYLOAD });
  const http = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rooms: registry.size }));
      return;
    }
    response.writeHead(426, { upgrade: "websocket" }).end();
  });

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = request.headers.origin;
    if (options.allowedOrigins && !(origin && options.allowedOrigins.includes(origin))) {
      logger("warn", "origin_rejected", { origin: origin ?? null });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });

  const awaitingPong = new WeakSet<WebSocket>();
  sockets.on("connection", (socket: WebSocket) => {
    socket.on("pong", () => awaitingPong.delete(socket));
    serve(socket, registry, options);
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (awaitingPong.has(socket)) {
        socket.terminate();
        continue;
      }
      awaitingPong.add(socket);
      socket.ping();
    }
  }, options.heartbeatMs);

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.close(GOING_AWAY, "server shutting down");
      registry.closeAll();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Lifecycle of one socket: parse every frame, route it to the player's room, release the seat on close. */
function serve(socket: WebSocket, registry: RoomRegistry, options: ServerOptions) {
  const { logger } = options;
  const connection: Connection = {
    send: (payload) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    },
    close: (code, reason) => socket.close(code, reason),
  };
  const reply = (message: ServerMessage) => connection.send(encodeServerMessage(message));
  const fail = (code: ErrorCode, message: string) => reply({ type: "error", code, message });
  let session: Session | null = null;

  const enter = (room: Room, request: Parameters<Room["join"]>[0]) => {
    const outcome = room.join(request, connection);
    if (outcome.ok) session = { room, playerId: outcome.playerId };
    else fail(outcome.code, outcome.message);
  };

  const inRoom = (act: (room: Room, playerId: string) => void) => {
    if (session) act(session.room, session.playerId);
    else fail("not_in_room", "Create or join a war room first.");
  };

  const handle = (message: ClientMessage) => {
    switch (message.type) {
      case "ping":
        reply({ type: "pong", nonce: message.nonce });
        return;
      case "create": {
        if (session) return fail("already_in_room", `You are already in room ${session.room.code}.`);
        const scenario = options.findScenario(message.scenarioId);
        if (!scenario) return fail("unknown_scenario", `There is no scenario called ${message.scenarioId}.`);
        const room = registry.create(scenario);
        if (!room) return fail("server_full", "This server is hosting as many war rooms as it can. Try again shortly.");
        return enter(room, { name: message.name, role: message.role });
      }
      case "join": {
        if (session) return fail("already_in_room", `You are already in room ${session.room.code}.`);
        const room = registry.find(message.roomCode);
        if (!room) return fail("room_not_found", `No war room with code ${message.roomCode}.`);
        return enter(room, { name: message.name, role: message.role, resume: message.resume });
      }
      case "leave":
        if (!session) return fail("not_in_room", "You are not in a war room.");
        session.room.leave(session.playerId);
        session = null;
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

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return fail("bad_message", "Send JSON text frames.");
    if (byteLength(data) > MAX_INBOUND_BYTES) return fail("too_large", `Messages are limited to ${MAX_INBOUND_BYTES} bytes.`);
    const parsed = parseClientMessage(decode(data));
    if (!parsed.ok) {
      logger("warn", "message_rejected", { code: parsed.code, room: session?.room.code ?? null });
      return fail(parsed.code, parsed.reason);
    }
    try {
      handle(parsed.message);
    } catch (error) {
      // A bug in the simulation or shell must cost one command, not the process and every room in it.
      logger("error", "message_failed", {
        type: parsed.message.type,
        room: session?.room.code ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      fail("internal", "The server hit an error handling that message.");
    }
  });

  socket.on("close", () => {
    if (session) session.room.detach(session.playerId, connection);
    session = null;
  });

  socket.on("error", (error) => logger("warn", "socket_error", { message: error.message }));
}

function byteLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.length, 0) : data.byteLength;
}

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
}
