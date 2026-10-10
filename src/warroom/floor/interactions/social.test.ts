import { describe, expect, it } from "vitest";
import { seededRandom } from "../../../domain/random.ts";
import { PEOPLE } from "../office.ts";
import { colleaguesIn } from "./colleagues.ts";
import { CALM_LINES, draw, PANIC_LINES, shuffledDeck } from "./smallTalk.ts";

describe("small talk", () => {
  it("has plenty to say, calm or on fire", () => {
    expect(CALM_LINES.length).toBeGreaterThanOrEqual(30);
    expect(PANIC_LINES.length).toBeGreaterThanOrEqual(10);
  });

  it("never repeats a line until every line has been said", () => {
    const random = seededRandom("talk");
    let deck = shuffledDeck(CALM_LINES.length, random);
    const said = new Set<number>();
    for (let turn = 0; turn < CALM_LINES.length; turn += 1) {
      const next = draw(deck, random);
      expect(said.has(next.index)).toBe(false);
      said.add(next.index);
      deck = next.deck;
    }
    expect(said.size).toBe(CALM_LINES.length);
    expect(draw(deck, random).index).toBeGreaterThanOrEqual(0);
  });
});

describe("colleagues", () => {
  it("includes desk workers and people standing about, but not the presenters at the screens", () => {
    const colleagues = colleaguesIn();
    expect(colleagues.some((colleague) => colleague.isSeated)).toBe(true);
    expect(colleagues.some((colleague) => !colleague.isSeated)).toBe(true);
    expect(colleagues.some((colleague) => colleague.id.startsWith("presenter-"))).toBe(false);
    expect(colleagues.length).toBeLessThanOrEqual(PEOPLE.length);
  });

  it("gives everyone a different first name", () => {
    const names = colleaguesIn().map((colleague) => colleague.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
