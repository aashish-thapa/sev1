import { describe, expect, it } from "vitest";
import { CompanyOffice, type OfficeRoomStore } from "./office.ts";

class MemoryOffices implements OfficeRoomStore {
  readonly members = new Map<string, string>([
    ["founder", "acme"],
    ["engineer", "acme"],
    ["rival", "globex"],
  ]);
  readonly codes = new Map<string, string>();

  async companyOfMember(userId: string) {
    return this.members.get(userId) ?? null;
  }
  async roomCodeOf(companyId: string) {
    return this.codes.get(companyId) ?? null;
  }
  async assignRoomCode(companyId: string, code: string) {
    if (this.codes.has(companyId) || [...this.codes.values()].includes(code)) return false;
    this.codes.set(companyId, code);
    return true;
  }
  async companyOfRoom(code: string) {
    return [...this.codes.entries()].find(([, held]) => held === code)?.[0] ?? null;
  }
}

/** A deterministic stream of "random" numbers, so generated codes differ attempt to attempt. */
const sequence = () => {
  let next = 0;
  return () => ((next += 0.137) % 1);
};

describe("company office", () => {
  it("gives every member of a company the same room, assigned once", async () => {
    const office = new CompanyOffice(new MemoryOffices(), async () => true, sequence());
    const first = await office.enter("founder");
    const second = await office.enter("engineer");
    expect(first?.code).toMatch(/^[A-Z]{4}$/);
    expect(second).toEqual(first);
  });

  it("skips codes a game room is already using", async () => {
    const tried: string[] = [];
    const office = new CompanyOffice(new MemoryOffices(), async (code) => (tried.push(code), tried.length > 2), sequence());
    const entered = await office.enter("founder");
    expect(tried).toHaveLength(3);
    expect(entered?.code).toBe(tried[2]);
  });

  it("has no office for players outside a company", async () => {
    const office = new CompanyOffice(new MemoryOffices(), async () => true, sequence());
    expect(await office.enter("stranger")).toBeNull();
  });

  it("lets only members through an office's door; other codes are ordinary rooms", async () => {
    const office = new CompanyOffice(new MemoryOffices(), async () => true, sequence());
    const entered = await office.enter("founder");
    if (!entered) throw new Error("no office");
    expect(await office.access(entered.code, "engineer")).toEqual({ kind: "member" });
    expect(await office.access(entered.code, "rival")).toEqual({ kind: "denied" });
    expect(await office.access(entered.code, null)).toEqual({ kind: "denied" });
    expect(await office.access("ZZZZ", null)).toEqual({ kind: "not-an-office" });
  });

  it("lets in an investor holding a deal's pass, and nobody else from outside", async () => {
    const pass = async (companyId: string, userId: string) => companyId === "acme" && userId === "investor";
    const office = new CompanyOffice(new MemoryOffices(), async () => true, sequence(), pass);
    const code = await office.roomOf("acme");
    if (!code) throw new Error("no code");
    expect(await office.enter("founder")).toEqual({ code });
    expect(await office.access(code, "investor")).toEqual({ kind: "visitor" });
    expect(await office.access(code, "founder")).toEqual({ kind: "member" });
    expect(await office.access(code, "rival")).toEqual({ kind: "denied" });
    expect(await office.access(code, null)).toEqual({ kind: "denied" });
  });
});
