import type { Random } from "../domain/random.ts";

export type NoiseColor = "white" | "pink" | "brown";

/** Where a sound is rendered: the live context and the bus it feeds. */
export type AudioOutput = { readonly context: AudioContext; readonly destination: AudioNode };

/** Exponential ramps cannot reach zero; -80 dB is silent for every practical purpose. */
export const SILENCE = 0.0001;

/** Long enough that a looped noise bed never audibly repeats. */
const NOISE_SECONDS = 4;
const NOISE_PEAK = 0.9;

const noiseBanks = new WeakMap<BaseAudioContext, Map<NoiseColor, AudioBuffer>>();

/**
 * Fills `samples` with noise of the given colour, normalised to a fixed peak so
 * every colour sits at a comparable level before mixing.
 */
export function fillNoise(samples: Float32Array, color: NoiseColor, random: Random): void {
  let pinkFast = 0;
  let pinkMid = 0;
  let pinkSlow = 0;
  let brown = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const white = random() * 2 - 1;
    switch (color) {
      case "white":
        samples[index] = white;
        break;
      case "pink":
        // Paul Kellet's economy filter: three one-pole stages approximate -3 dB/octave.
        pinkSlow = 0.99765 * pinkSlow + white * 0.099046;
        pinkMid = 0.963 * pinkMid + white * 0.2965164;
        pinkFast = 0.57 * pinkFast + white * 1.0526913;
        samples[index] = pinkSlow + pinkMid + pinkFast + white * 0.1848;
        break;
      case "brown":
        brown = (brown + 0.02 * white) / 1.02;
        samples[index] = brown;
        break;
    }
  }
  normalise(samples, NOISE_PEAK);
}

function normalise(samples: Float32Array, peak: number): void {
  let loudest = 0;
  for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample));
  if (loudest === 0) return;
  const scale = peak / loudest;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
}

export function noiseBuffer(context: BaseAudioContext, color: NoiseColor): AudioBuffer {
  let bank = noiseBanks.get(context);
  if (!bank) {
    bank = new Map();
    noiseBanks.set(context, bank);
  }
  const cached = bank.get(color);
  if (cached) return cached;
  const buffer = context.createBuffer(1, Math.round(context.sampleRate * NOISE_SECONDS), context.sampleRate);
  fillNoise(buffer.getChannelData(0), color, Math.random);
  bank.set(color, buffer);
  return buffer;
}

/**
 * A looping noise source started at a random point in the shared buffer, so
 * layers built from the same buffer stay decorrelated.
 */
export function startNoise(context: BaseAudioContext, color: NoiseColor, at: number): AudioBufferSourceNode {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context, color);
  source.loop = true;
  source.start(at, Math.random() * NOISE_SECONDS);
  return source;
}

export function startOscillator(context: BaseAudioContext, type: OscillatorType, frequency: number, at: number): OscillatorNode {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.start(at);
  return oscillator;
}

export function filter(context: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  node.gain.value = gainDb;
  return node;
}

export function gainOf(context: BaseAudioContext, level: number): GainNode {
  const node = context.createGain();
  node.gain.value = level;
  return node;
}

export function chain(...nodes: readonly AudioNode[]): void {
  for (let index = 1; index < nodes.length; index += 1) nodes[index - 1].connect(nodes[index]);
}

/** Linear attack (no zero-crossing click) into an exponential, natural-sounding decay. */
export function strike(param: AudioParam, at: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, at + attack);
  param.exponentialRampToValueAtTime(SILENCE, at + attack + decay);
  return at + attack + decay;
}

/** Flat-topped envelope for tones that hold, like beeps and buzzes. */
export function hold(param: AudioParam, at: number, peak: number, attack: number, sustain: number, release: number): number {
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, at + attack);
  param.setValueAtTime(peak, at + attack + sustain);
  param.exponentialRampToValueAtTime(SILENCE, at + attack + sustain + release);
  return at + attack + sustain + release;
}

/**
 * Glides a parameter to `target`, reaching ~95% within `seconds`. setTargetAtTime
 * starts from wherever the parameter currently is, so repeated calls never click.
 */
export function glide(param: AudioParam, target: number, context: BaseAudioContext, seconds: number): void {
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(target, now, Math.max(seconds, 0.001) / 3);
}

/** Stops every source at `until` and frees the subgraph once the last one has ended. */
export function release(sources: readonly AudioScheduledSourceNode[], nodes: readonly AudioNode[], until: number): void {
  const last = sources.at(-1);
  if (!last) return;
  for (const source of sources) source.stop(until);
  last.onended = () => {
    for (const node of [...sources, ...nodes]) node.disconnect();
  };
}

export function jitter(random: Random, amount: number): number {
  return 1 + (random() * 2 - 1) * amount;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
