export type LineVerdict = "picked-wrong" | "picked-right" | "answer";

/** Turns every line of a log or code block into a tap target for find-line cards. */
export type LineSelection = {
  readonly isLocked: boolean;
  readonly verdictFor: (line: number) => LineVerdict | undefined;
  readonly onPick: (line: number) => void;
};

export const VERDICT_LABEL: Record<LineVerdict, string> = {
  "picked-wrong": " — your pick, not the cause",
  "picked-right": " — your pick, correct",
  answer: " — the line that explains it",
};
