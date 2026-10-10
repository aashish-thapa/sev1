import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceMesh, type PeerState, type Signal } from "./mesh.ts";

/** The room, as voice needs it: who you are, who's connected, and a way to pass handshakes along. */
export type VoiceRoom = {
  readonly selfId: string | null;
  readonly peerIds: readonly string[];
  sendSignal(to: string, signal: Signal): void;
  /** Subscribes to signals relayed from teammates; returns the unsubscribe. */
  onSignal(listener: (from: string, signal: Signal) => void): () => void;
  /** Tells teammates whether your mic is open. */
  announceMic(isOn: boolean): void;
};

export type MicState = { readonly name: "off" } | { readonly name: "asking" } | { readonly name: "on" } | { readonly name: "denied"; readonly reason: string };

export type Voice = {
  readonly mic: MicState;
  /** True while you're heard: the mic is on, or V is held. */
  readonly isTransmitting: boolean;
  readonly isSpeakerOn: boolean;
  /** 0…1 per player id, yours under your own id; for speaking indicators. */
  readonly levels: ReadonlyMap<string, number>;
  readonly peers: ReadonlyMap<string, PeerState>;
  toggleMic(): void;
  toggleSpeaker(): void;
};

/** Public STUN only: peers find each other directly; strict NATs without a relay will show as "failed". */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const PUSH_TO_TALK_KEY = "v";
const LEVEL_SAMPLE_MS = 120;
/** Below this RMS a channel reads as silent, so background hiss doesn't light the indicator. */
const SPEAKING_FLOOR = 0.02;

/** Room voice: one mesh per room, the microphone only once you ask for it, and a level per speaker. */
export function useVoice(room: VoiceRoom | null): Voice {
  const [mic, setMic] = useState<MicState>({ name: "off" });
  const [isHoldingKey, setHoldingKey] = useState(false);
  const [isSpeakerOn, setSpeakerOn] = useState(true);
  const [levels, setLevels] = useState<ReadonlyMap<string, number>>(new Map());
  const [peers, setPeers] = useState<ReadonlyMap<string, PeerState>>(new Map());
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<AudioRig | null>(null);
  const mesh = useRef<VoiceMesh | null>(null);
  // The room object is new every render; effects reach the latest one through here.
  const latestRoom = useRef(room);
  useEffect(() => {
    latestRoom.current = room;
  });
  const selfId = room?.selfId ?? null;
  const isSpeakerOnNow = useRef(isSpeakerOn);
  // The audio engine is made on demand and dropped when closed, so a remount (React mounts twice in
  // development) never keeps using a closed one; a fresh one picks up the speaker setting and your mic.
  const rig = useCallback(() => {
    if (!audio.current) {
      audio.current = new AudioRig();
      audio.current.setMuted(!isSpeakerOnNow.current);
      if (microphone.current) audio.current.listenToSelf(microphone.current);
    }
    return audio.current;
  }, []);

  // One mesh per seat: a new room (or a new seat in it) starts every call over.
  useEffect(() => {
    const current = latestRoom.current;
    if (!current || !selfId) return;
    const created = new VoiceMesh({
      selfId,
      channel: { send: (to, signal) => latestRoom.current?.sendSignal(to, signal) },
      createConnection: () => new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      onStream: (peerId, stream) => rig().play(peerId, stream),
      onState: (peerId, state) => setPeers((current) => new Map(current).set(peerId, state)),
      onError: (peerId) => setPeers((current) => new Map(current).set(peerId, "failed")),
    });
    mesh.current = created;
    created.setMicrophone(microphone.current?.getAudioTracks()[0] ?? null);
    const unsubscribe = current.onSignal((from, signal) => void created.receive(from, signal));
    return () => {
      unsubscribe();
      created.close();
      mesh.current = null;
      setPeers(new Map());
    };
  }, [rig, selfId]);

  const peerKey = room?.peerIds.join(",") ?? "";
  useEffect(() => {
    mesh.current?.setPeers(peerKey ? peerKey.split(",") : []);
  }, [peerKey, selfId]);

  const isTransmitting = hasMicrophone && (mic.name === "on" || isHoldingKey);
  useEffect(() => {
    for (const track of microphone.current?.getAudioTracks() ?? []) track.enabled = isTransmitting;
    latestRoom.current?.announceMic(isTransmitting);
  }, [isTransmitting, selfId]);

  useEffect(() => {
    isSpeakerOnNow.current = isSpeakerOn;
    audio.current?.setMuted(!isSpeakerOn);
  }, [isSpeakerOn]);

  // Speaking indicators: sample every channel a few times a second.
  useEffect(() => {
    if (!selfId) return;
    let isSampling = false;
    const timer = setInterval(() => {
      if (isSampling) return;
      isSampling = true;
      const sampled = audio.current?.sample(selfId) ?? new Map<string, number>();
      // Your own light follows what's actually sent: Chrome's echo cancellation flattens a local meter once the
      // track is on a call. Alone in the room there's no call, and the local meter is all there is.
      void (mesh.current?.sentLevel() ?? Promise.resolve(null))
        .then((sent) => {
          if (sent !== null) sampled.set(selfId, sent < SPEAKING_FLOOR ? 0 : Math.min(1, sent * 4));
          setLevels(sampled);
        })
        .finally(() => {
          isSampling = false;
        });
    }, LEVEL_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [selfId]);

  useEffect(
    () => () => {
      audio.current?.close();
      audio.current = null;
    },
    [],
  );

  const acquire = useCallback(async (): Promise<boolean> => {
    if (microphone.current) return true;
    setMic({ name: "asking" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      microphone.current = stream;
      setHasMicrophone(true);
      rig().listenToSelf(stream);
      mesh.current?.setMicrophone(stream.getAudioTracks()[0] ?? null);
      return true;
    } catch (error) {
      setMic({ name: "denied", reason: error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone permission was refused." : "No microphone could be opened." });
      return false;
    }
  }, [rig]);

  const toggleMic = useCallback(() => {
    if (mic.name === "on") return setMic({ name: "off" });
    void acquire().then((isReady) => {
      if (isReady) setMic({ name: "on" });
    });
  }, [acquire, mic.name]);

  // Push to talk: hold V, unless the keys are going into the terminal or a text field.
  useEffect(() => {
    if (!selfId) return;
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== PUSH_TO_TALK_KEY || isTyping(event.target)) return;
      void acquire().then((isReady) => setHoldingKey(isReady));
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === PUSH_TO_TALK_KEY) setHoldingKey(false);
    };
    const release = () => setHoldingKey(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [acquire, selfId]);

  return useMemo(
    () => ({ mic, isTransmitting, isSpeakerOn, levels, peers, toggleMic, toggleSpeaker: () => setSpeakerOn((isOn) => !isOn) }),
    [mic, isTransmitting, isSpeakerOn, levels, peers, toggleMic],
  );
}

/** Plays each teammate through an <audio> element and measures every channel, yours included. */
class AudioRig {
  private readonly context = new AudioContext();
  private readonly players = new Map<string, HTMLAudioElement>();
  private readonly meters = new Map<string, AnalyserNode>();
  private selfMeter: AnalyserNode | null = null;
  private isMuted = false;

  play(peerId: string, stream: MediaStream | null) {
    this.players.get(peerId)?.remove();
    this.players.delete(peerId);
    this.meters.get(peerId)?.disconnect();
    this.meters.delete(peerId);
    if (!stream) return;
    const element = new Audio();
    element.autoplay = true;
    element.muted = this.isMuted;
    element.srcObject = stream;
    // Browsers only start remote audio after a gesture; joining the room was one, so this normally plays.
    void element.play().catch(() => undefined);
    this.players.set(peerId, element);
    this.meters.set(peerId, this.meter(stream));
  }

  listenToSelf(stream: MediaStream) {
    this.selfMeter = this.meter(stream);
  }

  setMuted(isMuted: boolean) {
    this.isMuted = isMuted;
    for (const element of this.players.values()) element.muted = isMuted;
  }

  sample(selfId: string): Map<string, number> {
    const levels = new Map<string, number>();
    for (const [peerId, meter] of this.meters) levels.set(peerId, level(meter));
    if (this.selfMeter) levels.set(selfId, level(this.selfMeter));
    return levels;
  }

  close() {
    for (const element of this.players.values()) element.remove();
    void this.context.close();
  }

  private meter(stream: MediaStream): AnalyserNode {
    if (this.context.state === "suspended") void this.context.resume();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(stream).connect(analyser);
    return analyser;
  }
}

function level(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  return rms < SPEAKING_FLOOR ? 0 : Math.min(1, rms * 4);
}
