import type { ClipName } from "../assets/catalog.ts";
import type { StandingActivity } from "../office.ts";

/** What a body is doing this frame; the avatar turns it into a clip and playback rate. */
export type Motion = { readonly clip: ClipName; readonly speed: number };

export type Situation =
  | { readonly state: "seated" }
  | { readonly state: "walking"; readonly speed: number }
  | { readonly state: "standing"; readonly activity: StandingActivity }
  | { readonly state: "speaking" };

/** Past this, the floor is visibly on fire: people hurry and talk with their hands. */
export const PANIC_THRESHOLD = 0.5;

const CALM_STANDING: Readonly<Record<StandingActivity, ClipName>> = {
  chatting: "talk",
  "on-phone": "phone",
  // Hands up in front of the chest, eyes down: the same pose holds an open laptop.
  "on-laptop": "phone",
  presenting: "talk",
  waiting: "idle",
};

export function motionFor(situation: Situation, panic: number, reduceMotion: boolean): Motion {
  const isPanicked = panic >= PANIC_THRESHOLD && !reduceMotion;
  switch (situation.state) {
    case "seated":
      return { clip: "desk", speed: 0 };
    case "walking":
      return { clip: isPanicked ? "hurry" : "walk", speed: situation.speed };
    case "speaking":
      return { clip: isPanicked ? "talk-nervous" : "talk", speed: 0 };
    case "standing":
      // Under an outage the phone comes out and everyone talks at once.
      if (isPanicked) return { clip: situation.activity === "on-phone" || situation.activity === "on-laptop" ? "phone" : "talk-nervous", speed: 0 };
      return { clip: CALM_STANDING[situation.activity], speed: 0 };
  }
}
