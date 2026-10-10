/**
 * The daily stand-up: a calendar ping a little while after you arrive, then a short window in
 * meeting room A where the manager runs through the day. Times are seconds since you badged in.
 */

export const STANDUP = {
  /** When the "stand-up in 5" ping lands. */
  pingAt: 60,
  /** How long after the ping the meeting runs and you can join. */
  openFor: 300,
  /** Meeting room A's table, where people gather. */
  table: { x: 10.75, z: 10, width: 3.2, depth: 1.4 },
  host: "Sam Tan",
} as const;

export type StandupPhase = "not-yet" | "on" | "over";

export function standupPhase(secondsInOffice: number): StandupPhase {
  if (secondsInOffice < STANDUP.pingAt) return "not-yet";
  return secondsInOffice < STANDUP.pingAt + STANDUP.openFor ? "on" : "over";
}

/** What the manager says, tuned to whether something is on fire and who you are. */
export function standupScript(isIncidentOpen: boolean, title: string): readonly string[] {
  if (isIncidentOpen) {
    return [
      "Quick one, folks — we have a live incident, so this is thirty seconds.",
      "Whoever's paged: you own it. Everyone else, stay off main and keep the channel clean.",
      `And our ${title.toLowerCase()} — that's you — checks in with the bridge after this.`,
    ];
  }
  return [
    "Morning, everyone. Yesterday we closed the retry-storm follow-ups.",
    "Today: the sale starts at ten, so treat checkout like glass. No risky deploys.",
    `On-call this week is our ${title.toLowerCase()} — that's you. Pager's quiet so far. Let's keep it that way.`,
    "Any blockers? No? Great. Go build something.",
  ];
}
