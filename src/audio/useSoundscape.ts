import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AudioEngine } from "./engine.ts";
import { createSoundscapeLoops, type Loop } from "./loops.ts";
import { soundscapeFor, type SoundscapeMix, type SoundscapeState } from "./soundscape.ts";

export type SoundscapeEngine = Pick<AudioEngine, "isUnlocked" | "subscribe" | "output">;

/**
 * Keeps the looping beds in line with the game: beds start when they become
 * audible, ramp as the state moves, fade out when they reach zero, and all stop
 * on unmount. Before the engine is unlocked it only computes the mix.
 */
export function useSoundscape(engine: SoundscapeEngine, state: SoundscapeState): SoundscapeMix {
  const isUnlocked = useSyncExternalStore(engine.subscribe, () => engine.isUnlocked, () => false);
  // Loop construction builds no audio nodes, so memoising (rather than a ref) is safe.
  const loops = useMemo(() => createSoundscapeLoops(engine), [engine]);
  const mix = soundscapeFor(state);
  const { ambience, serverHum, rackProximity, alarm, alarmIntensity, heartbeat, heartbeatBpm } = mix;

  useEffect(() => {
    if (!isUnlocked) return;
    loops.serverHum.setProximity(rackProximity);
    loops.alarm.setIntensity(alarmIntensity);
    if (heartbeatBpm !== null) loops.heartbeat.setRate(heartbeatBpm);
    drive(loops.ambience, ambience);
    drive(loops.serverHum, serverHum);
    drive(loops.alarm, alarm);
    drive(loops.heartbeat, heartbeatBpm === null ? 0 : heartbeat);
  }, [loops, isUnlocked, ambience, serverHum, rackProximity, alarm, alarmIntensity, heartbeat, heartbeatBpm]);

  useEffect(
    () => () => {
      for (const loop of Object.values(loops)) loop.stop();
    },
    [loops],
  );

  return mix;
}

function drive(loop: Loop, level: number): void {
  loop.setLevel(level);
  if (level > 0) loop.start();
  else loop.stop();
}
