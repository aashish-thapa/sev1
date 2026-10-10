import type { LocalDate } from "./calendar.ts";

/** Plain-text result card: marks only, so it never spoils the incidents. */
export function shareText(day: LocalDate, results: readonly boolean[], streak: number, url: string): string {
  const correct = results.filter(Boolean).length;
  const marks = results.map((isCorrect) => (isCorrect ? "✓" : "✗")).join("");
  const streakLine = streak > 1 ? ` · ${streak}-day streak` : "";
  return `sev1 · ${day} · ${correct}/${results.length} resolved${streakLine}\n${marks}\n${url}`;
}
