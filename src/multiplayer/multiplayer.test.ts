import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateRoomCode } from "../../server/room-code.ts";
import { silentLogger } from "../../server/log.ts";
import { Room } from "../../server/room.ts";
import { findScenario } from "../../server/scenarios.ts";
import { startServer, type RunningServer, type ServerOptions } from "../../server/server.ts";
import { advance, openIncident, type Incident } from "../warroom/incident.ts";
import { checkoutMeltdown } from "../warroom/scenarios/checkout-meltdown.ts";
import { checkoutPoolLeak as scenario } from "../warroom/scenarios/checkout-pool-leak.ts";
import { runLine } from "../warroom/shell/shell.ts";
import { backoffDelay } from "./backoff.ts";
import { RoomClient, type RoomStatus } from "./client.ts";
import { applyFrame, diffList, encodeFrame, IncidentFrameSchema } from "./frame.ts";
import {
  encodeClientMessage,
  MAX_INBOUND_BYTES,
  parseClientMessage,
  parseServerMessage,
  PUBLIC_ROOMS_PATH,
  PublicRoomListSchema,
  ROOM_CODE_ALPHABET,
  type ClientMessageInput,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
} from "./protocol.ts";

const UNDO = "kubectl rollout undo deployment/checkout-api";
const WAIT_MS = 2000;

describe("protocol parsing", () => {
  it("accepts a well-formed join and normalises the room code", () => {
    const parsed = parseClientMessage(JSON.stringify({ type: "join", roomCode: " abcd ", name: "  Maya ", role: "security" }));
    expect(parsed).toEqual({ ok: true, message: { type: "join", roomCode: "ABCD", name: "Maya", role: "security", badge: null } });
  });

  it("reads a quiet office's page, and treats a welcome without a phase as a live incident", () => {
    expect(parseClientMessage(JSON.stringify({ type: "page" }))).toEqual({ ok: true, message: { type: "page" } });
    const welcome = { type: "welcome", roomCode: "ABCD", playerId: "p1", resumeToken: "t", isResumed: false, scenarioId: "s", players: [], comms: [], history: [] };
    expect(parseServerMessage(JSON.stringify(welcome))).toMatchObject({ ok: true, message: { phase: "incident" } });
    expect(parseServerMessage(JSON.stringify({ type: "phase", phase: "quiet" }))).toEqual({ ok: true, message: { type: "phase", phase: "quiet" } });
  });

  it("takes a badge from the catalog and turns down one that isn't", () => {
    const join = (badge: string) => parseClientMessage(JSON.stringify({ type: "join", roomCode: "ABCD", name: "Maya", role: "security", badge }));
    expect(join("streak-7")).toMatchObject({ ok: true, message: { badge: "streak-7" } });
    expect(join("made-up").ok).toBe(false);
  });

  it.each([
    ["not JSON", "{type:", "bad_message"],
    ["an unknown type", JSON.stringify({ type: "teleport" }), "bad_message"],
    ["an extra field", JSON.stringify({ type: "declare", force: true }), "bad_message"],
    ["an unknown role", JSON.stringify({ type: "create", scenarioId: "x", name: "Sam", role: "manager" }), "bad_message"],
    ["an ambiguous room code", JSON.stringify({ type: "join", roomCode: "AB0I", name: "Sam", role: "data" }), "bad_message"],
    ["a position off the floor", JSON.stringify({ type: "presence", x: 1e6, z: 0, yaw: 0 }), "bad_message"],
    ["an empty chat", JSON.stringify({ type: "chat", text: "   " }), "bad_message"],
    ["an oversized message", JSON.stringify({ type: "chat", text: "x".repeat(MAX_INBOUND_BYTES) }), "too_large"],
  ])("rejects %s", (_label, raw, code) => {
    const parsed = parseClientMessage(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe(code);
  });

  it("measures the size limit in UTF-8 bytes, not characters", () => {
    // "€" is three bytes in UTF-8: a third of the limit in characters is over it in bytes.
    const raw = JSON.stringify({ type: "command", line: "€".repeat(Math.ceil(MAX_INBOUND_BYTES / 3) + 10) });
    expect(raw.length).toBeLessThan(MAX_INBOUND_BYTES);
    expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("round-trips every server message through its schema", () => {
    const frame = encodeFrame(null, openIncident(scenario));
    const parsed = parseServerMessage(JSON.stringify({ type: "state", frame }));
    expect(parsed.ok).toBe(true);
  });
});

describe("incident frames", () => {
  const roundTrip = (previous: Incident | null, next: Incident) =>
    applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));

  it("rebuilds the exact incident from deltas across ticks, commands and trimmed logs", () => {
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    expect(client).toEqual(server);
    for (let second = 0; second < 400; second += 1) {
      let next = advance(server, scenario).incident;
      if (second === 200) {
        const result = runLine(UNDO, { cluster: next.cluster, scenario, history: [], role: "infrastructure" });
        next = { ...next, cluster: result.cluster ?? next.cluster };
      }
      client = roundTrip(client, next);
      server = next;
    }
    expect(client).toEqual(server);
  });

  it("keeps a normal tick to a small fraction of the full snapshot", () => {
    let incident = openIncident(scenario);
    for (let second = 0; second < 300; second += 1) incident = advance(incident, scenario).incident;
    const next = advance(incident, scenario).incident;
    const full = JSON.stringify(encodeFrame(null, next)).length;
    const delta = JSON.stringify(encodeFrame(incident, next)).length;
    expect(full).toBeGreaterThan(50_000);
    expect(delta).toBeLessThan(4_000);
  });

  it("refuses a delta with nothing to apply it to", () => {
    const incident = openIncident(scenario);
    expect(() => applyFrame(null, encodeFrame(incident, incident))).toThrow(/delta frame/);
  });

  it("diffs bounded lists, including repeated values", () => {
    expect(diffList([1, 1, 1], [1, 1, 1, 1])).toEqual({ drop: 0, append: [1] });
    expect(diffList([1, 2, 3], [2, 3, 4])).toEqual({ drop: 1, append: [4] });
    expect(diffList([1, 2, 3], [9])).toEqual({ drop: 3, append: [9] });
    expect(diffList([], [])).toEqual({ drop: 0, append: [] });
  });
});

describe("declaring resolved in a room", () => {
  it("is refused on the scenario's own metric, and the channel says which", () => {
    const paged = { ...scenario, alertMetric: { label: "customers turned away", rate: () => 0.3 } };
    const room = new Room("TEST", paged, { tickMs: 60_000, monitoringTickMs: 60_000, playerGraceMs: 60_000 }, silentLogger, () => {});
    const said: string[] = [];
    const listen = (payload: string) => {
      const parsed = parseServerMessage(payload);
      if (parsed.ok && parsed.message.type === "comms") said.push(parsed.message.message.text);
    };
    const joined = room.join({ name: "Maya", role: "infrastructure", badge: null, tags: [] }, { send: listen, close: () => {} });
    if (!joined.ok) throw new Error(joined.message);

    room.declare(joined.playerId);
    room.dispose();
    expect(said.at(-1)).toBe("Can’t resolve: customers turned away is still 30%.");
  });
});

describe("room codes and backoff", () => {
  it("skips codes already in use", () => {
    const sequence = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    let index = 0;
    const code = generateRoomCode(() => sequence[index++ % sequence.length], (candidate) => candidate === "AAAA");
    expect(code).toBe(ROOM_CODE_ALPHABET[Math.floor(0.5 * ROOM_CODE_ALPHABET.length)].repeat(4));
  });

  it("gives up rather than spinning when every code is taken", () => {
    expect(generateRoomCode(Math.random, () => true)).toBeNull();
  });

  it("keeps reconnect delays within the capped exponential ceiling", () => {
    const policy = { baseMs: 100, capMs: 1000, maxAttempts: 10 };
    expect(backoffDelay(0, policy, () => 0.999)).toBeLessThan(100);
    expect(backoffDelay(3, policy, () => 0.999)).toBe(799);
    expect(backoffDelay(20, policy, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(5, policy, () => 0)).toBe(0);
  });
});

/** A raw protocol-level connection, for asserting exactly what the server sends. */
class Probe {
  readonly socket: WebSocket;
  private readonly received: ServerMessage[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on("message", (data) => {
      const parsed = parseServerMessage(String(data));
      if (!parsed.ok) throw new Error(`server sent an invalid message: ${parsed.reason}`);
      this.received.push(parsed.message);
      for (const wake of this.waiters) wake();
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    return this;
  }

  send(message: ClientMessageInput) {
    this.socket.send(encodeClientMessage(message));
  }

  sendRaw(raw: string) {
    this.socket.send(raw);
  }

  /** How many messages of `type` arrived and haven't been consumed by `next`. */
  count(type: ServerMessageType) {
    return this.received.filter((message) => message.type === type).length;
  }

  /** Resolves with the first message (received so far or later) of `type` that passes `matches`, consuming it. */
  next<Type extends ServerMessageType>(type: Type, matches: (message: ServerMessageOf<Type>) => boolean = () => true) {
    return new Promise<ServerMessageOf<Type>>((resolve, reject) => {
      const check = () => {
        const index = this.received.findIndex((message) => message.type === type && matches(message as ServerMessageOf<Type>));
        if (index === -1) return false;
        const [message] = this.received.splice(index, 1);
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(message as ServerMessageOf<Type>);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${type}`));
      }, WAIT_MS);
      if (!check()) this.waiters.add(check);
    });
  }

  close() {
    this.socket.close();
  }
}

describe("war room server", () => {
  let server: RunningServer;
  const probes: Probe[] = [];
  const clients: RoomClient[] = [];

  async function boot(overrides: Partial<ServerOptions> = {}) {
    server = await startServer({
      port: 0,
      host: "127.0.0.1",
      allowedOrigins: null,
      maxRooms: 10,
      roomGraceMs: 5_000,
      heartbeatMs: 60_000,
      timing: { tickMs: 25, monitoringTickMs: 5, playerGraceMs: 5_000 },
      findScenario,
      random: Math.random,
      logger: silentLogger,
      ...overrides,
    });
  }

  async function probe() {
    const created = new Probe(server.port);
    probes.push(created);
    return created.open();
  }

  async function createRoom(role: "infrastructure" | "frontend" = "infrastructure", scenarioId = scenario.id) {
    const host = await probe();
    host.send({ type: "create", scenarioId, name: "Maya", role });
    const welcome = await host.next("welcome");
    return { host, welcome };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const created of probes.splice(0)) created.close();
    await server?.close();
  });

  async function publicRooms() {
    const response = await fetch(`http://127.0.0.1:${server.port}${PUBLIC_ROOMS_PATH}`);
    return PublicRoomListSchema.parse(await response.json()).rooms;
  }

  it("lists a public room with its host, keeps private rooms off the list, and drops a room once it empties", async () => {
    await boot();
    const host = await probe();
    host.send({ type: "create", scenarioId: scenario.id, name: "Maya", role: "infrastructure", visibility: "public" });
    const welcome = await host.next("welcome");
    const secret = await probe();
    secret.send({ type: "create", scenarioId: scenario.id, name: "Sam", role: "frontend" });
    await secret.next("welcome");

    expect(await publicRooms()).toEqual([
      expect.objectContaining({ code: welcome.roomCode, host: "Maya", players: 1, scenarioTitle: scenario.title }),
    ]);
    host.close();
    await expect.poll(publicRooms, { timeout: WAIT_MS, interval: 10 }).toEqual([]);
  });

  it("shows tags only from the host's verified identity, never from what a client sends", async () => {
    const { joinedComms } = await import("../../server/notices.ts");
    expect(joinedComms("aashish", "infrastructure", null, ["creator"], 0).text).toBe("aashish [Creator] (infrastructure) joined.");
    await boot();
    const { host } = await createRoom();
    const players = await host.next("players").catch(() => null);
    const me = (players?.players ?? []).find((player) => player.name === "Maya");
    expect(me?.tags ?? []).toEqual([]);
    expect(parseClientMessage(JSON.stringify({ type: "join", roomCode: "ABCD", name: "Sam", role: "data", tags: ["creator"] })).ok).toBe(false);
  });

  it("relays voice handshakes only to teammates who can do voice, and only so many", async () => {
    await boot();
    const { host, welcome } = await createRoom();
    const join = async (name: string) => {
      const engineer = await probe();
      engineer.send({ type: "join", roomCode: welcome.roomCode, name, role: "frontend" });
      return { engineer, id: (await engineer.next("welcome")).playerId };
    };
    const guest = await join("Sam");
    const silent = await join("Lee");
    host.send({ type: "voice", isMicOn: false });
    guest.engineer.send({ type: "voice", isMicOn: true });
    await host.next("players", (message) => message.players.some((player) => player.name === "Sam" && player.voice?.isMicOn === true));

    const offer = { kind: "description", description: { type: "offer", sdp: "v=0" } } as const;
    host.send({ type: "signal", to: guest.id, signal: offer });
    host.send({ type: "signal", to: silent.id, signal: offer });
    expect((await guest.engineer.next("signal")).from).toBe(welcome.playerId);

    // 2 sent so far; a flood of 200 more gets 118 through before the 120-per-window budget runs out.
    for (let index = 0; index < 200; index += 1) host.send({ type: "signal", to: guest.id, signal: offer });
    await expect.poll(() => guest.engineer.count("signal"), { timeout: WAIT_MS, interval: 10 }).toBe(118);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guest.engineer.count("signal")).toBe(118);
    expect(silent.engineer.count("signal")).toBe(0);
  });

  it("shares one incident: a command from one engineer changes what both see", async () => {
    await boot();
    const { host, welcome } = await createRoom("infrastructure");
    expect(welcome.roomCode).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{4}$`));
    const full = await host.next("state", (message) => message.frame.full);
    let hostIncident = applyFrame(null, full.frame);

    const guest = await probe();
    guest.send({ type: "join", roomCode: welcome.roomCode.toLowerCase(), name: "Sam", role: "frontend" });
    const guestWelcome = await guest.next("welcome");
    expect(guestWelcome.players.map((player) => [player.name, player.role])).toEqual([
      ["Maya", "infrastructure"],
      ["Sam", "frontend"],
    ]);
    let guestIncident = applyFrame(null, (await guest.next("state", (message) => message.frame.full)).frame);
    await host.next("players", (message) => message.players.length === 2);

    host.send({ type: "command", line: UNDO });
    const terminal = await host.next("terminal");
    expect(terminal.output.map((line) => line.text)).toContain("deployment.apps/checkout-api rolled back");

    const activity = await guest.next("activity");
    expect(activity).toMatchObject({ name: "Maya", role: "infrastructure", line: UNDO, didChangeCluster: true });

    const rolledBack = (incident: Incident) => incident.cluster.deployments[0].revision === 8;
    while (!rolledBack(hostIncident)) hostIncident = applyFrame(hostIncident, (await host.next("state")).frame);
    while (!rolledBack(guestIncident)) guestIncident = applyFrame(guestIncident, (await guest.next("state")).frame);
    expect(guestIncident.cluster.deployments[0].revisions).toEqual(hostIncident.cluster.deployments[0].revisions);
  });

  /** Who has posted to the room so far, as a late joiner's welcome shows it. */
  async function postedBy(roomCode: string) {
    const late = await probe();
    late.send({ type: "join", roomCode, name: "Ana", role: "infrastructure" });
    return (await late.next("welcome")).comms.map((message) => message.from);
  }

  /** The meltdown's colleagues as they sign their playbook moves; the script also has Priya and Sam post in other hats. */
  const PRIYA = "Priya Shah · Frontend";
  const SAM = "Sam Tan · Infra / SRE";
  const JONAS = "Jonas Weber · Mobile";
  const saidBy = (from: string) => (message: ServerMessageOf<"comms">) => message.message.from === from;

  it("has colleagues play the meltdown's roles nobody in the room holds, and never a seated one", async () => {
    await boot();
    const { host, welcome } = await createRoom("infrastructure", checkoutMeltdown.id);
    // The meltdown's playbook: frontend at t=55, infra at 70, mobile at 80.
    expect((await host.next("comms", saidBy(PRIYA))).message.text).toContain("checkout.auto_retry");
    await host.next("comms", saidBy(JONAS));
    const posted = await postedBy(welcome.roomCode);
    expect(posted).toContain(PRIYA);
    expect(posted).not.toContain(SAM);
  });

  it("counts a dropped player's held seat as covered, so no colleague takes their job", async () => {
    await boot();
    const { host, welcome } = await createRoom("infrastructure", checkoutMeltdown.id);
    const guest = await probe();
    guest.send({ type: "join", roomCode: welcome.roomCode, name: "Sam", role: "frontend" });
    await guest.next("welcome");
    guest.close();
    await host.next("players", (message) => message.players.some((player) => player.name === "Sam" && !player.isConnected));
    await host.next("state", (message) => message.frame.cluster.t >= 60);
    expect(await postedBy(welcome.roomCode)).not.toContain(PRIYA);
  });

  it("answers malformed messages with an error and keeps the room running", async () => {
    await boot();
    const { host, welcome } = await createRoom();

    host.sendRaw("{not json");
    expect((await host.next("error")).code).toBe("bad_message");
    host.sendRaw(JSON.stringify({ type: "self-destruct" }));
    expect((await host.next("error")).code).toBe("bad_message");
    host.sendRaw(JSON.stringify({ type: "chat", text: "x".repeat(MAX_INBOUND_BYTES * 2) }));
    expect((await host.next("error")).code).toBe("too_large");
    host.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await host.next("error")).code).toBe("bad_message");

    const before = (await host.next("state")).frame.cluster.t;
    expect((await host.next("state", (message) => message.frame.cluster.t > before)).frame.cluster.t).toBeGreaterThan(before);
    host.send({ type: "chat", text: "still here" });
    expect((await host.next("comms", (message) => message.message.text === "still here")).message.from).toBe("Maya · infrastructure");

    const late = await probe();
    late.send({ type: "join", roomCode: welcome.roomCode, name: "Ana", role: "data" });
    expect((await late.next("welcome")).players).toHaveLength(2);
  });

  it("rejects actions outside a room and joins to rooms that don't exist", async () => {
    await boot();
    const stranger = await probe();
    stranger.send({ type: "command", line: "kubectl get pods" });
    expect((await stranger.next("error")).code).toBe("not_in_room");
    stranger.send({ type: "join", roomCode: "ZZZZ", name: "Sam", role: "mobile" });
    expect((await stranger.next("error")).code).toBe("room_not_found");
    stranger.send({ type: "create", scenarioId: "nope", name: "Sam", role: "mobile" });
    expect((await stranger.next("error")).code).toBe("unknown_scenario");
    stranger.send({ type: "ping", nonce: 7 });
    expect((await stranger.next("pong")).nonce).toBe(7);
  });

  it("caps a room at five engineers", async () => {
    await boot();
    const { welcome } = await createRoom();
    for (const name of ["B", "C", "D", "E"]) {
      const guest = await probe();
      guest.send({ type: "join", roomCode: welcome.roomCode, name, role: "mobile" });
      await guest.next("welcome");
    }
    const sixth = await probe();
    sixth.send({ type: "join", roomCode: welcome.roomCode, name: "F", role: "mobile" });
    expect((await sixth.next("error")).code).toBe("room_full");
  });

  it("never hands out a room code that is already live", async () => {
    // Every room code draws four values; the second room's first draw collides with the first room's code.
    const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
    let index = 0;
    await boot({ random: () => draws[index++ % draws.length] });
    const first = (await createRoom()).welcome.roomCode;
    const second = (await createRoom()).welcome.roomCode;
    expect(first).toBe("AAAA");
    expect(second).not.toBe(first);
  });

  it("rejects sockets from origins outside the allow-list", async () => {
    await boot({ allowedOrigins: ["https://sev1.example"] });
    const rejected = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: "https://evil.example" });
    const status = await new Promise<number | undefined>((resolve) => {
      rejected.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      rejected.on("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
    const allowed = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: "https://sev1.example" });
    await new Promise((resolve, reject) => {
      allowed.once("open", resolve);
      allowed.once("error", reject);
    });
    allowed.close();
  });

  it("lets a dropped client reclaim its seat, history and the live incident", async () => {
    await boot();
    const sockets: WebSocket[] = [];
    class TrackedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const client = new RoomClient({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocket: TrackedWebSocket,
      backoff: { baseMs: 10, capMs: 50, maxAttempts: 5 },
    });
    clients.push(client);
    const statuses: RoomStatus[] = [];
    client.on("status", ({ status }) => statuses.push(status));
    const welcomes: ServerMessageOf<"welcome">[] = [];
    client.on("welcome", (welcome) => welcomes.push(welcome));
    const until = (condition: () => boolean) => expect.poll(condition, { timeout: WAIT_MS, interval: 10 }).toBe(true);

    client.create({ scenarioId: scenario.id, name: "Maya", role: "infrastructure", badge: null, visibility: "private" });
    await until(() => client.status === "joined" && client.incident !== null);
    const seat = client.seat;

    const observer = await probe();
    observer.send({ type: "join", roomCode: seat?.roomCode ?? "", name: "Sam", role: "security" });
    await observer.next("welcome");
    client.run("kubectl get pods");
    await observer.next("activity");

    sockets[0].terminate();
    await until(() => welcomes.length === 2 && client.status === "joined");

    expect(welcomes[1]).toMatchObject({ isResumed: true, playerId: seat?.playerId, roomCode: seat?.roomCode, history: ["kubectl get pods"] });
    expect(statuses).toContain("reconnecting");
    await observer.next("players", (message) => message.players.length === 2 && message.players.every((player) => player.isConnected));

    const t = client.incident?.cluster.t ?? 0;
    await until(() => (client.incident?.cluster.t ?? 0) > t);
  });

  it("stops retrying when the room it wants no longer exists", async () => {
    await boot();
    const client = new RoomClient({ url: `ws://127.0.0.1:${server.port}`, WebSocket, backoff: { baseMs: 10, capMs: 50, maxAttempts: 5 } });
    clients.push(client);
    let failure: string | undefined;
    client.on("status", ({ status, error }) => {
      if (status === "failed") failure = error?.code;
    });
    client.join({ roomCode: "QQQQ", name: "Sam", role: "data", badge: null });
    await expect.poll(() => failure, { timeout: WAIT_MS }).toBe("room_not_found");
  });
});
