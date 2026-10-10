/** The body's side of the pantry: biting into a snack, a yawn when energy runs low, a rumbling stomach. */
import type { Random } from "../domain/random.ts";
import { sfxOutput, startTime, type SfxTarget } from "./sfx.ts";
import { chain, filter, gainOf, hold, jitter, release, startNoise, startOscillator, strike } from "./synth.ts";

const random: Random = Math.random;

/** A bite: a sharp crack of noise and a few smaller crumbs after it. */
export function snackBite(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);
  const sources = [];
  const nodes = [];
  let end = at;
  for (let crumb = 0; crumb < 4; crumb += 1) {
    const crumbAt = at + crumb * 0.045 * jitter(random, 0.4);
    const noise = startNoise(context, "white", crumbAt);
    const band = filter(context, "bandpass", 2600 * jitter(random, 0.3), 1.2);
    const level = gainOf(context, 0);
    end = Math.max(end, strike(level.gain, crumbAt, crumb === 0 ? 0.32 : 0.12, 0.002, 0.05));
    chain(noise, band, level, destination);
    sources.push(noise);
    nodes.push(band, level);
  }
  release(sources, nodes, end + 0.05);
}

/** A yawn: breath rising through an open "ah" and sighing away. */
export function yawn(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);
  const breath = startNoise(context, "pink", at);
  const formant = filter(context, "bandpass", 520, 3);
  formant.frequency.linearRampToValueAtTime(780, at + 0.7);
  formant.frequency.linearRampToValueAtTime(360, at + 1.9);
  const breathLevel = gainOf(context, 0);
  hold(breathLevel.gain, at, 0.14, 0.4, 0.9, 0.7);
  chain(breath, formant, breathLevel, destination);
  const voice = startOscillator(context, "sawtooth", 150 * jitter(random, 0.1), at + 0.3);
  voice.frequency.linearRampToValueAtTime(120, at + 1.8);
  const voiceTone = filter(context, "lowpass", 700);
  const voiceLevel = gainOf(context, 0);
  const end = hold(voiceLevel.gain, at + 0.3, 0.025, 0.3, 0.8, 0.5);
  chain(voice, voiceTone, voiceLevel, destination);
  release([breath, voice], [formant, breathLevel, voiceTone, voiceLevel], end + 0.1);
}

/** An empty stomach: a low, wandering gurgle. */
export function stomachRumble(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);
  const growl = startNoise(context, "brown", at);
  const band = filter(context, "bandpass", 90, 4);
  for (let step = 0; step <= 12; step += 1) band.frequency.linearRampToValueAtTime(70 + random() * 90, at + step * 0.1);
  const gurgle = startOscillator(context, "sine", 7, at);
  const depth = gainOf(context, 0.6);
  const level = gainOf(context, 0);
  gurgle.connect(depth);
  depth.connect(level.gain);
  const end = hold(level.gain, at, 0.5, 0.15, 0.8, 0.4);
  chain(growl, band, level, destination);
  release([growl, gurgle], [band, depth, level], end + 0.1);
}
