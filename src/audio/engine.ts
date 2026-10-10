import { clamp01, glide, type AudioOutput } from "./synth.ts";

export type BusName = "sfx" | "ambience" | "alarm";
export type AudioContextFactory = () => AudioContext | undefined;

type Graph = {
  readonly context: AudioContext;
  readonly master: GainNode;
  readonly voiceDuck: GainNode;
  readonly buses: Readonly<Record<BusName, GainNode>>;
};

const DEFAULT_VOLUME = 0.8;
const BUS_LEVELS: Readonly<Record<BusName, number>> = { sfx: 0.9, ambience: 0.75, alarm: 0.55 };
/** About -9 dB: beds stay present under dialogue instead of vanishing. */
const DUCKED_LEVEL = 0.35;
const DUCK_ATTACK_SECONDS = 0.2;
const DUCK_RELEASE_SECONDS = 0.9;
const MASTER_RAMP_SECONDS = 0.06;

/**
 * Owns the one AudioContext and its bus layout:
 *
 *   ambience ─┐
 *             ├─ voiceDuck ─┐
 *   alarm ────┘             ├─ master ─ limiter ─ speakers
 *   sfx ────────────────────┘
 *
 * The context is created inside `unlock()` so it starts "running" under the
 * browser's autoplay policy; until then every consumer gets no output.
 */
export class AudioEngine {
  private readonly createContext: AudioContextFactory;
  private readonly listeners = new Set<() => void>();
  private graph: Graph | null = null;
  private hasGesture = false;
  private muted = false;
  private volume = DEFAULT_VOLUME;

  constructor(createContext: AudioContextFactory = browserAudioContext) {
    this.createContext = createContext;
  }

  get isUnlocked(): boolean {
    return this.hasGesture;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get masterVolume(): number {
    return this.volume;
  }

  /**
   * Call from a click/keydown/pointerdown handler. Safe to call on every gesture:
   * iOS Safari moves the context to "interrupted" when the page is backgrounded,
   * and only a later gesture may resume it.
   */
  unlock(): void {
    if (!this.hasGesture) {
      this.hasGesture = true;
      this.graph = this.buildGraph();
      this.notify();
    }
    this.resumeIfHalted();
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.applyMasterLevel();
    this.notify();
  }

  setMasterVolume(volume: number): void {
    const next = clamp01(volume);
    if (next === this.volume) return;
    this.volume = next;
    this.applyMasterLevel();
    this.notify();
  }

  /** Lowers ambience and alarm so a speaking character stays intelligible. */
  setDucked(ducked: boolean): void {
    if (!this.graph) return;
    glide(
      this.graph.voiceDuck.gain,
      ducked ? DUCKED_LEVEL : 1,
      this.graph.context,
      ducked ? DUCK_ATTACK_SECONDS : DUCK_RELEASE_SECONDS,
    );
  }

  /** The bus to render into, or null before unlock or where Web Audio is unavailable. */
  output(bus: BusName): AudioOutput | null {
    if (!this.graph) return null;
    return { context: this.graph.context, destination: this.graph.buses[bus] };
  }

  /** Arrow property so it can be handed straight to useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private applyMasterLevel(): void {
    if (!this.graph) return;
    glide(this.graph.master.gain, this.muted ? 0 : this.volume, this.graph.context, MASTER_RAMP_SECONDS);
  }

  private resumeIfHalted(): void {
    const context = this.graph?.context;
    if (!context || context.state === "running" || context.state === "closed") return;
    context.resume().catch((error: unknown) => {
      // Rejected if the context was closed underneath us; silence is the right outcome.
      if (!(error instanceof DOMException)) throw error;
    });
  }

  private buildGraph(): Graph | null {
    const context = this.openContext();
    if (!context) return null;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(context.destination);

    const master = context.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    master.connect(limiter);

    const voiceDuck = context.createGain();
    voiceDuck.connect(master);

    const bus = (name: BusName, into: AudioNode) => {
      const node = context.createGain();
      node.gain.value = BUS_LEVELS[name];
      node.connect(into);
      return node;
    };
    const buses = { sfx: bus("sfx", master), ambience: bus("ambience", voiceDuck), alarm: bus("alarm", voiceDuck) };
    return { context, master, voiceDuck, buses };
  }

  private openContext(): AudioContext | null {
    try {
      return this.createContext() ?? null;
    } catch (error) {
      // NotSupportedError: the device refused the requested configuration.
      if (error instanceof DOMException) return null;
      throw error;
    }
  }
}

function browserAudioContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  return new AudioContext({ latencyHint: "interactive" });
}
