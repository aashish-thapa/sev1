import type { AudioEngine, BusName } from "./engine.ts";
import { chain, clamp01, filter, gainOf, glide, startNoise, startOscillator, strike } from "./synth.ts";

export type LoopTarget = Pick<AudioEngine, "output">;

/** A continuous bed. Every transition is a ramp, so start/stop/level never click. */
export interface Loop {
  readonly isRunning: boolean;
  start(): void;
  stop(): void;
  setLevel(level: number): void;
}

type BedParts<Controls> = {
  readonly sources: readonly AudioScheduledSourceNode[];
  readonly nodes: readonly AudioNode[];
  readonly controls: Controls;
  readonly dispose?: () => void;
};

type BedSpec<Controls> = {
  readonly bus: BusName;
  readonly fadeSeconds: number;
  /** Gain at level 1, calibrating each bed against the others. */
  readonly fullGain: number;
  readonly build: (context: AudioContext, into: AudioNode, at: number) => BedParts<Controls>;
};

type LiveBed<Controls> = { readonly context: AudioContext; readonly fader: GainNode; readonly parts: BedParts<Controls> };

const LEVEL_RAMP_SECONDS = 0.8;
const PARAMETER_RAMP_SECONDS = 1.2;

/**
 * Builds a fresh node graph on every start: source nodes are single-use, and a
 * graph still fading out can overlap a new one without either clicking.
 */
class Bed<Controls> implements Loop {
  private readonly target: LoopTarget;
  private readonly spec: BedSpec<Controls>;
  private live: LiveBed<Controls> | null = null;
  private level = 0;

  constructor(target: LoopTarget, spec: BedSpec<Controls>) {
    this.target = target;
    this.spec = spec;
  }

  get isRunning(): boolean {
    return this.live !== null;
  }

  /** The running graph's controls, or null while stopped. */
  get running(): { readonly context: AudioContext; readonly controls: Controls } | null {
    return this.live && { context: this.live.context, controls: this.live.parts.controls };
  }

  start(): void {
    if (this.live) return;
    const output = this.target.output(this.spec.bus);
    if (!output) return;
    const { context } = output;
    const fader = gainOf(context, 0);
    fader.connect(output.destination);
    const parts = this.spec.build(context, fader, context.currentTime);
    this.live = { context, fader, parts };
    glide(fader.gain, this.level * this.spec.fullGain, context, this.spec.fadeSeconds);
  }

  stop(): void {
    if (!this.live) return;
    const { context, fader, parts } = this.live;
    this.live = null;
    const fade = this.spec.fadeSeconds;
    // Half the fade as the glide time puts the tail ~50 dB down by the time sources stop.
    glide(fader.gain, 0, context, fade / 2);
    parts.dispose?.();
    for (const source of parts.sources) source.stop(context.currentTime + fade);
    globalThis.setTimeout(
      () => {
        for (const node of [...parts.sources, ...parts.nodes, fader]) node.disconnect();
      },
      (fade + 0.2) * 1000,
    );
  }

  setLevel(level: number): void {
    this.level = clamp01(level);
    if (this.live) glide(this.live.fader.gain, this.level * this.spec.fullGain, this.live.context, LEVEL_RAMP_SECONDS);
  }
}

/** HVAC rumble across the stereo field plus the murmur of a floor full of people. */
export function officeAmbience(target: LoopTarget): Loop {
  return new Bed(target, { bus: "ambience", fadeSeconds: 2.5, fullGain: 0.8, build: buildOfficeAmbience });
}

function buildOfficeAmbience(context: AudioContext, into: AudioNode, at: number): BedParts<null> {
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [];

  for (const side of [-0.6, 0.6]) {
    const rumble = startNoise(context, "brown", at);
    const duct = filter(context, "lowpass", 260);
    const panner = context.createStereoPanner();
    panner.pan.value = side;
    chain(rumble, duct, panner, into);
    sources.push(rumble);
    nodes.push(duct, panner);
  }

  const vent = startNoise(context, "pink", at);
  const ventBand = filter(context, "bandpass", 900, 0.5);
  const ventLevel = gainOf(context, 0.1);
  chain(vent, ventBand, ventLevel, into);
  sources.push(vent);
  nodes.push(ventBand, ventLevel);

  // Speech-band noise whose loudness drifts slowly (conversations come and go)
  // and flutters at roughly syllable rate, which is what makes it read as voices.
  for (const [side, driftHz, syllableHz] of [
    [-0.5, 0.23, 3.7],
    [0.5, 0.37, 4.3],
  ] as const) {
    const crowd = startNoise(context, "pink", at);
    const voiceBand = filter(context, "bandpass", 450, 1.2);
    const presence = filter(context, "peaking", 1400, 1, 3);
    const murmur = gainOf(context, 0.22);
    const panner = context.createStereoPanner();
    panner.pan.value = side;
    chain(crowd, voiceBand, presence, murmur, panner, into);

    const drift = startOscillator(context, "sine", driftHz, at);
    const driftDepth = gainOf(context, 0.12);
    const syllables = startOscillator(context, "sine", syllableHz, at);
    const syllableDepth = gainOf(context, 0.05);
    chain(drift, driftDepth);
    chain(syllables, syllableDepth);
    driftDepth.connect(murmur.gain);
    syllableDepth.connect(murmur.gain);

    sources.push(crowd, drift, syllables);
    nodes.push(voiceBand, presence, murmur, panner, driftDepth, syllableDepth);
  }

  return { sources, nodes, controls: null };
}

type HumControls = {
  readonly fanTone: BiquadFilterNode;
  readonly fanLevel: GainNode;
  readonly humLevel: GainNode;
  readonly whineLevel: GainNode;
};

type HumProfile = { readonly fanToneHz: number; readonly fan: number; readonly hum: number; readonly whine: number };

/** Up close the fans get brighter and the mains hum and coil whine come forward. */
export function humProfile(proximity: number): HumProfile {
  const near = clamp01(proximity);
  return { fanToneHz: 1200 + 2800 * near, fan: 0.45 + 0.55 * near, hum: 0.04 + 0.3 * near, whine: 0.004 + 0.03 * near };
}

/** Rack fans, mains hum and the high whine of power supplies. */
export class ServerRoomHum implements Loop {
  private readonly bed: Bed<HumControls>;
  private proximity = 0;

  constructor(target: LoopTarget) {
    this.bed = new Bed(target, {
      bus: "ambience",
      fadeSeconds: 1.5,
      fullGain: 0.9,
      build: (context, into, at) => buildServerHum(context, into, at, humProfile(this.proximity)),
    });
  }

  get isRunning(): boolean {
    return this.bed.isRunning;
  }

  start(): void {
    this.bed.start();
  }

  stop(): void {
    this.bed.stop();
  }

  setLevel(level: number): void {
    this.bed.setLevel(level);
  }

  setProximity(proximity: number): void {
    this.proximity = clamp01(proximity);
    const running = this.bed.running;
    if (!running) return;
    const { context, controls } = running;
    const profile = humProfile(this.proximity);
    glide(controls.fanTone.frequency, profile.fanToneHz, context, PARAMETER_RAMP_SECONDS);
    glide(controls.fanLevel.gain, profile.fan, context, PARAMETER_RAMP_SECONDS);
    glide(controls.humLevel.gain, profile.hum, context, PARAMETER_RAMP_SECONDS);
    glide(controls.whineLevel.gain, profile.whine, context, PARAMETER_RAMP_SECONDS);
  }
}

function buildServerHum(context: AudioContext, into: AudioNode, at: number, profile: HumProfile): BedParts<HumControls> {
  const fans = startNoise(context, "pink", at);
  const fanTone = filter(context, "lowpass", profile.fanToneHz);
  const bladeThrum = filter(context, "peaking", 160, 1.5, 6);
  const fanLevel = gainOf(context, profile.fan);
  chain(fans, fanTone, bladeThrum, fanLevel, into);

  // A sawtooth's harmonics carry the hum onto laptop speakers that cannot play 60 Hz itself.
  const mains = startOscillator(context, "sawtooth", 60, at);
  const mainsTone = filter(context, "lowpass", 400, 1);
  const humLevel = gainOf(context, profile.hum);
  chain(mains, mainsTone, humLevel, into);

  const coils = [7300, 10950].map((frequency) => startOscillator(context, "sine", frequency, at));
  const beat = startOscillator(context, "sine", 0.13, at);
  const beatDepth = gainOf(context, 6);
  chain(beat, beatDepth);
  for (const coil of coils) beatDepth.connect(coil.detune);
  const whineLevel = gainOf(context, profile.whine);
  for (const coil of coils) coil.connect(whineLevel);
  whineLevel.connect(into);

  return {
    sources: [fans, mains, beat, ...coils],
    nodes: [fanTone, bladeThrum, fanLevel, mainsTone, humLevel, beatDepth, whineLevel],
    controls: { fanTone, fanLevel, humLevel, whineLevel },
  };
}

type AlarmControls = {
  readonly sweep: OscillatorNode;
  readonly spin: OscillatorNode;
  readonly sweepDepth: GainNode;
  readonly tone: BiquadFilterNode;
};

type AlarmProfile = { readonly rateHz: number; readonly sweepHz: number; readonly brightnessHz: number };

/** Higher intensity: the whoop cycles faster, sweeps wider and gets harsher. */
export function alarmProfile(intensity: number): AlarmProfile {
  const urgency = clamp01(intensity);
  return { rateHz: 0.4 + 1.4 * urgency, sweepHz: 260 + 140 * urgency, brightnessHz: 1600 + 1800 * urgency };
}

/** Data-centre "whoop" siren under a rotating beacon. */
export class Alarm implements Loop {
  private readonly bed: Bed<AlarmControls>;
  private intensity = 0;

  constructor(target: LoopTarget) {
    this.bed = new Bed(target, {
      bus: "alarm",
      fadeSeconds: 1.2,
      fullGain: 0.5,
      build: (context, into, at) => buildAlarm(context, into, at, alarmProfile(this.intensity)),
    });
  }

  get isRunning(): boolean {
    return this.bed.isRunning;
  }

  start(): void {
    this.bed.start();
  }

  stop(): void {
    this.bed.stop();
  }

  setLevel(level: number): void {
    this.bed.setLevel(level);
  }

  setIntensity(intensity: number): void {
    this.intensity = clamp01(intensity);
    const running = this.bed.running;
    if (!running) return;
    const { context, controls } = running;
    const profile = alarmProfile(this.intensity);
    glide(controls.sweep.frequency, profile.rateHz, context, PARAMETER_RAMP_SECONDS);
    glide(controls.spin.frequency, profile.rateHz, context, PARAMETER_RAMP_SECONDS);
    glide(controls.sweepDepth.gain, profile.sweepHz, context, PARAMETER_RAMP_SECONDS);
    glide(controls.tone.frequency, profile.brightnessHz, context, PARAMETER_RAMP_SECONDS);
  }
}

function buildAlarm(context: AudioContext, into: AudioNode, at: number, profile: AlarmProfile): BedParts<AlarmControls> {
  const horn = startOscillator(context, "sawtooth", 780, at);
  const hornDouble = startOscillator(context, "square", 780, at);
  hornDouble.detune.value = 9;

  // A rising sawtooth LFO gives the siren its "whoop": slow climb, instant reset.
  const sweep = startOscillator(context, "sawtooth", profile.rateHz, at);
  const sweepDepth = gainOf(context, profile.sweepHz);
  chain(sweep, sweepDepth);
  sweepDepth.connect(horn.frequency);
  sweepDepth.connect(hornDouble.frequency);

  const mix = gainOf(context, 0.5);
  const tone = filter(context, "lowpass", profile.brightnessHz, 0.9);
  const beacon = gainOf(context, 0.65);
  horn.connect(mix);
  hornDouble.connect(mix);
  chain(mix, tone, beacon, into);

  const spin = startOscillator(context, "sine", profile.rateHz, at);
  const spinDepth = gainOf(context, 0.35);
  chain(spin, spinDepth);
  spinDepth.connect(beacon.gain);

  return {
    sources: [horn, hornDouble, sweep, spin],
    nodes: [sweepDepth, mix, tone, beacon, spinDepth],
    controls: { sweep, spin, sweepDepth, tone },
  };
}

const SCHEDULER_INTERVAL_MS = 25;
/** Beats are scheduled this far ahead on the audio clock, so timer jitter never shows. */
const SCHEDULE_AHEAD_SECONDS = 0.12;
const MIN_BPM = 30;
const MAX_BPM = 200;

type HeartbeatControls = { readonly body: AudioNode };

/** Lub-dub with a lookahead scheduler on the audio clock. */
export class Heartbeat implements Loop {
  private readonly bed: Bed<HeartbeatControls>;
  private bpm = 72;

  constructor(target: LoopTarget) {
    this.bed = new Bed(target, { bus: "sfx", fadeSeconds: 0.8, fullGain: 0.9, build: (context, into, at) => this.build(context, into, at) });
  }

  get isRunning(): boolean {
    return this.bed.isRunning;
  }

  start(): void {
    this.bed.start();
  }

  stop(): void {
    this.bed.stop();
  }

  setLevel(level: number): void {
    this.bed.setLevel(level);
  }

  setRate(bpm: number): void {
    this.bpm = Number.isFinite(bpm) ? Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) : this.bpm;
  }

  private build(context: AudioContext, into: AudioNode, at: number): BedParts<HeartbeatControls> {
    const body = filter(context, "lowpass", 220, 0.9);
    body.connect(into);
    let nextBeatAt = at + 0.05;
    const timer = globalThis.setInterval(() => {
      // Background tabs throttle timers to ~1 Hz; skip missed beats instead of firing them all at once.
      if (nextBeatAt < context.currentTime) nextBeatAt = context.currentTime + 0.02;
      while (nextBeatAt < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
        scheduleBeat(context, body, nextBeatAt, this.bpm);
        nextBeatAt += 60 / this.bpm;
      }
    }, SCHEDULER_INTERVAL_MS);
    return { sources: [], nodes: [body], controls: { body }, dispose: () => globalThis.clearInterval(timer) };
  }
}

function scheduleBeat(context: AudioContext, into: AudioNode, at: number, bpm: number): void {
  // The lub-to-dub gap shortens as the heart speeds up (~0.32 s at 60 bpm, ~0.21 s at 130).
  const dubAt = at + 0.12 + 0.2 * (60 / bpm);
  for (const [beatAt, pitch, peak, decay] of [
    [at, 62, 1, 0.16],
    [dubAt, 78, 0.7, 0.12],
  ] as const) {
    // Triangle rather than sine: its third harmonic keeps the thump audible on small speakers.
    const thump = startOscillator(context, "triangle", pitch, beatAt);
    thump.frequency.exponentialRampToValueAtTime(pitch * 0.7, beatAt + 0.1);
    const level = gainOf(context, 0);
    const end = strike(level.gain, beatAt, peak, 0.008, decay);
    chain(thump, level, into);
    thump.stop(end + 0.02);
    thump.onended = () => {
      thump.disconnect();
      level.disconnect();
    };
  }
}

export type SoundscapeLoops = {
  readonly ambience: Loop;
  readonly serverHum: ServerRoomHum;
  readonly alarm: Alarm;
  readonly heartbeat: Heartbeat;
};

export function createSoundscapeLoops(target: LoopTarget): SoundscapeLoops {
  return { ambience: officeAmbience(target), serverHum: new ServerRoomHum(target), alarm: new Alarm(target), heartbeat: new Heartbeat(target) };
}
