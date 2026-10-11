import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { encodeServerMessage, MAX_INBOUND_BYTES, PUBLIC_ROOMS_PATH, type PublicRoomList } from "../src/multiplayer/protocol.ts";
import type { Logger } from "./log.ts";
import { LocalMatchmaker } from "./local-matchmaker.ts";
import { RoomRegistry } from "./registry.ts";
import type { Connection, RoomTiming } from "./room.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import { openSession } from "./session.ts";

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

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { logger } = options;
  // Outcomes reach rooms through the registry, which needs the matchmaker first: the lookup runs only once both exist.
  const matchmaking = new LocalMatchmaker((code, outcome) => registry.find(code)?.onMatchmaking?.(outcome));
  const registry = new RoomRegistry({
    maxRooms: options.maxRooms,
    roomGraceMs: options.roomGraceMs,
    timing: options.timing,
    random: options.random,
    logger,
    now: Date.now,
    matchmaking,
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: HARD_MAX_PAYLOAD });
  const http = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rooms: registry.size }));
      return;
    }
    if (request.method === "GET" && request.url === PUBLIC_ROOMS_PATH) {
      const list: PublicRoomList = { rooms: registry.listPublic() };
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(list));
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
      matchmaking.dispose();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Bridges one `ws` socket to a room session; framing and lifecycle only. */
function serve(socket: WebSocket, registry: RoomRegistry, options: ServerOptions) {
  const connection: Connection = {
    send: (payload) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    },
    close: (code, reason) => socket.close(code, reason),
  };
  const session = openSession({ connection, rooms: registry, findScenario: options.findScenario, logger: options.logger });

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      connection.send(encodeServerMessage({ type: "error", code: "bad_message", message: "Send JSON text frames." }));
      return;
    }
    const length = byteLength(data);
    // Oversized frames are refused by the session before decoding costs anything.
    session.receive(length > MAX_INBOUND_BYTES ? "" : decode(data), length);
  });

  socket.on("close", () => session.end());
  socket.on("error", (error) => options.logger("warn", "socket_error", { message: error.message }));
}

function byteLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.length, 0) : data.byteLength;
}

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
}
