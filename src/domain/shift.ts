import type { LocalDate } from "./calendar.ts";
import type { DiagnoseIncident, FindLineIncident, IncidentCard } from "./incident.ts";
import { seededRandom, shuffled, type Random } from "./random.ts";

export const SHIFT_LENGTH = 12;

/** Easy pages first, the hardest pages last — a shift ends on its boss incidents. */
const DIFFICULTY_RAMP: readonly IncidentCard["difficulty"][] = [1, 1, 1, 2, 2, 2, 2, 1, 2, 3, 3, 3];

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
): string[] {
  const seed = practiceRound === undefined ? `shift:${day}` : `practice:${day}:${practiceRound}`;
  const random = seededRandom(seed);
  return pickAlongRamp(library, seenIds, random).map((card) => card.id);
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

function pickAlongRamp(library: readonly IncidentCard[], seenIds: ReadonlySet<string>, random: Random): IncidentCard[] {
  // Fresh cards are preferred; seen ones only fill gaps once the library runs dry.
  const ordered = [
    ...shuffled(library.filter((card) => !seenIds.has(card.id)), random),
    ...shuffled(library.filter((card) => seenIds.has(card.id)), random),
  ];
  const takenIds = new Set<string>();
  const chosen: IncidentCard[] = [];

  for (const difficulty of DIFFICULTY_RAMP.slice(0, Math.min(SHIFT_LENGTH, library.length))) {
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
