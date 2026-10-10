import { badgeById } from "../src/domain/achievements.ts";
import { knownTags } from "../src/domain/tags.ts";
import type { Role } from "../src/domain/incident.ts";
import type { IncidentNotice } from "../src/warroom/incident.ts";
import type { CommsMessage } from "../src/warroom/scenario.ts";

// Wording mirrors the single-player war room (useIncident's commsFor) so both modes read the same.

const PAGER = "PagerDuty";
const WAR_ROOM = "War room";

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export function noticeComms(notice: IncidentNotice, at: number): CommsMessage {
  switch (notice.kind) {
    case "refused":
      return { at, from: PAGER, text: `Can’t resolve: checkout 5xx is still ${percent(notice.errorRate)}.` };
    case "reopened":
      return {
        at,
        from: PAGER,
        text: `Re-triggered — 5xx back at ${percent(notice.errorRate)}${notice.wasRollingOut ? " while the rollout was still replacing pods" : ""}. The incident is open again.`,
      };
    case "closed":
      return { at, from: PAGER, text: "Quiet for 10 minutes. Incident closed — time for the postmortem." };
  }
}

export function declaredComms(name: string, at: number): CommsMessage {
  return { at, from: PAGER, text: `Marked resolved by ${name}. Monitoring for 10 minutes before closing.` };
}

export function chatComms(name: string, role: Role, text: string, at: number): CommsMessage {
  return { at, from: `${name} · ${role}`, text, kind: "chat" };
}

export function joinedComms(name: string, role: Role, badge: string | null, tags: readonly string[], at: number): CommsMessage {
  const shown = badge ? badgeById(badge) : undefined;
  const titles = knownTags(tags).map((tag) => ` [${tag.label}]`).join("");
  return { at, from: WAR_ROOM, text: `${name}${titles}${shown ? ` · ${shown.glyph} ${shown.title}` : ""} (${role}) joined.` };
}

export function leftComms(name: string, at: number): CommsMessage {
  return { at, from: WAR_ROOM, text: `${name} left.` };
}
