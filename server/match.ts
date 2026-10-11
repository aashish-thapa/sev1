import type { ServerMessage } from "../src/multiplayer/protocol.ts";
import type { Scenario } from "../src/warroom/scenario.ts";
import { decide, MATCH_TIME_LIMIT_MS, OVERTIME_MS, pickTeam, PLAYERS_PER_TEAM, TEAM_LABEL, TEAMS, type LaneStanding, type MatchStage, type Team } from "../src/warroom/versus.ts";
import type { Logger } from "./log.ts";
import { Room, type Connection, type JoinOutcome, type JoinRequest, type Kickoff, type RoomTiming } from "./room.ts";
import type { Venue } from "./venue.ts";

const REFEREE = "Referee";
/** How often standings go out while the match is on: often enough to feel live, cheap on the free tier. */
const STANDINGS_INTERVAL_MS = 1000;

/**
 * Two teams, each in a room of its own, racing the same seeded incident. Both rooms are held quiet
 * until someone pages with both sides present; then they start together and the match keeps score.
 */
export class Match implements Venue, Kickoff {
  readonly mode = "versus";
  readonly capacity = PLAYERS_PER_TEAM * TEAMS.length;
  readonly code: string;
  readonly scenario: Scenario;
  private readonly sides: Readonly<Record<Team, Room>>;
  private readonly logger: Logger;
  private readonly onOccupancyChange: (venue: Venue) => void;
  private readonly now: () => number;
  private stage: MatchStage = { name: "lineup" };
  private raceEndsAt: number | null = null;
  private overtimeEndsAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(code: string, scenario: Scenario, timing: RoomTiming, logger: Logger, onOccupancyChange: (venue: Venue) => void, now: () => number = Date.now) {
    this.code = code;
    this.scenario = scenario;
    this.logger = logger;
    this.onOccupancyChange = onOccupancyChange;
    this.now = now;
    const side = (team: Team) => new Room(code, scenario, timing, logger, () => this.occupancyChanged(), { kickoff: this, team });
    this.sides = { red: side("red"), blue: side("blue") };
  }

  get hostName(): string | null {
    return this.rooms().map((room) => room.hostName).find((name) => name !== null) ?? null;
  }

  get connectedCount(): number {
    return this.rooms().reduce((sum, room) => sum + room.connectedCount, 0);
  }

  get isClosed(): boolean {
    return this.stage.name === "decided";
  }

  /** A returning player goes back to their side; anyone else to the smaller one. */
  join(request: JoinRequest, connection: Connection): JoinOutcome {
    const resume = request.resume;
    const home = resume ? this.rooms().find((room) => room.holdsSeat(resume.playerId)) : undefined;
    if (home) return home.join(request, connection);
    const team = pickTeam({ red: this.sides.red.seatCount, blue: this.sides.blue.seatCount });
    if (!team) return { ok: false, code: "room_full", message: `Match ${this.code} already has two full teams.` };
    return this.sides[team].join(request, connection);
  }

  /** Someone paged from the lineup: start both sides together, once each has someone to play it. */
  requested(room: Room, playerId: string) {
    if (this.stage.name !== "lineup") return;
    if (this.rooms().some((side) => side.connectedCount === 0)) {
      room.notify(REFEREE, "Waiting for the other team. Share the room code; the match starts when both sides have someone and one of you pages.");
      return;
    }
    this.stage = { name: "racing" };
    this.raceEndsAt = this.now() + MATCH_TIME_LIMIT_MS;
    for (const side of this.rooms()) side.start();
    this.tell("Match on. Both teams have the same outage. When one side closes, the other gets three minutes; best debrief wins.");
    this.logger("info", "match_started", { room: this.code, by: playerId });
    this.timer = setInterval(() => this.tickSafely(), STANDINGS_INTERVAL_MS);
    this.publish();
  }

  dispose() {
    this.stopTimer();
    for (const room of this.rooms()) room.dispose();
  }

  private occupancyChanged() {
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

  /** Moves the match on from the latest standings: overtime once a side closes, a winner once it's settled. */
  private judge() {
    if (this.stage.name !== "racing" && this.stage.name !== "overtime") return;
    const lanes = this.lanes();
    const now = this.now();
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

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
