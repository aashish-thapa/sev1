import { afterEach, describe, expect, it } from "vitest";
import { parseServerMessage, type ServerMessage, type ServerMessageOf } from "./protocol.ts";
import { checkoutPoolLeak as scenario } from "../warroom/scenarios/checkout-pool-leak.ts";
import { OVERTIME_MS } from "../warroom/versus.ts";
import { LocalMatchmaker } from "../../server/local-matchmaker.ts";
import { Match, type MatchFormat } from "../../server/match.ts";
import type { Matchmaking, Ticket } from "../../server/matchmaking.ts";
import { RoomRegistry } from "../../server/registry.ts";
import { findScenario } from "../../server/scenarios.ts";
import { openSession } from "../../server/session.ts";
import type { Connection } from "../../server/room.ts";

const TIMING = { tickMs: 2, monitoringTickMs: 1, playerGraceMs: 1_000 };
const UNDO = "kubectl rollout undo deployment/checkout-api";
const silent = () => {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

/** A socket that keeps what it was sent. */
function listener() {
  const received: ServerMessage[] = [];
  const connection: Connection = {
    send: (payload) => {
      const parsed = parseServerMessage(payload);
      if (!parsed.ok) throw new Error(parsed.reason);
      received.push(parsed.message);
    },
    close: () => {},
  };
  const ofType = <Type extends ServerMessage["type"]>(type: Type) => received.filter((message): message is ServerMessageOf<Type> => message.type === type);
  return { connection, received, ofType, lastMatch: () => ofType("match").at(-1) };
}

/** Keeps what rooms asked of matchmaking, and answers nothing on its own. */
function recordingMatchmaker() {
  const seeks: Ticket[] = [];
  const withdrawn: string[] = [];
  const matchmaking: Matchmaking = { seek: (ticket) => seeks.push(ticket), withdraw: (code) => withdrawn.push(code) };
  return { matchmaking, seeks, withdrawn };
}

const matches: Match[] = [];
function openMatch(now: () => number = Date.now, format: MatchFormat = "versus", matchmaking: Matchmaking = recordingMatchmaker().matchmaking) {
  const match = new Match("VSUS", scenario, TIMING, silent, () => {}, { format, matchmaking, now });
  matches.push(match);
  return match;
}

function seat(match: Match, name: string, team?: "red" | "blue") {
  const socket = listener();
  const joined = match.join({ name, role: "infrastructure", badge: null, tags: [], team }, socket.connection);
  if (!joined.ok) throw new Error(joined.message);
  return { ...socket, id: joined.playerId, room: joined.room };
}

afterEach(() => {
  for (const match of matches.splice(0)) match.dispose();
});

describe("a versus match", () => {
  it("puts the first player on red and the next on blue, and tells each their side", () => {
    const match = openMatch();
    const maya = seat(match, "Maya");
    const theo = seat(match, "Theo");
    expect(maya.ofType("welcome")[0]).toMatchObject({ team: "red", phase: "quiet" });
    expect(theo.ofType("welcome")[0]).toMatchObject({ team: "blue", phase: "quiet" });
    expect(match.connectedCount).toBe(2);
  });

  it("turns away a seventh player once both teams are full", () => {
    const match = openMatch();
    for (const name of ["A", "B", "C", "D", "E", "F"]) seat(match, name);
    expect(match.join({ name: "G", role: "data", badge: null, tags: [] }, listener().connection)).toMatchObject({ ok: false, code: "room_full" });
  });

  it("won't start until both sides have someone, then starts both at once", () => {
    const match = openMatch();
    const maya = seat(match, "Maya");
    maya.room.page(maya.id);
    expect(maya.ofType("phase")).toEqual([]);
    expect(maya.ofType("comms").at(-1)?.message).toMatchObject({ from: "Referee" });

    const theo = seat(match, "Theo");
    theo.room.page(theo.id);
    expect(maya.ofType("phase")).toEqual([{ type: "phase", phase: "incident" }]);
    expect(theo.ofType("phase")).toEqual([{ type: "phase", phase: "incident" }]);
    expect(theo.lastMatch()?.stage).toEqual({ name: "racing" });
    expect(theo.lastMatch()?.lanes.map((lane) => lane.phase)).toEqual(["live", "live"]);
  });

  it("keeps each team's incident to itself, and shows both in the standings", async () => {
    const match = openMatch();
    const maya = seat(match, "Maya");
    const theo = seat(match, "Theo");
    maya.room.page(maya.id);
    maya.room.command(maya.id, UNDO);
    await until(() => (theo.lastMatch()?.lanes[0]?.alertRate ?? 1) < 0.01);
    expect(theo.ofType("terminal")).toEqual([]);
    expect(theo.ofType("activity")).toEqual([]);
    expect(theo.lastMatch()?.lanes[1]?.alertRate).toBeGreaterThan(0.01);
  });

  it("gives the other side overtime once one closes, then names the winner", async () => {
    let clock = 0;
    const match = openMatch(() => clock);
    const maya = seat(match, "Maya");
    seat(match, "Theo");
    maya.room.page(maya.id);
    maya.room.command(maya.id, UNDO);
    await until(() => (maya.lastMatch()?.lanes[0]?.alertRate ?? 1) < 0.01);
    maya.room.declare(maya.id);
    await until(() => maya.lastMatch()?.stage.name === "overtime");
    expect(maya.ofType("closed")[0]?.scorecard).toEqual([expect.objectContaining({ name: "Maya", commands: 1, changes: 1, isFixer: true })]);
    expect(match.isClosed).toBe(false);

    clock += OVERTIME_MS;
    await until(() => maya.lastMatch()?.stage.name === "decided");
    expect(maya.lastMatch()?.stage).toEqual({ name: "decided", winner: "red" });
    expect(match.isClosed).toBe(true);
  }, 20_000);
});

describe("opening a versus room over the wire", () => {
  it("creates a match from a create message, seats the joiner on blue, and lists it as versus", () => {
    const registry = new RoomRegistry({ maxRooms: 4, roomGraceMs: 1_000, timing: TIMING, random: Math.random, logger: silent, now: () => 0, matchmaking: recordingMatchmaker().matchmaking });
    const connect = () => {
      const socket = listener();
      const session = openSession({ connection: socket.connection, rooms: registry, findScenario, logger: silent });
      const send = (message: object) => {
        const text = JSON.stringify(message);
        session.receive(text, text.length);
      };
      return { ...socket, send };
    };
    const host = connect();
    host.send({ type: "create", scenarioId: scenario.id, name: "Maya", role: "infrastructure", visibility: "public", mode: "versus" });
    const code = host.ofType("welcome")[0]?.roomCode ?? "";
    expect(host.ofType("welcome")[0]).toMatchObject({ team: "red" });

    const guest = connect();
    guest.send({ type: "join", roomCode: code, name: "Theo", role: "infrastructure" });
    expect(guest.ofType("welcome")[0]).toMatchObject({ roomCode: code, team: "blue" });
    expect(registry.listPublic()).toEqual([expect.objectContaining({ code, mode: "versus", players: 2, maxPlayers: 6 })]);
    registry.closeAll();
  });

  it("keeps a room co-op when the client doesn't say otherwise", () => {
    const registry = new RoomRegistry({ maxRooms: 4, roomGraceMs: 1_000, timing: TIMING, random: Math.random, logger: silent, now: () => 0, matchmaking: recordingMatchmaker().matchmaking });
    const socket = listener();
    const session = openSession({ connection: socket.connection, rooms: registry, findScenario, logger: silent });
    const text = JSON.stringify({ type: "create", scenarioId: scenario.id, name: "Maya", role: "infrastructure", visibility: "public" });
    session.receive(text, text.length);
    expect(socket.ofType("welcome")[0]).toMatchObject({ team: null, phase: "incident" });
    expect(registry.listPublic()[0]).toMatchObject({ mode: "coop", maxPlayers: 5 });
    registry.closeAll();
  });
});

describe("a matchmade match", () => {
  it("seats everyone who joins by code on red, as one party, and searches with the party's size when paged", () => {
    const { matchmaking, seeks } = recordingMatchmaker();
    const match = openMatch(Date.now, "matchmade", matchmaking);
    const maya = seat(match, "Maya");
    const theo = seat(match, "Theo", "blue");
    expect(theo.ofType("welcome")[0]).toMatchObject({ team: "red", mode: "matchmade" });
    maya.room.page(maya.id);
    expect(seeks).toEqual([expect.objectContaining({ code: "VSUS", size: 2, tier: scenario.tier, role: "infrastructure" })]);
    expect(maya.lastMatch()?.stage).toMatchObject({ name: "searching" });
    expect(match.join({ name: "Late", role: "data", badge: null, tags: [] }, listener().connection)).toMatchObject({ ok: false });
  });

  it("hosts: seats the paired party on blue and starts the race once they've all arrived", () => {
    const match = openMatch(Date.now, "matchmade");
    const maya = seat(match, "Maya");
    maya.room.page(maya.id);
    match.onMatchmaking({ kind: "host", guests: 1 });
    expect(maya.lastMatch()?.stage).toEqual({ name: "found" });
    expect(match.join({ name: "Crasher", role: "data", badge: null, tags: [] }, listener().connection)).toMatchObject({ ok: false });

    const guest = seat(match, "Theo", "blue");
    expect(guest.ofType("welcome")[0]).toMatchObject({ team: "blue" });
    expect(maya.lastMatch()?.stage).toEqual({ name: "racing" });
    expect(maya.ofType("phase")).toEqual([{ type: "phase", phase: "incident" }]);
  });

  it("as the guest, sends its party to the host's room on blue and closes", () => {
    const match = openMatch(Date.now, "matchmade");
    const maya = seat(match, "Maya");
    maya.room.page(maya.id);
    match.onMatchmaking({ kind: "guest", hostCode: "HSTX" });
    expect(maya.ofType("move")).toEqual([{ type: "move", roomCode: "HSTX", team: "blue" }]);
    expect(match.isClosed).toBe(true);
  });

  it("races a bot crew when nobody turns up, and the crew plays with nobody in its room", async () => {
    const { matchmaking, withdrawn } = recordingMatchmaker();
    const match = openMatch(Date.now, "matchmade", matchmaking);
    const maya = seat(match, "Maya");
    maya.room.page(maya.id);
    match.onMatchmaking({ kind: "none" });
    expect(withdrawn).toEqual(["VSUS"]);
    expect(maya.lastMatch()?.stage).toEqual({ name: "racing" });
    expect(maya.lastMatch()?.lanes[1]).toMatchObject({ team: "blue", crew: "bots", players: 0, phase: "live" });
    await until(() => (maya.lastMatch()?.lanes[1]?.alertRate ?? 1) < 0.01);
  }, 20_000);

  it("ignores an outcome that arrives after the search is over", () => {
    const match = openMatch(Date.now, "matchmade");
    const maya = seat(match, "Maya");
    maya.room.page(maya.id);
    match.onMatchmaking({ kind: "none" });
    match.onMatchmaking({ kind: "guest", hostCode: "LATE" });
    expect(maya.ofType("move")).toEqual([]);
  });
});

describe("matchmaking over the wire", () => {
  it("pairs two solo players: the second is moved into the first one's room on blue, and the race starts", () => {
    let registry: RoomRegistry | null = null;
    const matchmaking = new LocalMatchmaker((code, outcome) => registry?.find(code)?.onMatchmaking?.(outcome));
    registry = new RoomRegistry({ maxRooms: 4, roomGraceMs: 1_000, timing: TIMING, random: Math.random, logger: silent, now: () => 0, matchmaking });
    const rooms = registry;
    const connect = () => {
      const socket = listener();
      const session = openSession({ connection: socket.connection, rooms, findScenario, logger: silent });
      const send = (message: object) => {
        const text = JSON.stringify(message);
        session.receive(text, text.length);
      };
      return { ...socket, send };
    };
    const create = { type: "create", scenarioId: scenario.id, role: "infrastructure", visibility: "private", mode: "matchmade" };

    const maya = connect();
    maya.send({ ...create, name: "Maya" });
    maya.send({ type: "page" });
    const hostCode = maya.ofType("welcome")[0]?.roomCode;

    const theo = connect();
    theo.send({ ...create, name: "Theo" });
    theo.send({ type: "page" });
    expect(theo.ofType("move")).toEqual([{ type: "move", roomCode: hostCode, team: "blue" }]);

    // What the client does with a move: leave, then join the host's room on blue.
    const moved = connect();
    moved.send({ type: "join", roomCode: hostCode, name: "Theo", role: "infrastructure", team: "blue" });
    expect(moved.ofType("welcome")[0]).toMatchObject({ team: "blue", mode: "matchmade" });
    expect(maya.lastMatch()?.stage).toEqual({ name: "racing" });
    expect(registry.listPublic()).toEqual([]);
    registry.closeAll();
    matchmaking.dispose();
  });
});
