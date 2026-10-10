import type { Random } from "../domain/random.ts";
import type { AudioEngine } from "./engine.ts";
import {
  chain,
  filter,
  gainOf,
  hold,
  jitter,
  SILENCE,
  release,
  startNoise,
  startOscillator,
  strike,
  type AudioOutput,
} from "./synth.ts";

export type SfxTarget = Pick<AudioEngine, "isMuted" | "output">;
export type Surface = "carpet" | "tile";

/** Scheduling a hair ahead of currentTime keeps the first envelope point from landing in the past. */
const LOOKAHEAD_SECONDS = 0.005;
const random: Random = Math.random;

export function sfxOutput(target: SfxTarget): AudioOutput | null {
  return target.isMuted ? null : target.output("sfx");
}

export function startTime(output: AudioOutput): number {
  return output.context.currentTime + LOOKAHEAD_SECONDS;
}

/** The phone rattling across the desk, then the pager's two-tone alert. */
export function pagerBuzz(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  const motor = startOscillator(context, "sawtooth", 172, at);
  const motorWobble = startOscillator(context, "sine", 23, at);
  const wobbleDepth = gainOf(context, 6);
  chain(motorWobble, wobbleDepth);
  wobbleDepth.connect(motor.frequency);
  const chassis = filter(context, "lowpass", 700, 3);

  const rattle = startNoise(context, "white", at);
  const rattleBand = filter(context, "bandpass", 3200, 2.5);
  const rattleLevel = gainOf(context, 0.25);
  const grit = startOscillator(context, "square", 47, at);
  const gritDepth = gainOf(context, 0.3);
  chain(grit, gritDepth);
  gritDepth.connect(rattleLevel.gain);

  const vibration = gainOf(context, 0);
  chain(motor, chassis, vibration, destination);
  chain(rattle, rattleBand, rattleLevel, vibration);
  for (let pulse = 0; pulse < 3; pulse += 1) hold(vibration.gain, at + pulse * 0.5, 0.55, 0.02, 0.3, 0.06);

  const beepAt = at + 1.55;
  const beep = startOscillator(context, "square", 1760, beepAt);
  const beepTone = filter(context, "lowpass", 2800, 0.8);
  const beepLevel = gainOf(context, 0);
  chain(beep, beepTone, beepLevel, destination);
  let end = beepAt;
  [1760, 1319, 1760, 1319].forEach((frequency, index) => {
    const noteAt = beepAt + index * 0.14;
    beep.frequency.setValueAtTime(frequency, noteAt);
    end = hold(beepLevel.gain, noteAt, 0.22, 0.005, 0.1, 0.03);
  });

  release(
    [motor, motorWobble, rattle, grit, beep],
    [wobbleDepth, chassis, rattleBand, rattleLevel, gritDepth, vibration, beepTone, beepLevel],
    end + 0.05,
  );
}

/** One mechanical key: switch click, keycap bottoming out, and the case resonating. */
export function keyClick(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (output) scheduleKeyClick(output, startTime(output), 1);
}

/**
 * A burst of human typing — uneven gaps, the odd pause to think, a heavier space
 * bar. Returns how long the burst lasts in seconds.
 */
export function typingBurst(target: SfxTarget, count: number): number {
  const output = sfxOutput(target);
  const keys = Math.max(0, Math.min(200, Math.floor(count)));
  if (!output || keys === 0) return 0;
  const start = startTime(output);
  let at = start;
  for (let key = 0; key < keys; key += 1) {
    const isSpace = random() < 0.16;
    scheduleKeyClick(output, at, isSpace ? 1.35 : 1);
    at += 0.075 + random() * 0.1 + (random() < 0.08 ? 0.25 + random() * 0.3 : 0);
  }
  return at - start;
}

function scheduleKeyClick(output: AudioOutput, at: number, weight: number): void {
  const { context, destination } = output;
  const level = jitter(random, 0.25) * weight;
  const panner = context.createStereoPanner();
  panner.pan.value = (random() * 2 - 1) * 0.25;
  panner.connect(destination);

  const click = startNoise(context, "white", at);
  const clickBand = filter(context, "bandpass", 4200 * jitter(random, 0.15), 1.4);
  const clickLevel = gainOf(context, 0);
  strike(clickLevel.gain, at, 0.35 * level, 0.001, 0.018);
  chain(click, clickBand, clickLevel, panner);

  const thockPitch = (260 / weight) * jitter(random, 0.08);
  const thock = startOscillator(context, "triangle", thockPitch, at);
  thock.frequency.exponentialRampToValueAtTime(thockPitch * 0.55, at + 0.03);
  const thockLevel = gainOf(context, 0);
  strike(thockLevel.gain, at + 0.004, 0.5 * level, 0.002, 0.045);
  chain(thock, thockLevel, panner);

  const body = startNoise(context, "pink", at);
  const bodyTone = filter(context, "lowpass", 1200 * jitter(random, 0.1));
  const bodyLevel = gainOf(context, 0);
  strike(bodyLevel.gain, at + 0.003, 0.25 * level, 0.002, 0.035);
  chain(body, bodyTone, bodyLevel, panner);

  release([click, thock, body], [panner, clickBand, clickLevel, thockLevel, bodyTone, bodyLevel], at + 0.09);
}

export function footstep(target: SfxTarget, surface: Surface): void {
  const output = sfxOutput(target);
  if (!output) return;
  if (surface === "carpet") carpetStep(output);
  else tileStep(output);
}

function carpetStep(output: AudioOutput): void {
  const { context, destination } = output;
  const at = startTime(output);
  const level = jitter(random, 0.2);

  const fabric = startNoise(context, "pink", at);
  const muffle = filter(context, "lowpass", 380 * jitter(random, 0.15));
  const fabricLevel = gainOf(context, 0);
  strike(fabricLevel.gain, at, 0.5 * level, 0.012, 0.14);
  chain(fabric, muffle, fabricLevel, destination);

  const thud = startOscillator(context, "sine", 68 * jitter(random, 0.1), at);
  const thudLevel = gainOf(context, 0);
  strike(thudLevel.gain, at, 0.45 * level, 0.006, 0.1);
  chain(thud, thudLevel, destination);

  const scuff = startNoise(context, "pink", at);
  const scuffBand = filter(context, "bandpass", 1800, 0.7);
  const scuffLevel = gainOf(context, 0);
  strike(scuffLevel.gain, at + 0.03, 0.05 * level, 0.02, 0.08);
  chain(scuff, scuffBand, scuffLevel, destination);

  release([fabric, thud, scuff], [muffle, fabricLevel, thudLevel, scuffBand, scuffLevel], at + 0.2);
}

function tileStep(output: AudioOutput): void {
  const { context, destination } = output;
  const at = startTime(output);
  const level = jitter(random, 0.2);

  const heel = startNoise(context, "white", at);
  const heelBand = filter(context, "bandpass", 2600 * jitter(random, 0.12), 1.8);
  const heelLevel = gainOf(context, 0);
  strike(heelLevel.gain, at, 0.35 * level, 0.001, 0.03);
  chain(heel, heelBand, heelLevel, destination);

  const thud = startOscillator(context, "triangle", 120 * jitter(random, 0.1), at);
  thud.frequency.exponentialRampToValueAtTime(80, at + 0.05);
  const thudLevel = gainOf(context, 0);
  strike(thudLevel.gain, at, 0.4 * level, 0.002, 0.07);
  chain(thud, thudLevel, destination);

  // A short ringing band stands in for the hard walls of a corridor.
  const reflection = startNoise(context, "pink", at);
  const reflectionBand = filter(context, "bandpass", 900, 3);
  const reflectionLevel = gainOf(context, 0);
  strike(reflectionLevel.gain, at + 0.004, 0.08 * level, 0.002, 0.18);
  chain(reflection, reflectionBand, reflectionLevel, destination);

  release([heel, thud, reflection], [heelBand, heelLevel, thudLevel, reflectionBand, reflectionLevel], at + 0.25);
}

/** Badge reader chirp, the mag-lock releasing, then a heavy glass door swinging open. */
export function doorOpen(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  const reader = startOscillator(context, "sine", 2093, at);
  const readerLevel = gainOf(context, 0);
  chain(reader, readerLevel, destination);
  hold(readerLevel.gain, at, 0.16, 0.004, 0.07, 0.04);
  reader.frequency.setValueAtTime(2637, at + 0.12);
  hold(readerLevel.gain, at + 0.12, 0.16, 0.004, 0.07, 0.04);

  const unlockAt = at + 0.32;
  const clunk = startNoise(context, "pink", unlockAt);
  const clunkTone = filter(context, "lowpass", 600);
  const clunkLevel = gainOf(context, 0);
  strike(clunkLevel.gain, unlockAt, 0.5, 0.002, 0.07);
  chain(clunk, clunkTone, clunkLevel, destination);
  const bolt = startOscillator(context, "sine", 95, unlockAt);
  const boltLevel = gainOf(context, 0);
  strike(boltLevel.gain, unlockAt, 0.5, 0.002, 0.09);
  chain(bolt, boltLevel, destination);

  const swingAt = unlockAt + 0.08;
  const air = startNoise(context, "pink", swingAt);
  const airBand = filter(context, "bandpass", 500, 0.9);
  airBand.frequency.setValueAtTime(500, swingAt);
  airBand.frequency.linearRampToValueAtTime(1600, swingAt + 0.9);
  const airLevel = gainOf(context, 0);
  const swingEnd = hold(airLevel.gain, swingAt, 0.18, 0.25, 0.35, 0.4);
  chain(air, airBand, airLevel, destination);

  const glass = [2900, 3550].map((frequency) => startOscillator(context, "sine", frequency, swingAt));
  const glassLevel = gainOf(context, 0);
  strike(glassLevel.gain, swingAt, 0.03, 0.001, 0.25);
  for (const partial of glass) partial.connect(glassLevel);
  glassLevel.connect(destination);

  release(
    [reader, clunk, bolt, ...glass, air],
    [readerLevel, clunkTone, clunkLevel, boltLevel, airBand, airLevel, glassLevel],
    swingEnd + 0.05,
  );
}

/** A woody double knock, the shape every chat app uses for "someone needs you". */
export function notificationPing(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);
  const wood = filter(context, "lowpass", 2500);
  wood.connect(destination);

  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [wood];
  [0, 0.105].forEach((offset, index) => {
    const knockAt = at + offset;
    const pitch = 520 + index * 40;
    const tone = startOscillator(context, "triangle", pitch, knockAt);
    tone.frequency.exponentialRampToValueAtTime(pitch * 0.58, knockAt + 0.05);
    const toneLevel = gainOf(context, 0);
    strike(toneLevel.gain, knockAt, 0.45, 0.001, 0.07);
    chain(tone, toneLevel, wood);

    const tap = startNoise(context, "white", knockAt);
    const tapBand = filter(context, "bandpass", 1400, 2);
    const tapLevel = gainOf(context, 0);
    strike(tapLevel.gain, knockAt, 0.25, 0.001, 0.03);
    chain(tap, tapBand, tapLevel, wood);

    sources.push(tone, tap);
    nodes.push(toneLevel, tapBand, tapLevel);
  });
  release(sources, nodes, at + 0.3);
}

/** Rising major triad with inharmonic bell partials. */
export function successChime(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);
  const bell = gainOf(context, 0.8);
  bell.connect(destination);

  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [bell];
  let end = at;
  [1046.5, 1318.5, 1568].forEach((frequency, index) => {
    const noteAt = at + index * 0.075;
    const partials: ReadonlyArray<readonly [ratio: number, peak: number, decay: number]> = [
      [1, 0.22, 0.9],
      [2.756, 0.06, 0.35],
      [5.404, 0.02, 0.15],
    ];
    for (const [ratio, peak, decay] of partials) {
      const partial = startOscillator(context, "sine", frequency * ratio, noteAt);
      partial.detune.value = (random() * 2 - 1) * 4;
      const level = gainOf(context, 0);
      end = Math.max(end, strike(level.gain, noteAt, peak, 0.004, decay));
      chain(partial, level, bell);
      sources.push(partial);
      nodes.push(level);
    }
  });
  release(sources, nodes, end + 0.05);
}

/** Two short, dissonant low buzzes: the command was rejected. */
export function failBuzz(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  const voices = [98, 103.8].map((frequency) => startOscillator(context, "sawtooth", frequency, at));
  const growl = filter(context, "lowpass", 850, 4);
  const level = gainOf(context, 0);
  for (const voice of voices) voice.connect(growl);
  chain(growl, level, destination);
  hold(level.gain, at, 0.32, 0.01, 0.13, 0.06);
  const end = hold(level.gain, at + 0.22, 0.32, 0.01, 0.13, 0.06);
  release(voices, [growl, level], end + 0.05);
}

/** Hinge creak as the lid lifts, a settle tick, then the fan spinning up. */
export function laptopOpen(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  // Stick-slip friction: an irregular pulse train exciting a narrow resonance.
  const friction = startOscillator(context, "square", 40, at);
  for (let step = 1; step < 14; step += 1) friction.frequency.linearRampToValueAtTime(28 + random() * 27, at + step * 0.04);
  const hinge = filter(context, "bandpass", 1500, 9);
  const hingeLevel = gainOf(context, 0);
  hold(hingeLevel.gain, at, 0.3, 0.05, 0.4, 0.1);
  chain(friction, hinge, hingeLevel, destination);

  const settleAt = at + 0.6;
  const settle = startNoise(context, "white", settleAt);
  const settleBand = filter(context, "highpass", 2500);
  const settleLevel = gainOf(context, 0);
  strike(settleLevel.gain, settleAt, 0.12, 0.001, 0.025);
  chain(settle, settleBand, settleLevel, destination);

  const fanAt = at + 0.7;
  const fanEnd = fanAt + 2.7;
  const fan = startNoise(context, "pink", fanAt);
  const fanBand = filter(context, "bandpass", 250, 1.2);
  fanBand.frequency.setValueAtTime(250, fanAt);
  fanBand.frequency.linearRampToValueAtTime(1100, fanAt + 1.8);
  const fanLevel = gainOf(context, 0);
  fanLevel.gain.setValueAtTime(0, fanAt);
  fanLevel.gain.linearRampToValueAtTime(0.12, fanAt + 1.2);
  fanLevel.gain.setValueAtTime(0.12, fanAt + 1.9);
  fanLevel.gain.exponentialRampToValueAtTime(SILENCE, fanEnd);
  chain(fan, fanBand, fanLevel, destination);

  const whine = startOscillator(context, "sine", 180, fanAt);
  whine.frequency.exponentialRampToValueAtTime(1400, fanAt + 1.8);
  const whineLevel = gainOf(context, 0);
  whineLevel.gain.setValueAtTime(0, fanAt);
  whineLevel.gain.linearRampToValueAtTime(0.015, fanAt + 1.2);
  whineLevel.gain.exponentialRampToValueAtTime(SILENCE, fanEnd);
  chain(whine, whineLevel, destination);

  release(
    [friction, settle, fan, whine],
    [hinge, hingeLevel, settleBand, settleLevel, fanBand, fanLevel, whineLevel],
    fanEnd + 0.05,
  );
}

/** Burr grinder whirring, the pump's gurgling pour, then the machine's two-note "ready". About four seconds. */
export function coffeeBrew(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  // Grinder: a motor drone, and beans rattling through the burrs as amplitude-modulated noise.
  const grindEnd = at + 1.4;
  const motor = startOscillator(context, "sawtooth", 118, at);
  const motorTone = filter(context, "lowpass", 420);
  const motorLevel = gainOf(context, 0);
  hold(motorLevel.gain, at, 0.12, 0.08, 1.15, 0.15);
  chain(motor, motorTone, motorLevel, destination);
  const beans = startNoise(context, "white", at);
  const beansBand = filter(context, "bandpass", 2200, 1.4);
  const rattle = gainOf(context, 0);
  const flutter = startOscillator(context, "square", 38, at);
  const flutterDepth = gainOf(context, 0.5);
  flutter.connect(flutterDepth);
  flutterDepth.connect(rattle.gain);
  const beansLevel = gainOf(context, 0);
  hold(beansLevel.gain, at, 0.16, 0.05, 1.2, 0.12);
  chain(beans, beansBand, rattle, beansLevel, destination);

  // Pour: the pump's hum and a gurgle whose resonance wanders as the cup fills.
  const pourAt = grindEnd + 0.25;
  const pourEnd = pourAt + 2.1;
  const pump = startOscillator(context, "triangle", 62, pourAt);
  const pumpLevel = gainOf(context, 0);
  hold(pumpLevel.gain, pourAt, 0.1, 0.1, 1.8, 0.2);
  chain(pump, pumpLevel, destination);
  const stream = startNoise(context, "pink", pourAt);
  const streamBand = filter(context, "bandpass", 700, 3);
  for (let step = 0; step <= 20; step += 1) streamBand.frequency.linearRampToValueAtTime(600 + random() * 500 + step * 25, pourAt + step * 0.1);
  const streamLevel = gainOf(context, 0);
  hold(streamLevel.gain, pourAt, 0.22, 0.15, 1.65, 0.3);
  chain(stream, streamBand, streamLevel, destination);

  // Ready: two soft sine beeps, the second a fourth higher.
  const readyAt = pourEnd + 0.2;
  const ready = startOscillator(context, "sine", 1318.5, readyAt);
  ready.frequency.setValueAtTime(1760, readyAt + 0.16);
  const readyLevel = gainOf(context, 0);
  hold(readyLevel.gain, readyAt, 0.1, 0.005, 0.09, 0.03);
  const readyEnd = hold(readyLevel.gain, readyAt + 0.16, 0.1, 0.005, 0.12, 0.05);
  chain(ready, readyLevel, destination);

  release([flutter, motor, beans, pump, stream, ready], [motorTone, motorLevel, beansBand, rattle, flutterDepth, beansLevel, pumpLevel, streamBand, streamLevel, readyLevel], readyEnd + 0.05);
}

/** Gas-lift chair: a short squeak of the swivel and the seat taking weight. */
export function chairCreak(target: SfxTarget): void {
  const output = sfxOutput(target);
  if (!output) return;
  const { context, destination } = output;
  const at = startTime(output);

  const squeak = startOscillator(context, "triangle", 760 * jitter(random, 0.08), at);
  squeak.frequency.linearRampToValueAtTime(520, at + 0.14);
  const squeakBand = filter(context, "bandpass", 900, 6);
  const squeakLevel = gainOf(context, 0);
  strike(squeakLevel.gain, at, 0.08, 0.02, 0.14);
  chain(squeak, squeakBand, squeakLevel, destination);

  const settleAt = at + 0.08;
  const cushion = startNoise(context, "pink", settleAt);
  const cushionTone = filter(context, "lowpass", 380);
  const cushionLevel = gainOf(context, 0);
  strike(cushionLevel.gain, settleAt, 0.3, 0.01, 0.22);
  chain(cushion, cushionTone, cushionLevel, destination);

  const hiss = startNoise(context, "white", settleAt + 0.05);
  const hissBand = filter(context, "highpass", 4000);
  const hissLevel = gainOf(context, 0);
  const end = strike(hissLevel.gain, settleAt + 0.05, 0.03, 0.02, 0.3);
  chain(hiss, hissBand, hissLevel, destination);

  release([squeak, cushion, hiss], [squeakBand, squeakLevel, cushionTone, cushionLevel, hissBand, hissLevel], end + 0.05);
}
