import type { Role } from "../src/domain/incident.ts";
import type { Tier } from "../src/domain/tier.ts";

/** A matchmade room looking for opponents: its party size and what it would play. */
export type Ticket = {
  readonly code: string;
  readonly size: number;
  readonly tier: Tier;
  /** The scenario's lead role: opponents come from the same ladder, so nobody plays another role's incident. */
  readonly role: Role;
  /** Epoch milliseconds it started looking. */
  readonly since: number;
};

/** What matchmaking tells a room: host the match, move to the host's room, or that nobody turned up. */
export type MatchmakingOutcome =
  | { readonly kind: "host"; readonly guests: number }
  | { readonly kind: "guest"; readonly hostCode: string }
  | { readonly kind: "none" };

/** Where a matchmade room asks for opponents; outcomes come back to the room by its code. */
export interface Matchmaking {
  seek(ticket: Ticket): void;
  withdraw(code: string): void;
}

export type Pairing = { readonly host: Ticket; readonly guest: Ticket };

const isCompatible = (left: Ticket, right: Ticket) => left.code !== right.code && left.size === right.size && left.tier === right.tier && left.role === right.role;

/** Queues `ticket`, or pairs it with the longest-waiting compatible room, which hosts. A room never holds two tickets. */
export function enqueue(queue: readonly Ticket[], ticket: Ticket): { queue: readonly Ticket[]; pairing: Pairing | null } {
  const others = queue.filter((waiting) => waiting.code !== ticket.code);
  const host = [...others].sort((left, right) => left.since - right.since).find((waiting) => isCompatible(waiting, ticket));
  if (!host) return { queue: [...others, ticket], pairing: null };
  return { queue: others.filter((waiting) => waiting !== host), pairing: { host, guest: ticket } };
}

export function withdraw(queue: readonly Ticket[], code: string): readonly Ticket[] {
  return queue.filter((waiting) => waiting.code !== code);
}

/** Tickets that have waited `maxWaitMs` or longer, taken out of the queue. */
export function expire(queue: readonly Ticket[], now: number, maxWaitMs: number): { queue: readonly Ticket[]; expired: readonly Ticket[] } {
  const isExpired = (ticket: Ticket) => now - ticket.since >= maxWaitMs;
  return { queue: queue.filter((ticket) => !isExpired(ticket)), expired: queue.filter(isExpired) };
}

/** When the next ticket in the queue runs out of time; null when nobody's waiting. */
export function nextExpiry(queue: readonly Ticket[], maxWaitMs: number): number | null {
  return queue.length === 0 ? null : Math.min(...queue.map((ticket) => ticket.since)) + maxWaitMs;
}
