import { afterEach, describe, expect, it } from "vitest";
import type { Paging } from "../../server/paging.ts";
import { Room, type Connection } from "../../server/room.ts";
import { TEAM_SCENARIO } from "../warroom/scenarios/index.ts";
import { parseServerMessage, type ServerMessage } from "./protocol.ts";

const TIMING = { tickMs: 5, monitoringTickMs: 1, playerGraceMs: 1_000 };
const silent = () => {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket that keeps what the room sent it. */
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
  return { connection, received, ofType: <Type extends ServerMessage["type"]>(type: Type) => received.filter((message) => message.type === type) };
}

const rooms: Room[] = [];
function open(paging: Paging | null) {
  const room = new Room("ABCD", TEAM_SCENARIO, TIMING, silent, () => {}, paging);
  rooms.push(room);
  return room;
}
const join = (room: Room, connection: Connection) => {
  const joined = room.join({ name: "Maya", role: "infrastructure", badge: null, tags: [] }, connection);
  if (!joined.ok) throw new Error(joined.message);
  return joined.playerId;
};

afterEach(() => {
  for (const room of rooms.splice(0)) room.dispose();
});

describe("a company office's pager", () => {
  it("opens quiet: no opening comms, no clock, and the shell waits for a page", async () => {
    const room = open({ quietMs: () => 60_000, resetAfterCloseMs: 10 });
    const maya = listener();
    const id = join(room, maya.connection);
    const [welcome] = maya.ofType("welcome");
    expect(welcome).toMatchObject({ phase: "quiet", comms: [] });
    await sleep(40);
    expect(maya.ofType("state")).toHaveLength(1);
    room.command(id, "kubectl get pods");
    expect(maya.ofType("error").at(-1)).toMatchObject({ code: "incident_not_live" });
  });

  it("goes live when a member pages it: phase, a whole fresh incident, the opening comms, then ticking", async () => {
    const room = open({ quietMs: () => 60_000, resetAfterCloseMs: 10 });
    const maya = listener();
    const id = join(room, maya.connection);
    room.page(id);
    expect(maya.ofType("phase")).toEqual([{ type: "phase", phase: "incident" }]);
    const [, paged] = maya.ofType("state");
    expect(paged).toMatchObject({ frame: { full: true } });
    expect(maya.ofType("comms").length).toBeGreaterThan(0);
    await sleep(40);
    expect(maya.ofType("state").length).toBeGreaterThan(2);
  });

  it("pages on its own once someone has been there long enough", async () => {
    const room = open({ quietMs: () => 20, resetAfterCloseMs: 10 });
    const maya = listener();
    join(room, maya.connection);
    await sleep(60);
    expect(maya.ofType("phase")).toEqual([{ type: "phase", phase: "incident" }]);
  });

  it("leaves an ordinary war room live from the start", async () => {
    const room = open(null);
    const maya = listener();
    join(room, maya.connection);
    expect(maya.ofType("welcome")[0]).toMatchObject({ phase: "incident" });
    await sleep(40);
    expect(maya.ofType("state").length).toBeGreaterThan(1);
    expect(maya.ofType("phase")).toEqual([]);
  });
});
