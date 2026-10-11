/** What the title screen tells you while it loads: what sev1 is, then how it plays. */
export const LOADING_TIPS = [
  "Production is down and you're holding the pager. sev1 is a game about the worst hour of an on-call shift.",
  "Quick shift: twelve incident cards a day, easiest first. Read the alert, the graph and the logs, then make the call.",
  "War Room: one live outage. Walk the server hall, then fight it from a bastion shell with kubectl, psql and curl.",
  "Declaring it resolved isn't the finish. Survive ten minutes of monitoring, then write the postmortem.",
  "Pick a role: Infra/SRE, Frontend, Mobile, Security or Data & ML. Each has a room and a wall screen in the office.",
  "Share a four-letter room code and up to five of you take the same outage. Nobody can fix it alone.",
  "Doing nothing makes it worse, and a plausible wrong fix can backfire. Read before you restart.",
  "You're paid for time on the floor. Save up, found a company, hire teammates and take investment.",
] as const;
