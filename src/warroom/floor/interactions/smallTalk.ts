import type { Random } from "../../../domain/random.ts";

/** What a colleague says when you stop by on a quiet day. */
export const CALM_LINES: readonly string[] = [
  "Standup's at ten. I'll say 'no blockers' and mean it this time.",
  "The coffee machine is descaling again. Third time this week.",
  "Deploy freeze starts Thursday. So naturally everything ships Wednesday night.",
  "My OKR is literally 'reduce the number of OKRs'.",
  "Did you see the postmortem doc? Forty comments on the timeline, none on the fix.",
  "I renamed a variable and broke prod. Well, staging. Well, my laptop.",
  "Someone booked meeting room B for 'focus time'. Respect.",
  "On-call handoff is at five. Please let it be a quiet week.",
  "Who keeps putting fish in the office microwave?",
  "The flaky test is flaky again. I've started taking it personally.",
  "I've been in three meetings about having fewer meetings.",
  "If you see a pull request with 2,000 lines, no you didn't.",
  "Infra says it's DNS. It's always DNS until it's the certificate.",
  "There's cake in the kitchen. Someone's leaving or someone's shipping.",
  "My calendar says 'lunch' but my pager says otherwise.",
  "Retro's tomorrow. Bring your sticky notes and your feelings.",
  "We migrated the cron job to a queue. Now it fails asynchronously.",
  "The dashboards are all green. That's what worries me.",
  "Ticket says 'quick fix, 5 minutes'. It's been open since March.",
  "Remember to fill in your self-review. 'Exceeds expectations', obviously.",
  "I wrote a runbook. Nobody read it. So it's a diary now.",
  "The intern found a bug in code older than the intern.",
  "Product wants a dark mode for the status page. During an outage. Bold.",
  "Rollbacks are a feature. Say it with me.",
  "Laptop's at 3% and the charger is in a meeting room I'm not invited to.",
  "Fun fact: the 'temporary' feature flag turned four last week.",
  "I set an alert to tell me when an alert doesn't fire.",
  "Hydrate. Then deploy. Never the other way round.",
  "The all-hands moved to Friday at 4. On purpose, apparently.",
  "Pager was quiet all night. I don't trust it.",
  "Someone left 'TODO: remove before launch' in the launch.",
  "Code freeze is a state of mind.",
];

/** What a colleague says when you stop by while production is burning. */
export const PANIC_LINES: readonly string[] = [
  "Is that the checkout alarm? Please tell me that's a test.",
  "Support's queue just doubled. What do I tell them?",
  "I didn't touch anything. I want that on record.",
  "Should we roll back? Who has the deploy lock?",
  "Status page says 'investigating'. Are we investigating?",
  "My phone won't stop buzzing. Is it bad? It looks bad.",
  "Sales is asking if the sale is still on. Is it?",
  "I'll grab the incident doc. You fix things.",
  "Everyone's in the war room channel and nobody's typing.",
  "Don't merge anything. Don't even look at main.",
  "Whatever you're about to run, read it twice.",
];

/** A shuffled pass through a set of lines: nobody repeats themselves until they've said everything. */
export type Deck = { readonly order: readonly number[]; readonly next: number };

export function shuffledDeck(size: number, random: Random): Deck {
  const order = Array.from({ length: size }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return { order, next: 0 };
}

/** The next line's index and the deck after it; a finished deck is reshuffled. */
export function draw(deck: Deck, random: Random): { index: number; deck: Deck } {
  const current = deck.next < deck.order.length ? deck : shuffledDeck(deck.order.length, random);
  return { index: current.order[current.next], deck: { ...current, next: current.next + 1 } };
}
