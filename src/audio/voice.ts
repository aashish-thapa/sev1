import { seededRandom } from "../domain/random.ts";
import type { SpeechBackend, SpeechVoice, UtteranceEnding } from "./speech.ts";

export type LinePriority = "normal" | "urgent";

/** How a `speak` call ended. "skipped" means it was never queued (locked, muted, no TTS). */
export type LineOutcome = UtteranceEnding | "cancelled" | "skipped";

export type SpeakOptions = {
  /** Urgent lines (PagerDuty, the IC shouting) cut off whoever is talking and jump the queue. */
  readonly priority?: LinePriority;
  readonly pitch?: number;
  readonly rate?: number;
};

export type SpokenLine = { readonly text: string; readonly speakerId: string; readonly priority: LinePriority };

export type DirectorEvent = "start" | "end";
export type DirectorListener = (line: SpokenLine) => void;

/** A character's voice: which installed voice, and how they pitch and pace it. */
export type Casting = { readonly voice: SpeechVoice | null; readonly pitch: number; readonly rate: number };

/** Whether speech may play right now, and how loud. Speech bypasses Web Audio, so mute and volume are applied here. */
export type SpeechGate = { readonly canSpeak: () => boolean; readonly volume: () => number };

export type VoiceDirectorOptions = {
  /** BCP 47 prefix voices must match; falls back to every voice if none do. */
  readonly lang?: string;
  /** Speaker ids cast in this order first, so the main characters get distinct voices deterministically. */
  readonly cast?: readonly string[];
};

type QueuedLine = SpokenLine & { readonly options: SpeakOptions; readonly settle: (outcome: LineOutcome) => void };

const PITCH_RANGE = { min: 0, max: 2 } as const;
const RATE_RANGE = { min: 0.1, max: 10 } as const;
/** Roughly how fast desktop TTS engines read English at rate 1. */
const CHARACTERS_PER_SECOND = 14;
const WATCHDOG_GRACE_MS = 3000;

/**
 * Speaks one line at a time. Engines occasionally never report `end` (Safari,
 * Chrome's network voices), so each line also has a watchdog sized to its text:
 * a stuck utterance must not silence every character after it.
 */
export class VoiceDirector {
  private readonly backend: SpeechBackend | undefined;
  private readonly gate: SpeechGate;
  private readonly lang: string;
  private readonly cast: readonly string[];
  private readonly listeners: Record<DirectorEvent, Set<DirectorListener>> = { start: new Set(), end: new Set() };
  private readonly castings = new Map<string, Casting>();
  private readonly stopListeningForVoices: () => void;
  private queue: QueuedLine[] = [];
  private current: QueuedLine | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private voices: readonly SpeechVoice[] = [];

  constructor(backend: SpeechBackend | undefined, gate: SpeechGate, options: VoiceDirectorOptions = {}) {
    this.backend = backend;
    this.gate = gate;
    this.lang = (options.lang ?? "en").toLowerCase();
    this.cast = options.cast ?? [];
    this.refreshVoices();
    this.stopListeningForVoices = backend?.onVoicesChanged(() => this.refreshVoices()) ?? (() => undefined);
  }

  get isSpeaking(): boolean {
    return this.current !== null;
  }

  /** True while a line is playing or waiting; listeners use it to hold the duck between lines. */
  get isBusy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  get currentLine(): SpokenLine | null {
    return this.current && toSpokenLine(this.current);
  }

  speak(text: string, speakerId: string, options: SpeakOptions = {}): Promise<LineOutcome> {
    const trimmed = text.trim();
    if (!this.backend || trimmed === "" || !this.gate.canSpeak()) return Promise.resolve("skipped");
    const priority = options.priority ?? "normal";
    return new Promise((settle) => {
      const line: QueuedLine = { text: trimmed, speakerId, priority, options, settle };
      if (priority === "urgent") {
        const firstNormal = this.queue.findIndex((queued) => queued.priority === "normal");
        this.queue.splice(firstNormal === -1 ? this.queue.length : firstNormal, 0, line);
        if (this.current?.priority === "normal") this.stopCurrent("interrupted");
      } else {
        this.queue.push(line);
      }
      this.next();
    });
  }

  /** Silences the current line and drops everything queued. */
  cancel(): void {
    const dropped = this.queue;
    this.queue = [];
    for (const line of dropped) line.settle("cancelled");
    this.stopCurrent("cancelled");
  }

  castingFor(speakerId: string): Casting {
    const known = this.castings.get(speakerId);
    if (known) return known;
    const taken = new Set<string>();
    for (const casting of this.castings.values()) if (casting.voice) taken.add(casting.voice.voiceURI);
    const casting = castVoice(speakerId, this.voices, taken);
    // Only remember real choices: voices may still be loading, and a speaker
    // should get their proper voice as soon as it arrives.
    if (this.voices.length > 0) this.castings.set(speakerId, casting);
    return casting;
  }

  on(event: DirectorEvent, listener: DirectorListener): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  dispose(): void {
    this.cancel();
    this.stopListeningForVoices();
  }

  private next(): void {
    const backend = this.backend;
    if (this.current || !backend) return;
    const line = this.queue.shift();
    if (!line) return;
    this.current = line;

    const casting = this.castingFor(line.speakerId);
    const rate = clamp(line.options.rate ?? casting.rate, RATE_RANGE);
    const isCurrent = () => this.current === line;
    this.watchdog = globalThis.setTimeout(() => {
      if (!isCurrent()) return;
      backend.cancel();
      this.finish(line, "failed");
    }, expectedDurationMs(line.text, rate) + WATCHDOG_GRACE_MS);

    backend.speak(
      { text: line.text, voice: casting.voice, pitch: clamp(line.options.pitch ?? casting.pitch, PITCH_RANGE), rate, volume: this.gate.volume() },
      {
        onStart: () => {
          if (isCurrent()) this.emit("start", line);
        },
        onEnd: (ending) => {
          if (isCurrent()) this.finish(line, ending);
        },
      },
    );
  }

  private stopCurrent(outcome: LineOutcome): void {
    const line = this.current;
    if (!line) return;
    // Clear `current` first: the backend reports the cancelled utterance's end
    // asynchronously, and by then it must be ignored as stale.
    this.current = null;
    this.backend?.cancel();
    this.settle(line, outcome);
  }

  private finish(line: QueuedLine, outcome: LineOutcome): void {
    this.current = null;
    this.settle(line, outcome);
    this.next();
  }

  private settle(line: QueuedLine, outcome: LineOutcome): void {
    globalThis.clearTimeout(this.watchdog);
    this.watchdog = undefined;
    line.settle(outcome);
    this.emit("end", line);
  }

  private emit(event: DirectorEvent, line: QueuedLine): void {
    const spoken = toSpokenLine(line);
    for (const listener of this.listeners[event]) listener(spoken);
  }

  private refreshVoices(): void {
    const voices = eligibleVoices(this.backend?.voices() ?? [], this.lang);
    if (sameVoices(voices, this.voices)) return;
    this.voices = voices;
    this.castings.clear();
    for (const speakerId of this.cast) this.castingFor(speakerId);
  }
}

/**
 * Picks a voice by hashing the speaker id, probing past voices other speakers
 * already hold. When everyone has to share, pitch and pace spread wider so the
 * characters stay tellable apart.
 */
export function castVoice(speakerId: string, voices: readonly SpeechVoice[], taken: ReadonlySet<string>): Casting {
  const random = seededRandom(`voice:${speakerId}`);
  const start = Math.floor(random() * voices.length);
  let voice: SpeechVoice | null = null;
  for (let probe = 0; probe < voices.length && !voice; probe += 1) {
    const candidate = voices[(start + probe) % voices.length];
    if (!taken.has(candidate.voiceURI)) voice = candidate;
  }
  const isShared = voice === null;
  voice ??= voices[start] ?? null;
  const pitchSpread = isShared ? 0.3 : 0.1;
  return { voice, pitch: 1 + (random() * 2 - 1) * pitchSpread, rate: 1 + (random() * 2 - 1) * 0.07 };
}

/**
 * Voices in the wanted language, local ones preferred (Chrome's network voices
 * stop mid-sentence on long lines), sorted so the order is stable across loads.
 */
export function eligibleVoices(all: readonly SpeechVoice[], lang: string): readonly SpeechVoice[] {
  const inLanguage = all.filter((voice) => voice.lang.toLowerCase().startsWith(lang));
  const pool = inLanguage.length > 0 ? inLanguage : all;
  const local = pool.filter((voice) => voice.localService);
  return [...(local.length > 0 ? local : pool)].sort((left, right) => left.voiceURI.localeCompare(right.voiceURI));
}

function sameVoices(left: readonly SpeechVoice[], right: readonly SpeechVoice[]): boolean {
  return left.length === right.length && left.every((voice, index) => voice.voiceURI === right[index].voiceURI);
}

function expectedDurationMs(text: string, rate: number): number {
  return (text.length / (CHARACTERS_PER_SECOND * rate)) * 1000;
}

function clamp(value: number, range: { readonly min: number; readonly max: number }): number {
  return Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : 1;
}

function toSpokenLine(line: QueuedLine): SpokenLine {
  return { text: line.text, speakerId: line.speakerId, priority: line.priority };
}
