import type { LocalDate } from "./calendar.ts";
import type { Level } from "./career.ts";
import type { DiagnoseIncident, FindLineIncident, IncidentCard } from "./incident.ts";
import { seededRandom, shuffled, type Random } from "./random.ts";

export const SHIFT_LENGTH = 12;

type Ramp = readonly IncidentCard["difficulty"][];

/**
 * Each level's shift, easy pages first and the hardest last. An intern sees a couple of
 * medium cards at the end; staff mostly hard ones. Engineer is the classic ramp.
 */
const RAMP_BY_LEVEL: Readonly<Record<Level, Ramp>> = {
  0: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  1: [1, 1, 1, 1, 2, 1, 2, 2, 1, 2, 2, 2],
  2: [1, 1, 1, 2, 2, 2, 2, 1, 2, 3, 3, 3],
  3: [1, 2, 2, 2, 2, 3, 2, 3, 3, 2, 3, 3],
  4: [2, 2, 2, 3, 3, 3, 2, 3, 3, 3, 3, 3],
};

/** A rating this far from the level's expected strength plays the neighbouring level's ramp. */
const RATING_FOR_LEVEL: Readonly<Record<Level, number>> = { 0: 950, 1: 1000, 2: 1050, 3: 1125, 4: 1200 };
const RATING_SLACK = 100;

/** Who's on shift: their career level, nudged by how they've actually been answering (overall rating). */
export type Pace = { readonly level: Level; readonly rating: number };

/** Engineer pace: the ramp every shift had before career levels. */
export const DEFAULT_PACE: Pace = { level: 2, rating: RATING_FOR_LEVEL[2] };

export function rampFor({ level, rating }: Pace): Ramp {
  const expected = RATING_FOR_LEVEL[level];
  const shift = rating >= expected + RATING_SLACK ? 1 : rating <= expected - RATING_SLACK ? -1 : 0;
  const played = Math.min(4, Math.max(0, level + shift)) as Level;
  return RAMP_BY_LEVEL[played];
}

export type PresentedDiagnose = {
  readonly kind: "diagnose";
  readonly incident: DiagnoseIncident;
  readonly options: readonly string[];
  readonly answerIndex: number;
};

export type PresentedFindLine = {
  readonly kind: "find-line";
  readonly incident: FindLineIncident;
};

export type PresentedIncident = PresentedDiagnose | PresentedFindLine;

/** Picks today's incident ids: same day + same history ⇒ same shift. */
export function planShift(
  library: readonly IncidentCard[],
  day: LocalDate,
  seenIds: ReadonlySet<string>,
  practiceRound?: number,
  pace: Pace = DEFAULT_PACE,
): string[] {
  const seed = practiceRound === undefined ? `shift:${day}` : `practice:${day}:${practiceRound}`;
  const random = seededRandom(seed);
  return pickAlongRamp(library, seenIds, random, rampFor(pace)).map((card) => card.id);
}

/** Option order is seeded per day and card, so a resumed shift looks identical. */
export function presentIncident(card: IncidentCard, day: LocalDate): PresentedIncident {
  if (card.kind === "find-line") return { kind: "find-line", incident: card };
  const order = shuffled(card.options.map((_, index) => index), seededRandom(`${day}:${card.id}`));
  return {
    kind: "diagnose",
    incident: card,
    options: order.map((index) => card.options[index]),
    answerIndex: order.indexOf(card.answer),
  };
}

function pickAlongRamp(library: readonly IncidentCard[], seenIds: ReadonlySet<string>, random: Random, ramp: Ramp): IncidentCard[] {
  // Fresh cards are preferred; seen ones only fill gaps once the library runs dry.
  const ordered = [
    ...shuffled(library.filter((card) => !seenIds.has(card.id)), random),
    ...shuffled(library.filter((card) => seenIds.has(card.id)), random),
  ];
  const takenIds = new Set<string>();
  const chosen: IncidentCard[] = [];

  for (const difficulty of ramp.slice(0, Math.min(SHIFT_LENGTH, library.length))) {
    const next =
      ordered.find((card) => !takenIds.has(card.id) && card.difficulty === difficulty) ??
      ordered.find((card) => !takenIds.has(card.id));
    if (!next) break;
    takenIds.add(next.id);
    chosen.push(next);
  }
  return chosen;
}

export type Choice =
  | { readonly kind: "option"; readonly index: number }
  | { readonly kind: "line"; readonly evidence: number; readonly line: number };

export function isCorrectChoice(presented: PresentedIncident, choice: Choice): boolean {
  if (presented.kind === "diagnose") return choice.kind === "option" && choice.index === presented.answerIndex;
  const { answer } = presented.incident;
  return choice.kind === "line" && choice.evidence === answer.evidence && choice.line === answer.line;
}
