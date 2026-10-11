import { SEARCH_TIMEOUT_MS } from "../src/warroom/versus.ts";
import { enqueue, expire, nextExpiry, withdraw, type Matchmaking, type MatchmakingOutcome, type Ticket } from "./matchmaking.ts";

/** Hands an outcome to the room with that code, wherever it lives. */
export type DeliverOutcome = (code: string, outcome: MatchmakingOutcome) => void;

/** Matchmaking for every room in one process: a queue in memory and one timer for the next search to run out. */
export class LocalMatchmaker implements Matchmaking {
  private queue: readonly Ticket[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly deliver: DeliverOutcome;
  private readonly now: () => number;

  constructor(deliver: DeliverOutcome, now: () => number = Date.now) {
    this.deliver = deliver;
    this.now = now;
  }

  seek(ticket: Ticket) {
    const { queue, pairing } = enqueue(this.queue, ticket);
    this.queue = queue;
    // The host hears first, so it's ready to seat the guests before they're told to move.
    if (pairing) {
      this.deliver(pairing.host.code, { kind: "host", guests: pairing.guest.size });
      this.deliver(pairing.guest.code, { kind: "guest", hostCode: pairing.host.code });
    }
    this.schedule();
  }

  withdraw(code: string) {
    this.queue = withdraw(this.queue, code);
    this.schedule();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = nextExpiry(this.queue, SEARCH_TIMEOUT_MS);
    if (at !== null) this.timer = setTimeout(() => this.expireDue(), Math.max(0, at - this.now()));
  }

  private expireDue() {
    const { queue, expired } = expire(this.queue, this.now(), SEARCH_TIMEOUT_MS);
    this.queue = queue;
    for (const ticket of expired) this.deliver(ticket.code, { kind: "none" });
    this.schedule();
  }
}
