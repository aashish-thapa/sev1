import type { Role } from "../src/domain/incident.ts";
import { encodeFrame } from "../src/multiplayer/frame.ts";
import {
  encodeServerMessage,
  MAX_PLAYERS_PER_ROOM,
  type ErrorCode,
  type Player,
  type Position,
  type Resume,
  type RoomPhase,
  type ServerMessage,
  type Signal,
} from "../src/multiplayer/protocol.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "../src/warroom/incident.ts";
import type { CommsMessage, Scenario } from "../src/warroom/scenario.ts";
import { runLine } from "../src/warroom/shell/shell.ts";
import { applyTeamwork } from "../src/warroom/teamwork.ts";
import type { Logger } from "./log.ts";
import { chatComms, declaredComms, joinedComms, leftComms, noticeComms } from "./notices.ts";
import type { Paging } from "./paging.ts";
import { isSameSecret, newSecret } from "./secrets.ts";
import { startTicker, type StopTicker } from "./ticker.ts";

/** One player's socket, as the room sees it. */
export type Connection = {
  send(payload: string): void;
  close(code: number, reason: string): void;
};

export type RoomTiming = {
  /** Wall-clock length of one simulated second while the incident is live. */
  readonly tickMs: number;
  /** Monitoring fast-forwards, as in single player: ten simulated minutes in about thirty seconds. */
  readonly monitoringTickMs: number;
  /** How long a dropped player's seat (and shell history) waits for them to reconnect. */
  readonly playerGraceMs: number;
};

export const DEFAULT_ROOM_TIMING: RoomTiming = { tickMs: 1000, monitoringTickMs: 50, playerGraceMs: 60_000 };

export type JoinRequest = {
  readonly name: string;
  readonly role: Role;
  readonly badge: string | null;
  /** A catalog body, already checked by the protocol; older clients send none. */
  readonly avatar?: string | null;
  /** From the host's verified identity for this socket, never from the client's message. */
  readonly tags: readonly string[];
  readonly resume?: Resume;
};

export type JoinOutcome = { readonly ok: true; readonly playerId: string } | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

const HISTORY_LIMIT = 200;
const COMMS_LIMIT = 300;
const ACTIVITY_LINE_LIMIT = 120;
/** Close code for a socket whose seat was reclaimed by a newer connection. */
const SUPERSEDED_CLOSE_CODE = 4000;

type Seat = {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly role: Role;
  readonly badge: string | null;
  readonly avatar: string | null;
  readonly tags: readonly string[];
  /** Null until the client says it can do voice; only then is it sent handshakes. */
  voice: { isMicOn: boolean } | null;
  position: Position | null;
  /** Null while the player is disconnected and the seat is held for them. */
  connection: Connection | null;
  history: readonly string[];
  expiry: ReturnType<typeof setTimeout> | null;
};

/** One war room: the authoritative incident plus the people working it. */
export class Room {
  readonly code: string;
  readonly scenario: Scenario;
  private incident: Incident;
  private comms: readonly CommsMessage[];
  /** Playbook steps colleagues have already played for roles nobody in the room holds. */
  private teamworkDone: ReadonlySet<number> = new Set();
  private readonly seats = new Map<string, Seat>();
  private stopTicker: StopTicker | null = null;
  /** Quiet rooms show a calm floor and run no clock until the pager goes off. */
  private phase: RoomPhase;
  /** Null for an ordinary war room, which is live from the start. */
  private readonly paging: Paging | null;
  private pagerTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timing: RoomTiming;
  private readonly logger: Logger;
  /** Called when who's connected changes, or the incident closes: what hosts track for expiry and listing. */
  private readonly onOccupancyChange: (room: Room) => void;

  constructor(code: string, scenario: Scenario, timing: RoomTiming, logger: Logger, onOccupancyChange: (room: Room) => void, paging: Paging | null = null) {
    this.code = code;
    this.scenario = scenario;
    this.timing = timing;
    this.logger = logger;
    this.onOccupancyChange = onOccupancyChange;
    this.paging = paging;
    this.phase = paging ? "quiet" : "incident";
    this.incident = openIncident(scenario);
    this.comms = this.phase === "incident" ? this.openingComms() : [];
  }

  /** The first engineer to take a seat; null until someone has. */
  get hostName(): string | null {
    return this.seats.values().next().value?.name ?? null;
  }

  get isClosed(): boolean {
    return this.incident.phase.name === "closed";
  }

  get connectedCount(): number {
    return [...this.seats.values()].filter((seat) => seat.connection !== null).length;
  }

  join(request: JoinRequest, connection: Connection): JoinOutcome {
    const resumed = request.resume ? this.reclaim(request.resume, connection) : null;
    const seat = resumed ?? this.seat(request, connection);
    if (!seat) return { ok: false, code: "room_full", message: `Room ${this.code} already has ${MAX_PLAYERS_PER_ROOM} engineers.` };

    this.send(seat, {
      type: "welcome",
      roomCode: this.code,
      playerId: seat.id,
      resumeToken: seat.token,
      isResumed: resumed !== null,
      scenarioId: this.scenario.id,
      players: this.players(),
      comms: [...this.comms],
      history: [...seat.history],
      phase: this.phase,
    });
    this.send(seat, { type: "state", frame: encodeFrame(null, this.incident) });
    if (this.incident.phase.name === "closed") this.send(seat, this.closedMessage());

    this.broadcast({ type: "players", players: this.players() }, seat);
    if (!resumed) this.post(joinedComms(seat.name, seat.role, seat.badge, seat.tags, this.incident.cluster.t));
    this.logger("info", resumed ? "player_resumed" : "player_joined", { room: this.code, player: seat.id, role: seat.role });
    this.occupancyChanged();
    return { ok: true, playerId: seat.id };
  }

  /** The player's socket went away; hold the seat in case they come back. Ignores sockets already superseded. */
  detach(playerId: string, connection: Connection) {
    const seat = this.seats.get(playerId);
    if (!seat || seat.connection !== connection) return;
    seat.connection = null;
    seat.expiry = setTimeout(() => this.leave(playerId), this.timing.playerGraceMs);
    this.broadcast({ type: "players", players: this.players() });
    this.logger("info", "player_detached", { room: this.code, player: playerId });
    this.occupancyChanged();
  }

  leave(playerId: string) {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    if (seat.expiry) clearTimeout(seat.expiry);
    this.seats.delete(playerId);
    this.broadcast({ type: "players", players: this.players() });
    this.post(leftComms(seat.name, this.incident.cluster.t));
    this.logger("info", "player_left", { room: this.code, player: playerId });
    this.occupancyChanged();
  }

  presence(playerId: string, position: Position) {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    seat.position = position;
    this.broadcast({ type: "presence", playerId, position }, seat);
  }

  command(playerId: string, line: string) {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    if (this.phase === "quiet") {
      this.send(seat, { type: "error", code: "incident_not_live", message: "Nothing's paging yet." });
      return;
    }
    if (this.incident.phase.name !== "live") {
      this.send(seat, { type: "error", code: "incident_not_live", message: "The shell is read-only once the incident is resolved." });
      return;
    }
    const trimmed = line.trim();
    const result = runLine(trimmed, { cluster: this.incident.cluster, scenario: this.scenario, history: seat.history, role: seat.role });
    if (trimmed) seat.history = [...seat.history, trimmed].slice(-HISTORY_LIMIT);

    this.send(seat, { type: "terminal", line, output: [...result.output], isClearScreen: result.clearScreen ?? false });
    if (result.cluster) this.commit({ ...this.incident, cluster: result.cluster });
    if (trimmed) {
      this.broadcast(
        {
          type: "activity",
          at: this.incident.cluster.t,
          playerId,
          name: seat.name,
          role: seat.role,
          line: shorten(trimmed, ACTIVITY_LINE_LIMIT),
          didChangeCluster: result.cluster !== undefined,
        },
        seat,
      );
    }
  }

  /** A member presses "Page me" in a quiet office: the incident starts now. */
  page(playerId: string) {
    if (this.seats.has(playerId) && this.phase === "quiet") this.goLive();
  }

  declare(playerId: string) {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    if (this.phase === "quiet" || this.incident.phase.name !== "live") {
      this.send(seat, { type: "error", code: "incident_not_live", message: "The incident is already marked resolved." });
      return;
    }
    const { incident, notice } = declareResolved(this.incident, this.scenario);
    if (notice) {
      this.post(noticeComms(notice, incident.cluster.t));
      return;
    }
    this.commit(incident);
    this.post(declaredComms(seat.name, incident.cluster.t));
    this.logger("info", "incident_declared", { room: this.code, player: playerId, t: incident.cluster.t });
  }

  /** A client that can do voice says so, and whether its mic is open; teammates see it in the player list. */
  voice(playerId: string, isMicOn: boolean) {
    const seat = this.seats.get(playerId);
    if (!seat || seat.voice?.isMicOn === isMicOn) return;
    seat.voice = { isMicOn };
    this.broadcast({ type: "players", players: this.players() });
  }

  /** Passes one voice handshake step to a teammate in this room who can read it; anything else is dropped. */
  signal(playerId: string, to: string, signal: Signal) {
    const from = this.seats.get(playerId);
    const target = this.seats.get(to);
    if (!from?.voice || !target?.voice || target === from) return;
    this.send(target, { type: "signal", from: playerId, signal });
  }

  chat(playerId: string, text: string) {
    const seat = this.seats.get(playerId);
    if (seat) this.post(chatComms(seat.name, seat.role, text, this.incident.cluster.t));
  }

  dispose() {
    this.stopTicker?.();
    this.stopTicker = null;
    if (this.pagerTimer) clearTimeout(this.pagerTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.pagerTimer = null;
    this.resetTimer = null;
    for (const seat of this.seats.values()) if (seat.expiry) clearTimeout(seat.expiry);
  }

  private tick() {
    const previousT = this.incident.cluster.t;
    const { incident: advanced, notice } = advance(this.incident, this.scenario);
    // A held seat stays in `seats` until it expires, so a colleague never takes a reconnecting player's role.
    const covered = new Set([...this.seats.values()].map((seat) => seat.role));
    const { incident, done, messages } = applyTeamwork(advanced, this.scenario, covered, this.teamworkDone);
    this.teamworkDone = done;
    this.commit(incident);
    const t = incident.cluster.t;
    for (const message of this.scenario.comms) if (message.at > previousT && message.at <= t) this.post(message);
    if (notice) this.post(noticeComms(notice, t));
    for (const message of messages) this.post(message);
    if (notice?.kind === "closed") {
      this.broadcast(this.closedMessage());
      this.logger("info", "incident_closed", { room: this.code, t, reopens: incident.reopenCount });
      this.syncTicker();
      // A closed room leaves the public list, so its host hears about it like a join or leave.
      this.onOccupancyChange(this);
      if (this.paging) this.resetTimer = setTimeout(() => this.goQuiet(), this.paging.resetAfterCloseMs);
    }
  }

  /** The pager goes off: a fresh incident opens and everyone's floor turns live. */
  private goLive() {
    if (this.pagerTimer) clearTimeout(this.pagerTimer);
    this.pagerTimer = null;
    this.phase = "incident";
    this.replaceIncident(openIncident(this.scenario));
    for (const message of this.openingComms()) this.post(message);
    this.logger("info", "office_paged", { room: this.code });
    this.syncTicker();
  }

  /** Back to a calm office after an incident closes; the pager is armed again. */
  private goQuiet() {
    this.resetTimer = null;
    this.phase = "quiet";
    this.replaceIncident(openIncident(this.scenario));
    this.syncTicker();
    this.syncPager();
  }

  /** A new incident isn't a delta of the last one: tell everyone the phase, then send it whole. */
  private replaceIncident(next: Incident) {
    this.incident = next;
    this.broadcast({ type: "phase", phase: this.phase });
    this.broadcast({ type: "state", frame: encodeFrame(null, next) });
  }

  private openingComms(): CommsMessage[] {
    return this.scenario.comms.filter((message) => message.at <= this.incident.cluster.t);
  }

  /** Every change goes through here, so the frame each client applies is always relative to the last one sent. */
  private commit(next: Incident) {
    const frame = encodeFrame(this.incident, next);
    this.incident = next;
    this.broadcast({ type: "state", frame });
  }

  private post(message: CommsMessage) {
    this.comms = [...this.comms, message].slice(-COMMS_LIMIT);
    this.broadcast({ type: "comms", message });
  }

  private closedMessage(): ServerMessage {
    return {
      type: "closed",
      debrief: {
        ifPostmortemCorrect: debrief(this.incident, this.scenario, true),
        ifPostmortemWrong: debrief(this.incident, this.scenario, false),
      },
    };
  }

  private seat(request: JoinRequest, connection: Connection): Seat | null {
    if (this.seats.size >= MAX_PLAYERS_PER_ROOM) return null;
    const seat: Seat = {
      id: crypto.randomUUID(),
      token: newSecret(24),
      name: request.name,
      role: request.role,
      badge: request.badge,
      avatar: request.avatar ?? null,
      tags: request.tags,
      voice: null,
      position: null,
      connection,
      history: [],
      expiry: null,
    };
    this.seats.set(seat.id, seat);
    return seat;
  }

  /** Reattaches a held seat; a failed reclaim falls through to a fresh seat rather than an error. */
  private reclaim(resume: Resume, connection: Connection): Seat | null {
    const seat = this.seats.get(resume.playerId);
    if (!seat || !isSameSecret(seat.token, resume.token)) return null;
    if (seat.expiry) clearTimeout(seat.expiry);
    seat.expiry = null;
    seat.connection?.close(SUPERSEDED_CLOSE_CODE, "seat reclaimed by a newer connection");
    seat.connection = connection;
    return seat;
  }

  private players(): Player[] {
    return [...this.seats.values()].map((seat) => ({
      id: seat.id,
      name: seat.name,
      role: seat.role,
      position: seat.position,
      isConnected: seat.connection !== null,
      badge: seat.badge,
      avatar: seat.avatar,
      tags: [...seat.tags],
      voice: seat.voice,
    }));
  }

  private send(seat: Seat, message: ServerMessage) {
    seat.connection?.send(encodeServerMessage(message));
  }

  private broadcast(message: ServerMessage, except?: Seat) {
    const payload = encodeServerMessage(message);
    for (const seat of this.seats.values()) if (seat !== except) seat.connection?.send(payload);
  }

  private occupancyChanged() {
    this.syncTicker();
    this.syncPager();
    this.onOccupancyChange(this);
  }

  /** A quiet office's pager counts down only while someone is there to hear it; one timer, no ticking. */
  private syncPager() {
    const shouldArm = this.paging !== null && this.phase === "quiet" && this.connectedCount > 0;
    if (shouldArm && !this.pagerTimer && this.paging) {
      this.pagerTimer = setTimeout(() => this.goLive(), this.paging.quietMs());
    } else if (!shouldArm && this.pagerTimer) {
      clearTimeout(this.pagerTimer);
      this.pagerTimer = null;
    }
  }

  /** The clock runs only while someone is watching and a live incident is still open. */
  private syncTicker() {
    const shouldRun = this.connectedCount > 0 && this.phase === "incident" && this.incident.phase.name !== "closed";
    if (shouldRun && !this.stopTicker) {
      this.stopTicker = startTicker(
        () => (this.incident.phase.name === "monitoring" ? this.timing.monitoringTickMs : this.timing.tickMs),
        () => this.tickSafely(),
      );
    } else if (!shouldRun && this.stopTicker) {
      this.stopTicker();
      this.stopTicker = null;
    }
  }

  /** A fault in one room's simulation must not take down every other room in the process. */
  private tickSafely() {
    try {
      this.tick();
    } catch (error) {
      this.logger("error", "tick_failed", { room: this.code, message: error instanceof Error ? error.message : String(error) });
      this.stopTicker?.();
      this.stopTicker = null;
    }
  }
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
