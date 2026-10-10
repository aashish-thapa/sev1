import { AudioEngine, type AudioContextFactory } from "./engine.ts";
import { browserSpeechBackend, type SpeechBackend } from "./speech.ts";
import { VoiceDirector, type VoiceDirectorOptions } from "./voice.ts";

export { AudioEngine, type AudioContextFactory, type BusName } from "./engine.ts";
export {
  chairCreak,
  coffeeBrew,
  doorOpen,
  failBuzz,
  footstep,
  keyClick,
  laptopOpen,
  notificationPing,
  pagerBuzz,
  successChime,
  typingBurst,
  type SfxTarget,
  type Surface,
} from "./sfx.ts";
export { Alarm, Heartbeat, ServerRoomHum, createSoundscapeLoops, officeAmbience, type Loop, type SoundscapeLoops } from "./loops.ts";
export { soundscapeFor, type SoundscapeMix, type SoundscapeState, type Zone } from "./soundscape.ts";
export {
  VoiceDirector,
  type Casting,
  type LineOutcome,
  type LinePriority,
  type SpeakOptions,
  type SpokenLine,
  type VoiceDirectorOptions,
} from "./voice.ts";
export { browserSpeechBackend, type SpeechBackend, type SpeechVoice } from "./speech.ts";
export { useSoundscape } from "./useSoundscape.ts";
export { useAudioUnlock } from "./useAudioUnlock.ts";

export type SoundSystem = { readonly engine: AudioEngine; readonly voice: VoiceDirector };

/**
 * Wires the engine and the voice director together: dialogue ducks the beds,
 * and speech (which bypasses Web Audio) follows the unlock, mute and volume.
 */
export function createSoundSystem(
  createContext?: AudioContextFactory,
  speech: SpeechBackend | undefined = browserSpeechBackend(),
  options?: VoiceDirectorOptions,
): SoundSystem {
  const engine = new AudioEngine(createContext);
  const voice = new VoiceDirector(
    speech,
    { canSpeak: () => engine.isUnlocked && !engine.isMuted, volume: () => engine.masterVolume },
    options,
  );
  voice.on("start", () => engine.setDucked(true));
  voice.on("end", () => engine.setDucked(voice.isBusy));
  engine.subscribe(() => {
    if (engine.isMuted) voice.cancel();
  });
  return { engine, voice };
}

let shared: SoundSystem | null = null;

/** The page-wide sound system, created on first use so importing this module costs nothing. */
export function getAudio(): SoundSystem {
  shared ??= createSoundSystem();
  return shared;
}
