import { describe, expect, it } from "vitest";
import {
  amountOf,
  CARD_BONUS_CENTS,
  emptyWallet,
  INCIDENT_CENTS_PER_POINT,
  LEDGER_LIMIT,
  pay,
  payRef,
  SALARY_CENTS_PER_MINUTE,
  type Wallet,
} from "./economy.ts";
import { isPlausibleProgress, isPlausibleWallet } from "./audit.ts";
import { earn, emptyProgress, ProgressSchema } from "./progress.ts";

const T0 = 1_760_000_000_000;
let refCounter = 0;
/** Each call is a distinct earning, as in play; reuse a returned value to model a retry. */
const salary = () => ({ kind: "salary", ref: `salary:test:${(refCounter += 1)}`, minutes: 1, level: 2 }) as const;
const ratedCard = () => ({ kind: "card", ref: `card:test:${(refCounter += 1)}`, difficulty: 2, mode: "rated", title: "Pool exhausted" }) as const;
const incident = (points: number) => ({ kind: "incident", ref: `incident:test:${(refCounter += 1)}`, points, title: "Checkout meltdown", isTeam: false }) as const;

function payMany(wallet: Wallet, payments: readonly Parameters<typeof pay>[1][]): Wallet {
  return payments.reduce((current, payment, index) => pay(current, payment, T0 + index * 1000), wallet);
}

describe("pay rules", () => {
  it("pays salary per whole active minute", () => {
    expect(amountOf({ ...salary(), minutes: 3 })).toBe(3 * SALARY_CENTS_PER_MINUTE[2]);
    expect(amountOf({ ...salary(), minutes: 0.9 })).toBe(0);
  });

  it("pays practice a fraction of a rated call", () => {
    const practice = amountOf({ ...ratedCard(), mode: "practice" });
    expect(practice).toBeGreaterThan(0);
    expect(practice).toBeLessThan(CARD_BONUS_CENTS[2]);
  });

  it("scales an incident bonus by points and pays nothing for a botched fix", () => {
    expect(amountOf(incident(100))).toBe(100 * INCIDENT_CENTS_PER_POINT);
    expect(amountOf(incident(60))).toBe(60 * INCIDENT_CENTS_PER_POINT);
    expect(amountOf(incident(20))).toBe(0);
  });
});

describe("wallet", () => {
  it("credits the balance, the per-reason totals and the ledger together", () => {
    const wallet = payMany(emptyWallet(), [salary(), ratedCard(), incident(80)]);
    expect(wallet.balanceCents).toBe(SALARY_CENTS_PER_MINUTE[2] + CARD_BONUS_CENTS[2] + 80 * INCIDENT_CENTS_PER_POINT);
    expect(wallet.paidUnits).toEqual({ salary: 1, card: 1, incident: 1 });
    expect(wallet.ledger.map((entry) => entry.reason)).toEqual(["salary", "card", "incident"]);
    expect(wallet.ledger.every((entry) => Number.isInteger(entry.amountCents))).toBe(true);
  });

  it("leaves the wallet untouched for a payment worth nothing", () => {
    const wallet = emptyWallet();
    expect(pay(wallet, incident(10), T0)).toBe(wallet);
  });

  it("pays an earning once, however often it is credited", () => {
    const card = ratedCard();
    const once = pay(emptyWallet(), card, T0);
    expect(pay(once, card, T0 + 5_000)).toBe(once);
  });

  it("keeps only the newest ledger lines", () => {
    const wallet = payMany(emptyWallet(), Array.from({ length: LEDGER_LIMIT + 5 }, () => salary()));
    expect(wallet.ledger).toHaveLength(LEDGER_LIMIT);
    expect(wallet.ledger[0].seq).toBe(5);
    expect(wallet.balanceCents).toBe((LEDGER_LIMIT + 5) * SALARY_CENTS_PER_MINUTE[2]);
  });

  it("lets saves from before the wallet existed parse with an empty one", () => {
    const { wallet: _wallet, ...legacy } = emptyProgress();
    const parsed = ProgressSchema.parse(JSON.parse(JSON.stringify({ ...legacy, history: [], streak: { count: 0, lastShiftDay: null } })));
    expect(parsed.wallet).toEqual(emptyWallet());
  });
});

describe("isPlausibleWallet", () => {
  const start = payMany(emptyWallet(), [salary(), ratedCard()]);

  it("accepts honest play", () => {
    const later = payMany(start, [salary(), salary(), ratedCard(), ratedCard(), incident(90)]);
    expect(isPlausibleWallet(start, later, 3 * 60)).toBe(true);
  });

  it("accepts a ledger truncated by the cap when the totals still add up", () => {
    const later = payMany(start, Array.from({ length: LEDGER_LIMIT + 10 }, () => salary()));
    expect(isPlausibleWallet(start, later, (LEDGER_LIMIT + 10) * 60)).toBe(true);
  });

  it("rejects more salary minutes than time passed", () => {
    const later = payMany(start, Array.from({ length: 30 }, () => salary()));
    expect(isPlausibleWallet(start, later, 5 * 60)).toBe(false);
  });

  it("rejects more incidents than could be closed in the time", () => {
    const later = payMany(start, Array.from({ length: 10 }, () => incident(100)));
    expect(isPlausibleWallet(start, later, 60)).toBe(false);
  });

  it("rejects a balance edited without earnings behind it", () => {
    const forged = { ...start, balanceCents: start.balanceCents + 1_000_000 };
    expect(isPlausibleWallet(start, forged, 3600)).toBe(false);
  });

  it("rejects totals inflated in step with the balance but with no ledger lines", () => {
    const forged: Wallet = {
      ...start,
      balanceCents: start.balanceCents + CARD_BONUS_CENTS[3],
      earnedCents: { ...start.earnedCents, card: start.earnedCents.card + CARD_BONUS_CENTS[3] },
      paidUnits: { ...start.paidUnits, card: start.paidUnits.card + 1 },
      nextSeq: start.nextSeq + 1,
    };
    expect(isPlausibleWallet(start, forged, 3600)).toBe(false);
  });

  it("rejects a sync that pays an already-stored earning again", () => {
    const card = ratedCard();
    const paid = pay(start, card, T0);
    const replayed: Wallet = {
      ...paid,
      balanceCents: paid.balanceCents + CARD_BONUS_CENTS[2],
      earnedCents: { ...paid.earnedCents, card: paid.earnedCents.card + CARD_BONUS_CENTS[2] },
      paidUnits: { ...paid.paidUnits, card: paid.paidUnits.card + 1 },
      nextSeq: paid.nextSeq + 1,
      ledger: [...paid.ledger, { ...paid.ledger.at(-1)!, seq: paid.nextSeq }],
    };
    expect(isPlausibleWallet(paid, replayed, 3600)).toBe(false);
  });

  it("rejects money going backwards and negative time", () => {
    expect(isPlausibleWallet(start, emptyWallet(), 60)).toBe(false);
    expect(isPlausibleWallet(start, start, -1)).toBe(false);
  });

  it("is what isPlausibleProgress applies to saves", () => {
    const before = earn(emptyProgress(), salary(), T0);
    const after = earn(before, ratedCard(), T0 + 30_000);
    expect(isPlausibleProgress(before, after, 30)).toBe(true);
    expect(isPlausibleProgress(after, before, 30)).toBe(false);
  });
});

describe("payRef", () => {
  it("names the same earning the same way on a retry, and different earnings differently", () => {
    const minuteStart = Math.floor(T0 / 60_000) * 60_000;
    expect(payRef.salary(minuteStart)).toBe(payRef.salary(minuteStart + 59_000));
    expect(payRef.salary(minuteStart)).not.toBe(payRef.salary(minuteStart + 60_000));
    expect(payRef.card("db-pool-1", T0)).not.toBe(payRef.card("db-pool-1", T0 + 1));
    expect(payRef.incident("checkout-meltdown", T0)).toBe("incident:checkout-meltdown:" + T0);
  });
});
