import { describe, expect, it } from "vitest";
import { categoryById, ROLE_MINIMUM_PAY_CENTS, roomKindById, serverTierById, STARTER_SERVER_TIER } from "./catalog.ts";
import { capacityRps, checkOffer, checkServerPurchase, FOUNDING_MINIMUM_CENTS, racks, seats, settleWorkDay, uncoveredRoles, type CompanyBook } from "./rules.ts";

const shop: CompanyBook = {
  category: "ecommerce",
  fundsCents: 500_000,
  members: [
    { userId: "founder", role: "infrastructure", payCents: 15_000 },
    { userId: "maya", role: "frontend", payCents: 10_000 },
  ],
  rooms: ["bay", "server-room"],
  servers: ["medium"],
};

describe("company rules", () => {
  it("asks a founder for the first bay and a week of pay; the starter server is free", () => {
    expect(FOUNDING_MINIMUM_CENTS).toBe(roomKindById("bay").costCents + 7 * ROLE_MINIMUM_PAY_CENTS.infrastructure);
  });

  it("lets a just-founded company earn: its bay's closet holds the starter server", () => {
    const founded: CompanyBook = { category: "ecommerce", fundsCents: 84_000, members: [{ userId: "founder", role: "infrastructure", payCents: 12_000 }], rooms: ["bay"], servers: [STARTER_SERVER_TIER] };
    expect(racks(founded.rooms)).toBeGreaterThanOrEqual(founded.servers.length);
    const day = settleWorkDay(founded, { healthyShare: 1, tasksShipped: 0, contractorCents: 0 });
    expect(day.fundsAfter).toBeGreaterThan(founded.fundsCents);
  });

  it("refuses offers under the role's minimum or past the free desks", () => {
    expect(checkOffer(shop, "mobile", ROLE_MINIMUM_PAY_CENTS.mobile - 1, 0)).toBe("below_minimum");
    expect(checkOffer(shop, "mobile", ROLE_MINIMUM_PAY_CENTS.mobile, 0)).toBeNull();
    expect(checkOffer(shop, "mobile", ROLE_MINIMUM_PAY_CENTS.mobile, seats(shop.rooms) - shop.members.length)).toBe("no_free_desk");
  });

  it("needs a free rack for every server", () => {
    expect(checkServerPurchase({ ...shop, rooms: ["bay"], servers: ["small"] }, "small")).toBe("no_free_rack");
    expect(checkServerPurchase(shop, "small")).toBeNull();
    expect(checkServerPurchase({ ...shop, fundsCents: 0 }, "small")).toBe("not_enough_funds");
  });

  it("names the key roles nobody holds", () => {
    expect(uncoveredRoles(shop)).toEqual(["mobile", "data"]);
  });

  it("pays everyone in full on a healthy day, after revenue and upkeep", () => {
    const day = settleWorkDay(shop, { healthyShare: 1, tasksShipped: 2, contractorCents: 0 });
    const served = capacityRps(shop.servers) / categoryById("ecommerce").demandRps;
    expect(day.lines.find((line) => line.reason === "revenue")?.amountCents).toBe(Math.round(150_000 * served * 1.1));
    expect(day.payroll).toEqual([
      { userId: "founder", amountCents: 15_000 },
      { userId: "maya", amountCents: 10_000 },
    ]);
    expect(day.isPayrollShort).toBe(false);
    expect(day.fundsAfter).toBe(shop.fundsCents + day.lines.reduce((sum, line) => sum + line.amountCents, 0));
  });

  it("loses revenue to outages and missing servers", () => {
    const healthy = settleWorkDay(shop, { healthyShare: 1, tasksShipped: 0, contractorCents: 0 }).lines[0].amountCents;
    const halfDown = settleWorkDay(shop, { healthyShare: 0.5, tasksShipped: 0, contractorCents: 0 }).lines[0].amountCents;
    const noServers = settleWorkDay({ ...shop, servers: [] }, { healthyShare: 1, tasksShipped: 0, contractorCents: 0 });
    expect(halfDown).toBe(Math.round(healthy / 2));
    expect(noServers.lines.some((line) => line.reason === "revenue")).toBe(false);
  });

  it("shares what's left equally when funds can't cover payroll", () => {
    const broke = settleWorkDay({ ...shop, fundsCents: 0, servers: [] }, { healthyShare: 0, tasksShipped: 0, contractorCents: 0 });
    expect(broke.isPayrollShort).toBe(true);
    expect(broke.payroll.every((pay) => pay.amountCents === 0)).toBe(true);
    // Upkeep is a bay, a server room and a medium server: 2,000 + 5,000 + 1,200. That plus 12,500 leaves half of the 25,000 owed.
    const upkeep = roomKindById("bay").upkeepCents + roomKindById("server-room").upkeepCents + serverTierById("medium").upkeepCents;
    const tight = settleWorkDay({ ...shop, fundsCents: upkeep + 12_500 }, { healthyShare: 0, tasksShipped: 0, contractorCents: 0 });
    expect(tight.payroll).toEqual([
      { userId: "founder", amountCents: 7_500 },
      { userId: "maya", amountCents: 5_000 },
    ]);
  });

  it("books the pantry like upkeep, before payroll, so a big pantry bill can short pay", () => {
    const day = settleWorkDay(shop, { healthyShare: 1, tasksShipped: 0, contractorCents: 0, pantryCents: 1_850 });
    const reasons = day.lines.map((line) => line.reason);
    expect(day.lines.find((line) => line.reason === "pantry")?.amountCents).toBe(-1_850);
    expect(reasons.indexOf("pantry")).toBeLessThan(reasons.indexOf("payroll"));
    const without = settleWorkDay(shop, { healthyShare: 1, tasksShipped: 0, contractorCents: 0 });
    expect(without.fundsAfter - day.fundsAfter).toBe(1_850);
    expect(without.lines.some((line) => line.reason === "pantry")).toBe(false);
    const starved = settleWorkDay({ ...shop, fundsCents: 0, servers: [] }, { healthyShare: 0, tasksShipped: 0, contractorCents: 0, pantryCents: 10_000_000 });
    expect(starved.isPayrollShort).toBe(true);
  });
});

describe("company catalog", () => {
  it("has one entry per id, so every id the wire allows has prices", async () => {
    const { CATEGORIES, CATEGORY_IDS, ROOM_KINDS, ROOM_KIND_IDS, SERVER_TIERS, SERVER_TIER_IDS } = await import("./catalog.ts");
    expect(CATEGORIES.map((entry) => entry.id)).toEqual([...CATEGORY_IDS]);
    expect(ROOM_KINDS.map((entry) => entry.id)).toEqual([...ROOM_KIND_IDS]);
    expect(SERVER_TIERS.map((entry) => entry.id)).toEqual([...SERVER_TIER_IDS]);
  });
});
