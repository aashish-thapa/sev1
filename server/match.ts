import type { ServerMessage } from "../src/multiplayer/protocol.ts";
import type { Scenario } from "../src/warroom/scenario.ts";
import {
  ARRIVAL_TIMEOUT_MS,
  decide,
  MATCH_TIME_LIMIT_MS,
  OVERTIME_MS,
  pickTeam,
  PLAYERS_PER_TEAM,
  SEARCH_TIMEOUT_MS,
  TEAM_LABEL,
  TEAMS,
  type LaneStanding,
  type MatchStage,
  type Team,
} from "../src/warroom/versus.ts";
import type { Logger } from "./log.ts";
import type { Matchmaking, MatchmakingOutcome } from "./matchmaking.ts";
import { Room, type Connection, type JoinOutcome, type JoinRequest, type Kickoff, type RoomTiming } from "./room.ts";
import type { Venue } from "./venue.ts";

const REFEREE = "Referee";
/** How often standings go out while the match is on: often enough to feel live, cheap on the free tier. */
const STANDINGS_INTERVAL_MS = 1000;
/** If matchmaking never answers (a host restarted mid-search), the room stops waiting after this long. */
const SEARCH_SAFETY_MS = SEARCH_TIMEOUT_MS * 2;

/** How the other team turns up: by code (versus), or through matchmaking with a bot crew behind it (matchmade). */
export type MatchFormat = "versus" | "matchmade";

/** Where a newcomer sits, or why they can't. */
type Seating = { readonly team: Team } | { readonly refusal: string };

export type MatchSetup = {
  readonly format: MatchFormat;
  /** Only a matchmade match asks for opponents. */
  readonly matchmaking: Matchmaking;
  readonly now?: () => number;
};

/**
 * Two teams, each in a room of its own, racing the same seeded incident. Both rooms are held quiet
 * until the lineup is settled; then they start together and the match keeps score.
 *
 * Versus: players split between the sides and the race starts when someone pages with both present.
 * Matchmade: everyone here is one party on red; paging looks for another party of the same size and
 * tier. Matchmaking either sends that party here to play blue, sends this party to theirs, or finds
 * nobody, and then a bot crew plays blue.
 */
export class Match implements Venue, Kickoff {
  readonly mode: MatchFormat;
  readonly capacity = PLAYERS_PER_TEAM * TEAMS.length;
  readonly code: string;
  readonly scenario: Scenario;
  private sides: Readonly<Record<Team, Room>>;
  private readonly timing: RoomTiming;
  private readonly logger: Logger;
  private readonly matchmaking: Matchmaking;
  private readonly onOccupancyChange: (venue: Venue) => void;
  private readonly now: () => number;
  private stage: MatchStage = { name: "lineup" };
  /** Epoch ms: when the search began, when the paired party is given up on, and the race and overtime deadlines. */
  private searchStartedAt: number | null = null;
  private arrivalEndsAt: number | null = null;
  private expectedGuests = 0;
  private raceEndsAt: number | null = null;
  private overtimeEndsAt: number | null = null;
  /** This party was sent to another room; there's nothing left to play here. */
  private hasMovedAway = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(code: string, scenario: Scenario, timing: RoomTiming, logger: Logger, onOccupancyChange: (venue: Venue) => void, setup: MatchSetup) {
    this.code = code;
    this.scenario = scenario;
    this.timing = timing;
    this.logger = logger;
    this.onOccupancyChange = onOccupancyChange;
    this.mode = setup.format;
    this.matchmaking = setup.matchmaking;
    this.now = setup.now ?? Date.now;
    this.sides = { red: this.side("red", false), blue: this.side("blue", false) };
  }

  get hostName(): string | null {
    return this.rooms().map((room) => room.hostName).find((name) => name !== null) ?? null;
  }

  get connectedCount(): number {
    return this.rooms().reduce((sum, room) => sum + room.connectedCount, 0);
  }

  get isClosed(): boolean {
    return this.stage.name === "decided" || this.hasMovedAway;
  }

  join(request: JoinRequest, connection: Connection): JoinOutcome {
    const resume = request.resume;
    const home = resume ? this.rooms().find((room) => room.holdsSeat(resume.playerId)) : undefined;
    if (home) return home.join(request, connection);
    const seating = this.mode === "versus" ? this.versusSeat(request.team) : this.matchmadeSeat(request.team);
    if ("refusal" in seating) return { ok: false, code: "room_full", message: seating.refusal };
    return this.sides[seating.team].join(request, connection);
  }

  /** Someone paged from the lineup: versus starts both sides; matchmade starts looking for opponents. */
  requested(room: Room, playerId: string) {
    if (this.stage.name !== "lineup") return;
    if (this.mode === "matchmade") return this.seek(playerId);
    if (this.rooms().some((side) => side.connectedCount === 0)) {
      room.notify(REFEREE, "Waiting for the other team. Share the room code; the match starts when both sides have someone and one of you pages.");
      return;
    }
    this.startRace(playerId);
  }

  /** What matchmaking decided for this room's search; anything arriving after the search ended is stale and ignored. */
  onMatchmaking(outcome: MatchmakingOutcome) {
    if (this.stage.name !== "searching") return;
    switch (outcome.kind) {
      case "host":
        this.stage = { name: "found" };
        this.expectedGuests = outcome.guests;
        this.arrivalEndsAt = this.now() + ARRIVAL_TIMEOUT_MS;
        this.tell(`Opponents found: ${outcome.guests === 1 ? "one engineer is" : `${outcome.guests} engineers are`} on the way to play blue.`);
        this.logger("info", "match_paired", { room: this.code, as: "host", guests: outcome.guests });
        this.publish();
        return;
      case "guest":
        this.stage = { name: "found" };
        this.hasMovedAway = true;
        this.stopTimer();
        this.logger("info", "match_paired", { room: this.code, as: "guest", host: outcome.hostCode });
        this.sides.red.announce({ type: "move", roomCode: outcome.hostCode, team: "blue" });
        this.onOccupancyChange(this);
        return;
      case "none":
        this.raceTheBots();
        return;
    }
  }

  dispose() {
    this.stopTimer();
    if (this.stage.name === "searching") this.matchmaking.withdraw(this.code);
    for (const room of this.rooms()) room.dispose();
  }

  private side(team: Team, isBotCrew: boolean): Room {
    return new Room(this.code, this.scenario, this.timing, this.logger, () => this.occupancyChanged(), { kickoff: this, team, mode: this.mode, isBotCrew });
  }

  /** Versus: the side asked for if it has room, else the smaller one. */
  private versusSeat(asked: Team | undefined): Seating {
    const headcount = { red: this.sides.red.seatCount, blue: this.sides.blue.seatCount };
    if (asked && headcount[asked] < PLAYERS_PER_TEAM) return { team: asked };
    const team = pickTeam(headcount);
    return team ? { team } : { refusal: `Match ${this.code} already has two full teams.` };
  }

  /** Matchmade: friends join the party on red before the search; once paired, the other party arrives on blue. */
  private matchmadeSeat(asked: Team | undefined): Seating {
    if (this.stage.name === "lineup") {
      return this.sides.red.seatCount < PLAYERS_PER_TEAM ? { team: "red" } : { refusal: `The party in ${this.code} is full.` };
    }
    const isExpected = this.stage.name === "found" && !this.hasMovedAway && asked === "blue" && this.sides.blue.seatCount < this.expectedGuests;
    return isExpected ? { team: "blue" } : { refusal: `${this.code} is already in a match.` };
  }

  private seek(playerId: string) {
    const size = this.sides.red.connectedCount;
    this.stage = { name: "searching", msElapsed: 0 };
    this.searchStartedAt = this.now();
    this.matchmaking.seek({ code: this.code, size, tier: this.scenario.tier, role: this.scenario.roles[0] ?? "infrastructure", since: this.searchStartedAt });
    this.tell(`Looking for ${size === 1 ? "an opponent" : `a team of ${size}`}. If nobody turns up soon, a bot crew will race you.`);
    this.logger("info", "match_seeking", { room: this.code, size, by: playerId });
    this.startTimer();
    this.publish();
  }

  /** Nobody to play: a bot crew takes blue and the race starts. */
  private raceTheBots() {
    if (this.stage.name === "searching") this.matchmaking.withdraw(this.code);
    this.sides.blue.dispose();
    this.sides = { ...this.sides, blue: this.side("blue", true) };
    this.tell("Nobody else is on call right now, so you're racing the bot crew.");
    this.startRace("matchmaking");
  }

  private startRace(by: string) {
    this.stage = { name: "racing" };
    this.raceEndsAt = this.now() + MATCH_TIME_LIMIT_MS;
    for (const side of this.rooms()) side.start();
    this.tell("Match on. Both teams have the same outage. When one side closes, the other gets three minutes; best debrief wins.");
    this.logger("info", "match_started", { room: this.code, by, isVsBots: this.sides.blue.standing.crew === "bots" });
    this.startTimer();
    this.publish();
  }

  private occupancyChanged() {
    // The paired party has all arrived: no need to wait out the clock.
    if (this.stage.name === "found" && !this.hasMovedAway && this.sides.blue.connectedCount >= this.expectedGuests) this.startRace("arrival");
    this.publish();
    this.onOccupancyChange(this);
  }

  private tickSafely() {
    try {
      this.judge();
      this.publish();
    } catch (error) {
      this.logger("error", "match_tick_failed", { room: this.code, message: error instanceof Error ? error.message : String(error) });
      this.stopTimer();
    }
  }

  /** Moves the match on with the clock: a search or an arrival that's taken too long, overtime, a winner. */
  private judge() {
    const now = this.now();
    if (this.stage.name === "searching") {
      const elapsed = now - (this.searchStartedAt ?? now);
      if (elapsed >= SEARCH_SAFETY_MS) return this.raceTheBots();
      this.stage = { name: "searching", msElapsed: elapsed };
      return;
    }
    if (this.stage.name === "found") {
      if (this.hasMovedAway || this.arrivalEndsAt === null || now < this.arrivalEndsAt) return;
      // Whoever made it races; if nobody did, the bots do.
      if (this.sides.blue.connectedCount > 0) return this.startRace("arrival-timeout");
      return this.raceTheBots();
    }
    if (this.stage.name !== "racing" && this.stage.name !== "overtime") return;
    const lanes = this.lanes();
    if (this.overtimeEndsAt === null) {
      const first = lanes.find((lane) => lane.finish !== null);
      if (first) {
        this.overtimeEndsAt = now + OVERTIME_MS;
        this.tell(`${TEAM_LABEL[first.team]} closed their incident with ${first.finish?.points ?? 0} points. Overtime: three minutes for everyone else.`);
      }
    }
    const isOutOfTime = (this.overtimeEndsAt !== null && now >= this.overtimeEndsAt) || (this.raceEndsAt !== null && now >= this.raceEndsAt);
    const winner = decide(lanes, isOutOfTime);
    if (winner) {
      this.stage = { name: "decided", winner };
      this.stopTimer();
      this.tell(winner === "draw" ? "It's a draw." : `${TEAM_LABEL[winner]} wins.`);
      this.logger("info", "match_decided", { room: this.code, winner });
      this.onOccupancyChange(this);
    } else if (this.overtimeEndsAt !== null) {
      this.stage = { name: "overtime", msLeft: Math.max(0, this.overtimeEndsAt - now) };
    }
  }

  private publish() {
    const message: ServerMessage = { type: "match", stage: this.stage, lanes: this.lanes() };
    for (const room of this.rooms()) room.announce(message);
  }

  private tell(text: string) {
    for (const room of this.rooms()) room.notify(REFEREE, text);
  }

  private lanes(): LaneStanding[] {
    return TEAMS.map((team) => ({ team, ...this.sides[team].standing }));
  }

  private rooms(): Room[] {
    return TEAMS.map((team) => this.sides[team]);
  }

  private startTimer() {
    if (!this.timer) this.timer = setInterval(() => this.tickSafely(), STANDINGS_INTERVAL_MS);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
