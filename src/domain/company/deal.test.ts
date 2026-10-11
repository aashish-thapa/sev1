import { describe, expect, it } from "vitest";
import { agree, openDeal, propose, walkAway, type Deal } from "./deal.ts";

const terms = { amountCents: 100_000, equityBps: 1_000 };
const isDeal = (value: unknown): value is Deal => typeof value === "object";

describe("deals", () => {
  it("closes only when both sides agree to the same terms", () => {
    const founderAgreed = agree(openDeal(terms), "founder", terms);
    expect(founderAgreed).toMatchObject({ stage: "talking" });
    expect(isDeal(founderAgreed) && agree(founderAgreed, "investor", terms)).toEqual({ stage: "agreed", terms });
  });

  it("clears both agreements when the terms change", () => {
    const agreed = agree(openDeal(terms), "founder", terms) as Deal;
    const countered = propose(agreed, { amountCents: 120_000, equityBps: 1_000 }) as Deal;
    expect(countered).toMatchObject({ stage: "talking" });
    expect(countered.stage === "talking" && countered.agreed.size).toBe(0);
  });

  it("won't bind you to terms you didn't see", () => {
    expect(agree(openDeal(terms), "investor", { amountCents: 1, equityBps: 1 })).toBe("terms_changed");
  });

  it("refuses bad terms and anything after it closes", () => {
    expect(propose(openDeal(terms), { amountCents: 100, equityBps: 1_000 })).toBe("below_minimum_investment");
    expect(propose(openDeal(terms), { amountCents: 100_000, equityBps: 6_000 })).toBe("too_much_equity");
    const gone = walkAway(openDeal(terms), "investor") as Deal;
    expect(gone).toEqual({ stage: "walked-away", by: "investor" });
    expect(agree(gone, "founder", terms)).toBe("deal_closed");
  });
});
