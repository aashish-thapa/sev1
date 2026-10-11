import { DurableObject } from "cloudflare:workers";
import { enqueue, expire, nextExpiry, withdraw, type MatchmakingOutcome, type Ticket } from "../server/matchmaking.ts";
import { SEARCH_TIMEOUT_MS } from "../src/warroom/versus.ts";
import type { Env } from "./env.ts";
import { workerLogger } from "./log.ts";

/** The one matchmaker every matchmade room asks. */
export const MATCHMAKER_NAME = "matchmaker";

const QUEUE_KEY = "queue";

/**
 * Pairs matchmade rooms. The queue lives in storage and an alarm runs out the oldest search, so a
 * wait survives the object being evicted. Outcomes go to each room's own object by its code.
 */
export class MatchmakerObject extends DurableObject<Env> {
  async seek(ticket: Ticket): Promise<void> {
    const { queue, pairing } = enqueue(await this.load(), ticket);
    await this.save(queue);
    if (!pairing) return;
    // The host hears first, so it's ready to seat the guests before they're told to move.
    await this.tell(pairing.host.code, { kind: "host", guests: pairing.guest.size });
    await this.tell(pairing.guest.code, { kind: "guest", hostCode: pairing.host.code });
  }

  async withdraw(code: string): Promise<void> {
    await this.save(withdraw(await this.load(), code));
  }

  override async alarm(): Promise<void> {
    const { queue, expired } = expire(await this.load(), Date.now(), SEARCH_TIMEOUT_MS);
    await this.save(queue);
    await Promise.all(expired.map((ticket) => this.tell(ticket.code, { kind: "none" })));
  }

  private async load(): Promise<readonly Ticket[]> {
    return (await this.ctx.storage.get<Ticket[]>(QUEUE_KEY)) ?? [];
  }

  private async save(queue: readonly Ticket[]): Promise<void> {
    await this.ctx.storage.put(QUEUE_KEY, queue);
    const at = nextExpiry(queue, SEARCH_TIMEOUT_MS);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** A room that's gone just misses its outcome; its own safety net puts it against the bots. */
  private async tell(code: string, outcome: MatchmakingOutcome): Promise<void> {
    try {
      await this.env.ROOMS.getByName(code).matchmaking(outcome);
    } catch (error) {
      workerLogger("warn", "matchmaking_delivery_failed", { room: code, kind: outcome.kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
