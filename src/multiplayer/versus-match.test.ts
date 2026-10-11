import { afterEach, describe, expect, it } from "vitest";
import { parseServerMessage, type ServerMessage, type ServerMessageOf } from "./protocol.ts";
import { checkoutPoolLeak as scenario } from "../warroom/scenarios/checkout-pool-leak.ts";
import { OVERTIME_MS } from "../warroom/versus.ts";
import { Match } from "../../server/match.ts";
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

const matches: Match[] = [];
function openMatch(now: () => number = Date.now) {
  const match = new Match("VSUS", scenario, TIMING, silent, () => {}, now);
  matches.push(match);
  return match;
}

function seat(match: Match, name: string) {
  const socket = listener();
  const joined = match.join({ name, role: "infrastructure", badge: null, tags: [] }, socket.connection);
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
    const registry = new RoomRegistry({ maxRooms: 4, roomGraceMs: 1_000, timing: TIMING, random: Math.random, logger: silent, now: () => 0 });
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
    const registry = new RoomRegistry({ maxRooms: 4, roomGraceMs: 1_000, timing: TIMING, random: Math.random, logger: silent, now: () => 0 });
    const socket = listener();
    const session = openSession({ connection: socket.connection, rooms: registry, findScenario, logger: silent });
    const text = JSON.stringify({ type: "create", scenarioId: scenario.id, name: "Maya", role: "infrastructure", visibility: "public" });
    session.receive(text, text.length);
    expect(socket.ofType("welcome")[0]).toMatchObject({ team: null, phase: "incident" });
    expect(registry.listPublic()[0]).toMatchObject({ mode: "coop", maxPlayers: 5 });
    registry.closeAll();
  });
});
