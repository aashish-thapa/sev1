import { describe, expect, it } from "vitest";
import { CLUSTERS, DESKS, PLAYER_DESK } from "../office.ts";
import { boardFigures, FULL_OFFICE, myDeskIn, officePlan, planObstacles, type CompanyLayout } from "./plan.ts";

const member = (username: string, joinedAt: number, isFounder = false) => ({ username, role: "infrastructure" as const, payCents: 12_000, isFounder, joinedAt, canHire: isFounder });

const startup = (rooms: CompanyLayout["rooms"], servers: CompanyLayout["servers"], members = [member("ana", 1, true)]): CompanyLayout => ({ name: "Acme", category: "ecommerce", fundsCents: 0, rooms, servers, members });

describe("officePlan", () => {
  it("is the whole building outside a company", () => {
    expect(officePlan(null)).toBe(FULL_OFFICE);
    expect(myDeskIn(FULL_OFFICE, "anyone")).toBe(PLAYER_DESK);
  });

  it("gives a one-bay company one cluster, at your usual desk, a closet rack with its starter server, and a closed data centre", () => {
    const plan = officePlan(startup(["bay"], ["small"]));
    expect(plan.hasColleagues).toBe(false);
    expect(plan.clusters).toHaveLength(1);
    expect(plan.desks).toHaveLength(4);
    expect(plan.desks[0]).toEqual(PLAYER_DESK);
    expect(plan.isDataCentreOpen).toBe(false);
    expect(plan.racks).toEqual([expect.objectContaining({ key: "closet:0", server: "small" })]);
  });

  it("opens the data centre with a server room and racks servers closets first, then along the back wall", () => {
    const plan = officePlan(startup(["bay", "bay", "server-room"], ["small", "medium", "large"]));
    expect(plan.clusters).toHaveLength(2);
    expect(plan.isDataCentreOpen).toBe(true);
    expect(plan.racks.map((rack) => [rack.key, rack.server])).toEqual([
      ["closet:0", "small"],
      ["closet:1", "medium"],
      ["hall:0", "large"],
      ["hall:1", null],
      ["hall:2", null],
      ["hall:3", null],
    ]);
  });

  it("seats the founder first, then members in the order they joined", () => {
    const plan = officePlan(startup(["bay"], ["small"], [member("late", 30), member("ana", 1, true), member("early", 10)]));
    expect(plan.memberDesks.get("ana")).toEqual(PLAYER_DESK);
    expect(plan.memberDesks.get("early")).toEqual(plan.desks[1]);
    expect(plan.memberDesks.get("late")).toEqual(plan.desks[2]);
    expect(myDeskIn(plan, "late")).toEqual(plan.desks[2]);
    // A visitor gets the next desk nobody holds, not the founder's chair.
    expect(myDeskIn(plan, "visitor")).toEqual(plan.desks[3]);
  });

  it("never offers more clusters than the building has", () => {
    const plan = officePlan(startup(Array(20).fill("bay"), []));
    expect(plan.clusters).toHaveLength(CLUSTERS.length);
    expect(plan.desks).toHaveLength(DESKS.length);
  });

  it("leaves no obstacle where a cluster isn't, and shuts the data-centre door until there's a server room", () => {
    const small = planObstacles(officePlan(startup(["bay"], ["small"])));
    const open = planObstacles(officePlan(startup(["bay", "server-room"], [])));
    const empty = CLUSTERS.find((cluster) => cluster.x !== PLAYER_DESK.x && Math.abs(cluster.x - PLAYER_DESK.x) > 3) ?? CLUSTERS[0];
    const blocks = (obstacles: typeof small, x: number, z: number) => obstacles.some((box) => Math.abs(box.x - x) < box.width / 2 && Math.abs(box.z - z) < box.depth / 2);
    expect(blocks(small, empty.x, empty.z)).toBe(false);
    expect(blocks(small, 8, 1)).toBe(true);
    expect(blocks(open, 8, 1)).toBe(false);
  });

  it("hangs the board facing the first bay and stands the punch clock clear of its desks and closet, only in a company's office", () => {
    const plan = officePlan(startup(["bay"], ["small"]));
    const fixtures = plan.fixtures;
    if (!fixtures) throw new Error("a company office has its fixtures");
    const overlaps = (a: { x: number; z: number; width: number; depth: number }, b: typeof a) =>
      Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2;
    const others = planObstacles({ ...plan, fixtures: null });
    expect(others.some((box) => overlaps(box, fixtures.punchClock))).toBe(false);
    expect(planObstacles(plan)).toContainEqual(fixtures.punchClock);
    expect(plan.racks.some((rack) => Math.abs(rack.footprint.x - fixtures.board.x) < fixtures.board.width / 2)).toBe(false);
    expect(FULL_OFFICE.fixtures).toBeNull();
  });

  it("shows how much of today's traffic the servers can take, capped at all of it", () => {
    expect(boardFigures(startup(["bay"], ["small"]))).toEqual({ name: "Acme", fundsCents: 0, trafficPercent: 33 });
    expect(boardFigures(startup(["bay"], [])).trafficPercent).toBe(0);
    expect(boardFigures(startup(["bay"], ["large"])).trafficPercent).toBe(100);
  });
});
