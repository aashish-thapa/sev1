import type { Role } from "../domain/incident.ts";
import type { Incident } from "../warroom/incident.ts";
import { backoffDelay, RECONNECT_BACKOFF, type BackoffPolicy } from "./backoff.ts";
import type { Team } from "../warroom/versus.ts";
import { applyFrame } from "./frame.ts";
import {
  encodeClientMessage,
  parseServerMessage,
  type ClientMessageInput,
  type Position,
  type Resume,
  type RoomMode,
  type RoomVisibility,
  type ServerMessage,
  type Signal,
  type ServerMessageOf,
  ROOM_CODE_QUERY,
} from "./protocol.ts";

/** The slice of the WebSocket API the client uses; both the browser's WebSocket and `ws` satisfy it. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly code: number }) => void): void;
};

export type SocketConstructor = new (url: string) => SocketLike;

/**
 * idle → connecting → joined ⇄ reconnecting; `failed` when the server turned the handshake down or
 * reconnects ran out; `left` after `leave()`.
 */
export type RoomStatus = "idle" | "connecting" | "joined" | "reconnecting" | "failed" | "left";

export type Seat = { readonly roomCode: string; readonly playerId: string; readonly resume: Resume };

export type RoomEvents = {
  readonly status: { readonly status: RoomStatus; readonly error: ServerMessageOf<"error"> | null };
  readonly welcome: ServerMessageOf<"welcome">;
  readonly incident: Incident;
  readonly players: ServerMessageOf<"players">;
  readonly presence: ServerMessageOf<"presence">;
  readonly terminal: ServerMessageOf<"terminal">;
  readonly activity: ServerMessageOf<"activity">;
  readonly comms: ServerMessageOf<"comms">;
  readonly error: ServerMessageOf<"error">;
  readonly closed: ServerMessageOf<"closed">;
  readonly signal: ServerMessageOf<"signal">;
  readonly phase: ServerMessageOf<"phase">;
  readonly match: ServerMessageOf<"match">;
  /** Matchmaking moved us: the client is already rejoining at `roomCode`; views should start clean. */
  readonly move: ServerMessageOf<"move">;
};

export type RoomClientOptions = {
  readonly url: string;
  readonly WebSocket: SocketConstructor;
  readonly backoff?: BackoffPolicy;
  readonly random?: () => number;
  /** Floor for the gap between presence updates; the latest position always goes out eventually. */
  readonly presenceIntervalMs?: number;
  /** How often to ping; silence for two intervals counts as a dead connection. */
  readonly keepaliveMs?: number;
};

export function seatOf(welcome: ServerMessageOf<"welcome">): Seat {
  return { roomCode: welcome.roomCode, playerId: welcome.playerId, resume: { playerId: welcome.playerId, token: welcome.resumeToken } };
}

type Intent =
  | ({ readonly kind: "create"; readonly scenarioId: string; readonly visibility: RoomVisibility; readonly mode?: RoomMode } & Engineer)
  | ({ readonly kind: "join"; readonly roomCode: string; readonly resume?: Resume; readonly team?: Team } & Engineer);

/** Who takes the seat: shown to teammates by name, role, the badge and the body they chose. */
export type Engineer = { readonly name: string; readonly role: Role; readonly badge: string | null; readonly avatar?: string | null };

type Listeners = { [Type in keyof RoomEvents]: Set<(event: RoomEvents[Type]) => void> };

const OPEN = 1;
const NORMAL_CLOSURE = 1000;
const OUTBOX_LIMIT = 64;
/** 4 Hz: smooth enough with client-side easing, and each inbound message counts against the free hosting budget. */
const DEFAULT_PRESENCE_INTERVAL_MS = 250;
const DEFAULT_KEEPALIVE_MS = 15_000;

/** One player's connection to a war room. Survives dropped sockets by rejoining the same seat. */
export class RoomClient {
  private readonly options: Required<RoomClientOptions>;
  private readonly listeners: Listeners = {
    status: new Set(),
    welcome: new Set(),
    incident: new Set(),
    players: new Set(),
    presence: new Set(),
    terminal: new Set(),
    activity: new Set(),
    comms: new Set(),
    error: new Set(),
    closed: new Set(),
    signal: new Set(),
    phase: new Set(),
    match: new Set(),
    move: new Set(),
  };
  /** Null until voice starts; resent on every new seat, since the server forgets it with the old one. */
  private voiceHeld: boolean | null = null;
  private socket: SocketLike | null = null;
  private intent: Intent | null = null;
  private seatHeld: Seat | null = null;
  private incidentHeld: Incident | null = null;
  private statusHeld: RoomStatus = "idle";
  private attempt = 0;
  private outbox: ClientMessageInput[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeardAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: Position | null = null;

  constructor(options: RoomClientOptions) {
    this.options = {
      backoff: RECONNECT_BACKOFF,
      random: Math.random,
      presenceIntervalMs: DEFAULT_PRESENCE_INTERVAL_MS,
      keepaliveMs: DEFAULT_KEEPALIVE_MS,
      ...options,
    };
  }

  get status(): RoomStatus {
    return this.statusHeld;
  }

  /** Set once welcomed; persist it (e.g. sessionStorage) to survive a page reload via `join({ resume })`. */
  get seat(): Seat | null {
    return this.seatHeld;
  }

  get incident(): Incident | null {
    return this.incidentHeld;
  }

  on<Type extends keyof RoomEvents>(type: Type, listener: (event: RoomEvents[Type]) => void): () => void {
    const set = this.listeners[type];
    set.add(listener);
    return () => set.delete(listener);
  }

  /** `mode` defaults to co-op on the server. */
  create(request: { scenarioId: string; visibility: RoomVisibility; mode?: RoomMode } & Engineer) {
    this.begin({ kind: "create", ...request });
  }

  /** `team` asks for a side in a versus match; the server falls back to its own pick when it's full. */
  join(request: { roomCode: string; resume?: Resume; team?: Team } & Engineer) {
    this.begin({ kind: "join", ...request });
  }

  run(line: string) {
    this.send({ type: "command", line });
  }

  declare() {
    this.send({ type: "declare" });
  }

  /** In a quiet office: page the room now instead of waiting for the pager. */
  page() {
    this.send({ type: "page" });
  }

  chat(text: string) {
    this.send({ type: "chat", text });
  }

  /** Joins the room's voice calls and says whether the mic is open. */
  voice(isMicOn: boolean) {
    this.voiceHeld = isMicOn;
    this.send({ type: "voice", isMicOn });
  }

  /** A voice handshake step for one teammate. Dropped while disconnected: a stale handshake is worse than none. */
  signal(to: string, signal: Signal) {
    if (this.statusHeld === "joined" && this.socket?.readyState === OPEN) this.transmit({ type: "signal", to, signal });
  }

  /** Throttled: call it every frame if convenient. */
  presence(position: Position) {
    this.pendingPresence = position;
    if (!this.presenceTimer) this.flushPresence();
  }

  /** Gives the seat up now instead of after the server's grace period. */
  leave() {
    if (this.statusHeld === "joined") this.transmit({ type: "leave" });
    this.teardown();
    this.setStatus("left");
  }

  /** Drops the connection without giving up the seat; the client can be reused afterwards. */
  close() {
    this.teardown();
    this.setStatus("idle");
  }

  private begin(intent: Intent) {
    if (this.intent) throw new Error(`RoomClient is already ${this.statusHeld}; call leave() or close() first`);
    this.intent = intent;
    this.attempt = 0;
    this.connect();
  }

  private connect() {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = new this.options.WebSocket(this.socketUrl());
    this.socket = socket;
    const isCurrent = () => socket === this.socket;
    socket.addEventListener("open", () => {
      if (isCurrent()) this.hello();
    });
    socket.addEventListener("message", (event) => {
      if (isCurrent()) this.receive(event.data);
    });
    socket.addEventListener("close", () => {
      if (isCurrent()) this.lost();
    });
    // A close event always follows, and reconnecting is handled there; `ws` throws on unheard errors.
    socket.addEventListener("error", () => {});
  }

  /** Names the room up front when it's known, so a host can route the socket before the first message. */
  private socketUrl(): string {
    const code = this.seatHeld?.roomCode ?? (this.intent?.kind === "join" ? this.intent.roomCode : null);
    if (!code) return this.options.url;
    const url = new URL(this.options.url);
    url.searchParams.set(ROOM_CODE_QUERY, code);
    return url.toString();
  }

  private hello() {
    const intent = this.intent;
    if (!intent) return;
    this.lastHeardAt = performance.now();
    const seat = this.seatHeld;
    if (seat) {
      this.transmit({ type: "join", roomCode: seat.roomCode, name: intent.name, role: intent.role, badge: intent.badge, avatar: intent.avatar ?? null, resume: seat.resume });
    } else if (intent.kind === "create") {
      this.transmit({ type: "create", scenarioId: intent.scenarioId, name: intent.name, role: intent.role, badge: intent.badge, avatar: intent.avatar ?? null, visibility: intent.visibility, mode: intent.mode });
    } else {
      this.transmit({ type: "join", roomCode: intent.roomCode, name: intent.name, role: intent.role, badge: intent.badge, avatar: intent.avatar ?? null, resume: intent.resume, team: intent.team });
    }
  }

  private receive(data: unknown) {
    this.lastHeardAt = performance.now();
    const parsed = typeof data === "string" ? parseServerMessage(data) : null;
    // A frame we can't read may have been a state delta, so our incident could be stale: resync from scratch.
    if (!parsed?.ok) return this.reconnectNow();
    this.dispatch(parsed.message);
  }

  private dispatch(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        this.seatHeld = seatOf(message);
        this.attempt = 0;
        this.setStatus("joined");
        this.startKeepalive();
        this.emit("welcome", message);
        this.flushOutbox();
        if (this.voiceHeld !== null) this.transmit({ type: "voice", isMicOn: this.voiceHeld });
        return;
      case "state":
        return this.applyState(message);
      case "error":
        if (this.statusHeld !== "joined") return this.fail(message);
        return this.emit("error", message);
      case "pong":
        return;
      case "move":
        return this.moveTo(message);
      default:
        return this.emit(message.type, message);
    }
  }

  private applyState(message: ServerMessageOf<"state">) {
    try {
      this.incidentHeld = applyFrame(this.incidentHeld, message.frame);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return this.reconnectNow();
    }
    this.emit("incident", this.incidentHeld);
  }

  /** The server turned the handshake down (unknown room, room full…); retrying would only repeat that. */
  private fail(error: ServerMessageOf<"error">) {
    this.teardown();
    this.setStatus("failed", error);
  }

  private lost() {
    this.socket = null;
    this.stopKeepalive();
    if (!this.intent) return;
    if (this.attempt >= this.options.backoff.maxAttempts) {
      this.teardown();
      this.setStatus("failed");
      return;
    }
    const delay = backoffDelay(this.attempt, this.options.backoff, this.options.random);
    this.attempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Abandons the current socket without waiting for its close event, which a dead TCP link may never deliver. */
  private reconnectNow() {
    const socket = this.socket;
    this.socket = null;
    socket?.close(NORMAL_CLOSURE, "client resync");
    this.lost();
  }

  private send(message: ClientMessageInput) {
    if (this.statusHeld === "joined" && this.socket?.readyState === OPEN) {
      this.transmit(message);
      return;
    }
    // Only the newest position matters, so a backlog of presence updates collapses to one.
    if (message.type === "presence") this.outbox = this.outbox.filter((queued) => queued.type !== "presence");
    this.outbox = [...this.outbox, message].slice(-OUTBOX_LIMIT);
  }

  private transmit(message: ClientMessageInput) {
    this.socket?.send(encodeClientMessage(message));
  }

  private flushOutbox() {
    const queued = this.outbox;
    this.outbox = [];
    for (const message of queued) this.transmit(message);
  }

  private flushPresence() {
    const position = this.pendingPresence;
    if (!position) {
      this.presenceTimer = null;
      return;
    }
    this.pendingPresence = null;
    this.send({ type: "presence", ...position });
    this.presenceTimer = setTimeout(() => this.flushPresence(), this.options.presenceIntervalMs);
  }

  private startKeepalive() {
    this.stopKeepalive();
    const { keepaliveMs } = this.options;
    this.keepaliveTimer = setInterval(() => {
      if (performance.now() - this.lastHeardAt > keepaliveMs * 2) this.reconnectNow();
      else this.transmit({ type: "ping" });
    }, keepaliveMs);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /** Gives up this seat and takes one on `team` in the room matchmaking paired us with. */
  private moveTo(move: ServerMessageOf<"move">) {
    const intent = this.intent;
    if (!intent) return;
    const engineer: Engineer = { name: intent.name, role: intent.role, badge: intent.badge, avatar: intent.avatar };
    this.transmit({ type: "leave" });
    this.teardown();
    this.emit("move", move);
    this.begin({ kind: "join", roomCode: move.roomCode, team: move.team, ...engineer });
  }

  private teardown() {
    const socket = this.socket;
    this.socket = null;
    this.intent = null;
    this.seatHeld = null;
    this.incidentHeld = null;
    this.outbox = [];
    this.pendingPresence = null;
    this.stopKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.reconnectTimer = null;
    this.presenceTimer = null;
    socket?.close(NORMAL_CLOSURE, "client left");
  }

  private setStatus(status: RoomStatus, error: ServerMessageOf<"error"> | null = null) {
    if (status === this.statusHeld && error === null) return;
    this.statusHeld = status;
    this.emit("status", { status, error });
  }

  private emit<Type extends keyof RoomEvents>(type: Type, event: RoomEvents[Type]) {
    for (const listener of this.listeners[type]) listener(event);
  }
}
