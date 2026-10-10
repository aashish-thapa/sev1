import { useSyncExternalStore } from "react";
import { getAudio } from "../audio/index.ts";

/** Mutes everything — the beds, effects and voices — and remembers nothing; the room decides. */
export function SoundToggle() {
  const { engine } = getAudio();
  const isMuted = useSyncExternalStore(engine.subscribe, () => engine.isMuted, () => false);
  return (
    <button type="button" className="button button--quiet sound-toggle" aria-pressed={isMuted} onClick={() => engine.setMuted(!isMuted)}>
      {isMuted ? "Sound off" : "Sound on"}
    </button>
  );
}
