/** The slice of a voice the director needs; SpeechSynthesisVoice satisfies it. */
export type SpeechVoice = {
  readonly name: string;
  readonly lang: string;
  readonly voiceURI: string;
  readonly localService: boolean;
};

export type UtteranceRequest = {
  readonly text: string;
  readonly voice: SpeechVoice | null;
  readonly pitch: number;
  readonly rate: number;
  readonly volume: number;
};

export type UtteranceEnding = "spoken" | "interrupted" | "failed";

export type UtteranceEvents = {
  readonly onStart: () => void;
  readonly onEnd: (ending: UtteranceEnding) => void;
};

/** A text-to-speech engine. The browser's Web Speech API is the production one. */
export interface SpeechBackend {
  voices(): readonly SpeechVoice[];
  /** Voices load asynchronously in Chrome, so the first `voices()` can be empty. */
  onVoicesChanged(listener: () => void): () => void;
  speak(request: UtteranceRequest, events: UtteranceEvents): void;
  cancel(): void;
}

export function browserSpeechBackend(): SpeechBackend | undefined {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return undefined;
  return new WebSpeechBackend(speechSynthesis);
}

class WebSpeechBackend implements SpeechBackend {
  private readonly synth: SpeechSynthesis;
  /**
   * Chrome can garbage-collect an utterance that nothing references while it is
   * still speaking, and then `end` never fires. Holding it here prevents that.
   */
  private inFlight: SpeechSynthesisUtterance | null = null;

  constructor(synth: SpeechSynthesis) {
    this.synth = synth;
  }

  voices(): readonly SpeechVoice[] {
    return this.synth.getVoices();
  }

  onVoicesChanged(listener: () => void): () => void {
    this.synth.addEventListener("voiceschanged", listener);
    return () => this.synth.removeEventListener("voiceschanged", listener);
  }

  speak(request: UtteranceRequest, events: UtteranceEvents): void {
    const utterance = new SpeechSynthesisUtterance(request.text);
    const wanted = request.voice?.voiceURI;
    utterance.voice = wanted === undefined ? null : (this.synth.getVoices().find((voice) => voice.voiceURI === wanted) ?? null);
    if (utterance.voice) utterance.lang = utterance.voice.lang;
    utterance.pitch = request.pitch;
    utterance.rate = request.rate;
    utterance.volume = request.volume;

    // Engines disagree on whether a cancelled utterance fires `end`, `error`, or both.
    let isSettled = false;
    const settle = (ending: UtteranceEnding) => {
      if (isSettled) return;
      isSettled = true;
      if (this.inFlight === utterance) this.inFlight = null;
      events.onEnd(ending);
    };
    utterance.addEventListener("start", () => events.onStart());
    utterance.addEventListener("end", () => settle("spoken"));
    utterance.addEventListener("error", (event) =>
      settle(event.error === "interrupted" || event.error === "canceled" ? "interrupted" : "failed"),
    );

    this.inFlight = utterance;
    this.synth.speak(utterance);
  }

  cancel(): void {
    this.synth.cancel();
  }
}
