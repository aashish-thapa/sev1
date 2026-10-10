import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine.ts";
import { createSoundSystem } from "./index.ts";
import { createSoundscapeLoops } from "./loops.ts";
import { doorOpen, failBuzz, footstep, keyClick, laptopOpen, notificationPing, pagerBuzz, successChime, typingBurst } from "./sfx.ts";
import { soundscapeFor, type SoundscapeState, type Zone } from "./soundscape.ts";
import type { SpeechBackend, SpeechVoice, UtteranceEnding, UtteranceEvents, UtteranceRequest } from "./speech.ts";
import { fillNoise } from "./synth.ts";
import { VoiceDirector, castVoice, type SpeechGate } from "./voice.ts";

/** Records the last value each parameter was driven toward. */
class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number) {
    if (value <= 0) throw new RangeError("exponential ramps need a positive target");
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

const PARAMS = ["gain", "frequency", "detune", "Q", "pan", "threshold", "knee", "ratio", "attack", "release"];

/** Any node: named AudioParams are FakeParams, every method is a recording no-op. */
function fakeNode(created: string[], kind: string): object {
  created.push(kind);
  const fields: Record<string | symbol, unknown> = {};
  for (const name of PARAMS) fields[name] = new FakeParam();
  return new Proxy(fields, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

class FakeAudioContext {
  readonly created: string[] = [];
  state: "suspended" | "running" = "running";
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate, getChannelData: () => data };
  }
  createGain = () => fakeNode(this.created, "gain");
  createOscillator = () => fakeNode(this.created, "oscillator");
  createBufferSource = () => fakeNode(this.created, "buffer-source");
  createBiquadFilter = () => fakeNode(this.created, "filter");
  createStereoPanner = () => fakeNode(this.created, "panner");
  createDynamicsCompressor = () => fakeNode(this.created, "compressor");
}

function fakeEngine() {
  const context = new FakeAudioContext();
  const factory = vi.fn(() => context as unknown as AudioContext);
  return { engine: new AudioEngine(factory), context, factory };
}

const allSfx = (engine: AudioEngine) => {
  pagerBuzz(engine);
  keyClick(engine);
  typingBurst(engine, 12);
  footstep(engine, "carpet");
  footstep(engine, "tile");
  doorOpen(engine);
  notificationPing(engine);
  successChime(engine);
  failBuzz(engine);
  laptopOpen(engine);
};

describe("audio engine", () => {
  it("is silent and builds nothing before the first gesture", () => {
    const { engine, context, factory } = fakeEngine();
    allSfx(engine);
    const loops = createSoundscapeLoops(engine);
    for (const loop of Object.values(loops)) {
      loop.setLevel(1);
      loop.start();
    }
    expect(factory).not.toHaveBeenCalled();
    expect(context.created).toEqual([]);
    expect(engine.output("sfx")).toBeNull();
    expect(loops.alarm.isRunning).toBe(false);
  });

  it("creates the context on unlock, resumes it when suspended, and plays every effect", () => {
    const { engine, context, factory } = fakeEngine();
    context.state = "suspended";
    engine.unlock();
    engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalled();
    const graphNodes = context.created.length;
    allSfx(engine);
    expect(context.created.length).toBeGreaterThan(graphNodes);
  });

  it("mutes the master bus and stops scheduling one-shots", () => {
    const { engine, context } = fakeEngine();
    engine.unlock();
    engine.setMuted(true);
    const before = context.created.length;
    allSfx(engine);
    expect(context.created.length).toBe(before);
    expect(typingBurst(engine, 10)).toBe(0);
  });

  it("degrades to silence when Web Audio is missing or refuses to start", () => {
    const missing = new AudioEngine(() => undefined);
    const refusing = new AudioEngine(() => {
      throw new DOMException("unsupported sample rate", "NotSupportedError");
    });
    for (const engine of [missing, refusing]) {
      expect(() => engine.unlock()).not.toThrow();
      expect(engine.isUnlocked).toBe(true);
      expect(engine.output("sfx")).toBeNull();
      expect(() => allSfx(engine)).not.toThrow();
    }
  });

  it("notifies subscribers when unlock, mute or volume change", () => {
    const { engine } = fakeEngine();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    engine.unlock();
    engine.setMuted(true);
    engine.setMasterVolume(0.3);
    engine.setMasterVolume(0.3);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    engine.setMuted(false);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("starts loops only once unlocked, and only once each", () => {
    const { engine } = fakeEngine();
    engine.unlock();
    const loops = createSoundscapeLoops(engine);
    loops.ambience.start();
    loops.ambience.start();
    expect(loops.ambience.isRunning).toBe(true);
    loops.ambience.stop();
    expect(loops.ambience.isRunning).toBe(false);
  });
});

describe("noise", () => {
  it.each(["white", "pink", "brown"] as const)("normalises %s noise to a fixed peak", (color) => {
    const samples = new Float32Array(4096);
    let seed = 1;
    fillNoise(samples, color, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak).toBeCloseTo(0.9, 5);
  });
});

type SpokenRequest = UtteranceRequest & { readonly events: UtteranceEvents };

/** Speaks only when told to: tests decide when each utterance starts and ends. */
class FakeSpeech implements SpeechBackend {
  readonly spoken: SpokenRequest[] = [];
  cancels = 0;
  private installed: SpeechVoice[];
  private readonly voiceListeners = new Set<() => void>();

  constructor(installed: SpeechVoice[] = []) {
    this.installed = installed;
  }

  voices() {
    return this.installed;
  }

  onVoicesChanged(listener: () => void) {
    this.voiceListeners.add(listener);
    return () => this.voiceListeners.delete(listener);
  }

  speak(request: UtteranceRequest, events: UtteranceEvents) {
    this.spoken.push({ ...request, events });
  }

  cancel() {
    this.cancels += 1;
  }

  install(voices: SpeechVoice[]) {
    this.installed = voices;
    for (const listener of this.voiceListeners) listener();
  }

  finishLatest(ending: UtteranceEnding = "spoken") {
    const latest = this.spoken.at(-1);
    latest?.events.onStart();
    latest?.events.onEnd(ending);
  }
}

const voice = (name: string, lang = "en-US", localService = true): SpeechVoice => ({ name, lang, voiceURI: name, localService });
const OPEN_GATE: SpeechGate = { canSpeak: () => true, volume: () => 0.8 };

describe("voice director", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("speaks one line at a time in the order queued", async () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const first = director.speak("Checkout is throwing 500s.", "sre-lead");
    const second = director.speak("Looking at the pool now.", "dba");
    expect(speech.spoken.map((request) => request.text)).toEqual(["Checkout is throwing 500s."]);
    speech.finishLatest();
    expect(speech.spoken.map((request) => request.text)).toEqual(["Checkout is throwing 500s.", "Looking at the pool now."]);
    speech.finishLatest();
    await expect(first).resolves.toBe("spoken");
    await expect(second).resolves.toBe("spoken");
    expect(director.isBusy).toBe(false);
  });

  it("lets urgent lines interrupt the speaker and jump ahead of normal lines", async () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const chatter = director.speak("So I was thinking about lunch…", "dev");
    void director.speak("Anyway.", "dev");
    const page = director.speak("PagerDuty: checkout-api error rate above 40%.", "pagerduty", { priority: "urgent" });
    const followUp = director.speak("Escalating to the incident commander.", "pagerduty", { priority: "urgent" });

    await expect(chatter).resolves.toBe("interrupted");
    expect(speech.cancels).toBe(1);
    // The cancelled utterance reporting its end late must not advance the queue.
    speech.spoken[0].events.onEnd("interrupted");
    expect(speech.spoken.map((request) => request.text)).toEqual([
      "So I was thinking about lunch…",
      "PagerDuty: checkout-api error rate above 40%.",
    ]);
    speech.finishLatest();
    speech.finishLatest();
    expect(speech.spoken.map((request) => request.text).slice(2)).toEqual(["Escalating to the incident commander.", "Anyway."]);
    await expect(page).resolves.toBe("spoken");
    await expect(followUp).resolves.toBe("spoken");
  });

  it("does not interrupt an urgent line with another urgent line", () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    void director.speak("Sev 1 declared.", "pagerduty", { priority: "urgent" });
    void director.speak("Second page.", "pagerduty", { priority: "urgent" });
    expect(speech.cancels).toBe(0);
    expect(speech.spoken).toHaveLength(1);
  });

  it("cancels everything and reports it", async () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const ends: string[] = [];
    director.on("end", (line) => ends.push(line.text));
    const speaking = director.speak("One.", "a");
    const waiting = director.speak("Two.", "b");
    director.cancel();
    await expect(speaking).resolves.toBe("cancelled");
    await expect(waiting).resolves.toBe("cancelled");
    expect(ends).toEqual(["One."]);
    expect(director.isBusy).toBe(false);
  });

  it("skips lines while the gate is closed or speech is unavailable", async () => {
    const closed = new VoiceDirector(new FakeSpeech(), { canSpeak: () => false, volume: () => 1 });
    await expect(closed.speak("Hello?", "a")).resolves.toBe("skipped");
    const unavailable = new VoiceDirector(undefined, OPEN_GATE);
    await expect(unavailable.speak("Hello?", "a")).resolves.toBe("skipped");
  });

  it("moves on when an engine never reports the end of a line", async () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const stuck = director.speak("This utterance hangs.", "a");
    void director.speak("Next.", "b");
    vi.advanceTimersByTime(60_000);
    await expect(stuck).resolves.toBe("failed");
    expect(speech.spoken.at(-1)?.text).toBe("Next.");
  });

  it("emits start and end around each line", () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const events: string[] = [];
    director.on("start", (line) => events.push(`start:${line.speakerId}`));
    director.on("end", (line) => events.push(`end:${line.speakerId}`));
    void director.speak("Hi.", "a");
    speech.finishLatest();
    expect(events).toEqual(["start:a", "end:a"]);
  });
});

describe("voice casting", () => {
  const voices = ["Alex", "Daniel", "Karen", "Moira", "Samantha", "Tessa"].map((name) => voice(name));

  it("gives a speaker the same voice, pitch and rate every time", () => {
    const first = new VoiceDirector(new FakeSpeech(voices), OPEN_GATE).castingFor("sre-lead");
    const second = new VoiceDirector(new FakeSpeech([...voices].reverse()), OPEN_GATE).castingFor("sre-lead");
    expect(second).toEqual(first);
  });

  it("gives the cast distinct voices while enough are installed", () => {
    const cast = ["pagerduty", "sre-lead", "dba", "manager", "intern"];
    const director = new VoiceDirector(new FakeSpeech(voices), OPEN_GATE, { cast });
    const assigned = cast.map((speakerId) => director.castingFor(speakerId).voice?.voiceURI);
    expect(new Set(assigned).size).toBe(cast.length);
  });

  it("prefers local voices in the wanted language", () => {
    const director = new VoiceDirector(new FakeSpeech([voice("Thomas", "fr-FR"), voice("Remote", "en-GB", false), voice("Local", "en-GB")]), OPEN_GATE);
    expect(director.castingFor("anyone").voice?.name).toBe("Local");
  });

  it("separates speakers by pitch when no voices are installed, then recasts when voices load", () => {
    const speech = new FakeSpeech();
    const director = new VoiceDirector(speech, OPEN_GATE);
    const a = director.castingFor("a");
    const b = director.castingFor("b");
    expect(a.voice).toBeNull();
    expect(a.pitch).not.toBe(b.pitch);
    speech.install(voices);
    expect(director.castingFor("a").voice).not.toBeNull();
  });

  it("widens the pitch spread when a voice has to be shared", () => {
    const only = [voice("Alex")];
    const taken = new Set(["Alex"]);
    const shared = castVoice("dba", only, taken);
    expect(shared.voice?.name).toBe("Alex");
    expect(Math.abs(shared.pitch - 1)).toBeLessThanOrEqual(0.3);
  });
});

describe("sound system wiring", () => {
  it("ducks the beds while someone speaks and stays silent until unlocked", async () => {
    const context = new FakeAudioContext();
    const speech = new FakeSpeech();
    const { engine, voice: director } = createSoundSystem(() => context as unknown as AudioContext, speech);
    await expect(director.speak("Too early.", "a")).resolves.toBe("skipped");

    engine.unlock();
    const ducked = vi.spyOn(engine, "setDucked");
    void director.speak("Now we talk.", "a");
    speech.spoken[0].events.onStart();
    expect(ducked).toHaveBeenLastCalledWith(true);
    speech.spoken[0].events.onEnd("spoken");
    expect(ducked).toHaveBeenLastCalledWith(false);
  });

  it("cuts speech off when muted", async () => {
    const speech = new FakeSpeech();
    const { engine, voice: director } = createSoundSystem(() => undefined, speech);
    engine.unlock();
    const line = director.speak("Can you hear me?", "a");
    engine.setMuted(true);
    await expect(line).resolves.toBe("cancelled");
    await expect(director.speak("Hello?", "a")).resolves.toBe("skipped");
  });
});

describe("soundscape", () => {
  const ZONES: readonly Zone[] = ["desk", "corridor", "data-centre", "meeting", "other"];
  const at = (panic: number, zone: Zone, isLaptopOpen = false): SoundscapeState => ({ panic, zone, isLaptopOpen, rackProximity: 0.5 });
  const steps = Array.from({ length: 21 }, (_, index) => index / 20);

  it.each(ZONES)("only builds as panic rises in the %s", (zone) => {
    for (const isLaptopOpen of [false, true]) {
      const mixes = steps.map((panic) => soundscapeFor(at(panic, zone, isLaptopOpen)));
      for (let index = 1; index < mixes.length; index += 1) {
        const [before, after] = [mixes[index - 1], mixes[index]];
        expect(after.alarm).toBeGreaterThanOrEqual(before.alarm);
        expect(after.alarmIntensity).toBeGreaterThanOrEqual(before.alarmIntensity);
        expect(after.heartbeat).toBeGreaterThanOrEqual(before.heartbeat);
        expect(after.heartbeatBpm ?? 0).toBeGreaterThanOrEqual(before.heartbeatBpm ?? 0);
        expect(after.ambience).toBeGreaterThanOrEqual(before.ambience);
      }
    }
  });

  it("is calm at zero panic and at full tilt at one", () => {
    const calm = soundscapeFor(at(0, "data-centre"));
    expect(calm.heartbeatBpm).toBeNull();
    expect(calm.heartbeat).toBe(0);
    expect(calm.alarm).toBe(0);

    const panic = soundscapeFor(at(1, "data-centre"));
    expect(panic.heartbeatBpm).toBe(130);
    expect(panic.alarm).toBe(1);
    expect(panic.alarmIntensity).toBe(1);
  });

  it("keeps every level within 0..1 and clamps bad input", () => {
    for (const zone of ZONES) {
      for (const panic of [-1, Number.NaN, 0, 0.5, 1, 7]) {
        const mix = soundscapeFor({ panic, zone, isLaptopOpen: true, rackProximity: 3 });
        for (const level of [mix.ambience, mix.serverHum, mix.alarm, mix.alarmIntensity, mix.heartbeat, mix.rackProximity]) {
          expect(level).toBeGreaterThanOrEqual(0);
          expect(level).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("brings the racks forward only in the data centre", () => {
    const near = soundscapeFor({ panic: 0, zone: "data-centre", isLaptopOpen: false, rackProximity: 1 });
    const far = soundscapeFor({ panic: 0, zone: "data-centre", isLaptopOpen: false, rackProximity: 0 });
    expect(near.serverHum).toBeGreaterThan(far.serverHum);
    expect(soundscapeFor({ panic: 0, zone: "desk", isLaptopOpen: false, rackProximity: 1 }).rackProximity).toBe(0);
    expect(soundscapeFor(at(0, "data-centre")).serverHum).toBeGreaterThan(soundscapeFor(at(0, "desk")).serverHum);
  });

  it("pulls the room back while the laptop is open", () => {
    expect(soundscapeFor(at(0.8, "desk", true)).ambience).toBeLessThan(soundscapeFor(at(0.8, "desk")).ambience);
  });
});
