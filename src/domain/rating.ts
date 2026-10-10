import type { IncidentCard, Topic } from "./incident.ts";

export const STARTING_RATING = 1000;
const LEARNING_RATE = 32;

const CARD_RATING_BY_DIFFICULTY: Record<IncidentCard["difficulty"], number> = {
  1: 900,
  2: 1100,
  3: 1300,
};

export type TopicRatings = Partial<Record<Topic, number>>;

/** Elo update where the card is the opponent and its difficulty sets its strength. */
export function rateAttempt(
  ratings: TopicRatings,
  card: Pick<IncidentCard, "topic" | "difficulty">,
  isCorrect: boolean,
): TopicRatings {
  const current = ratings[card.topic] ?? STARTING_RATING;
  const cardRating = CARD_RATING_BY_DIFFICULTY[card.difficulty];
  const expected = 1 / (1 + 10 ** ((cardRating - current) / 400));
  const next = Math.round(current + LEARNING_RATE * ((isCorrect ? 1 : 0) - expected));
  return { ...ratings, [card.topic]: next };
}

export function overallRating(ratings: TopicRatings): number {
  const values = Object.values(ratings);
  if (values.length === 0) return STARTING_RATING;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
