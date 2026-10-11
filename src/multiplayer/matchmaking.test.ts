import { describe, expect, it } from "vitest";
import { enqueue, expire, nextExpiry, withdraw, type Ticket } from "../../server/matchmaking.ts";

const ticket = (code: string, since: number, overrides: Partial<Ticket> = {}): Ticket => ({ code, size: 1, tier: 1, role: "infrastructure", since, ...overrides });

describe("the matchmaking queue", () => {
  it("queues a room nobody can play yet", () => {
    expect(enqueue([], ticket("AAAA", 0))).toEqual({ queue: [ticket("AAAA", 0)], pairing: null });
  });

  it("pairs with the longest-waiting room of the same size, tier and ladder, which hosts", () => {
    const queue = [ticket("BBBB", 5), ticket("AAAA", 1), ticket("SQAD", 0, { size: 2 }), ticket("TIER", 0, { tier: 2 }), ticket("ROLE", 0, { role: "security" })];
    const { queue: left, pairing } = enqueue(queue, ticket("NEWW", 9));
    expect(pairing).toEqual({ host: ticket("AAAA", 1), guest: ticket("NEWW", 9) });
    expect(left.map((waiting) => waiting.code)).toEqual(["BBBB", "SQAD", "TIER", "ROLE"]);
  });

  it("never pairs a room with itself, and a second ticket replaces its first", () => {
    expect(enqueue([ticket("AAAA", 0)], ticket("AAAA", 3))).toEqual({ queue: [ticket("AAAA", 3)], pairing: null });
  });

  it("drops a withdrawn room, and expires rooms that waited too long", () => {
    const queue = [ticket("AAAA", 0), ticket("BBBB", 20)];
    expect(withdraw(queue, "AAAA")).toEqual([ticket("BBBB", 20)]);
    expect(expire(queue, 30, 30)).toEqual({ queue: [ticket("BBBB", 20)], expired: [ticket("AAAA", 0)] });
    expect(nextExpiry(queue, 30)).toBe(30);
    expect(nextExpiry([], 30)).toBeNull();
  });
});
