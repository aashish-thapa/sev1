/**
 * Room voice as a full mesh: every engineer holds one audio-only WebRTC connection to each
 * teammate (a room seats five, so at most four). Audio flows peer to peer; the room socket only
 * relays the handshake. Of each pair, the player with the lower id makes the offer, so offers
 * don't cross in the normal case; the perfect-negotiation rules settle the rare collision
 * (a reconnect, an ICE restart) without either side getting stuck.
 */

import type { Signal } from "../protocol.ts";

export type { Signal };

/** The room socket, as far as voice needs it. */
export interface SignalChannel {
  send(to: string, signal: Signal): void;
}

export type PeerState = "connecting" | "connected" | "failed";

type Options = {
  readonly selfId: string;
  readonly channel: SignalChannel;
  /** A fresh RTCPeerConnection per teammate; injected so tests can stand in for the browser. */
  readonly createConnection: () => RTCPeerConnection;
  readonly onStream: (peerId: string, stream: MediaStream | null) => void;
  readonly onState: (peerId: string, state: PeerState) => void;
  /** Called with a failure that costs one teammate's audio, never the room. */
  readonly onError: (peerId: string, error: unknown) => void;
};

type Link = {
  readonly connection: RTCPeerConnection;
  readonly isPolite: boolean;
  transceiver: RTCRtpTransceiver | null;
  isMakingOffer: boolean;
  isIgnoringOffer: boolean;
};

export class VoiceMesh {
  private readonly links = new Map<string, Link>();
  private microphone: MediaStreamTrack | null = null;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  /** Calls every connected teammate in `peerIds` and hangs up on anyone no longer in it. */
  setPeers(peerIds: readonly string[]) {
    const wanted = new Set(peerIds.filter((id) => id !== this.options.selfId));
    for (const id of [...this.links.keys()]) if (!wanted.has(id)) this.hangUp(id);
    for (const id of wanted) if (!this.links.has(id)) this.dial(id);
  }

  /** What every teammate hears from us; null sends nothing. No renegotiation: the track is swapped in place. */
  setMicrophone(track: MediaStreamTrack | null) {
    this.microphone = track;
    for (const [peerId, link] of this.links) {
      link.transceiver?.sender.replaceTrack(track).catch((error: unknown) => this.options.onError(peerId, error));
    }
  }

  async receive(from: string, signal: Signal) {
    const link = this.links.get(from) ?? this.dial(from);
    const { connection } = link;
    try {
      if (signal.kind === "candidate") {
        try {
          await connection.addIceCandidate(signal.candidate ?? undefined);
        } catch (error) {
          // Candidates for an offer we chose to ignore are expected to fail.
          if (!link.isIgnoringOffer) throw error;
        }
        return;
      }
      const { description } = signal;
      const isCollision = description.type === "offer" && (link.isMakingOffer || connection.signalingState !== "stable");
      link.isIgnoringOffer = !link.isPolite && isCollision;
      if (link.isIgnoringOffer) return;
      await connection.setRemoteDescription(description);
      if (description.type !== "offer") return;
      // The answering side's audio line arrives with the offer; send our microphone on it.
      link.transceiver ??= connection.getTransceivers().find((candidate) => candidate.receiver.track.kind === "audio") ?? null;
      if (link.transceiver) {
        link.transceiver.direction = "sendrecv";
        await link.transceiver.sender.replaceTrack(this.microphone);
      }
      await connection.setLocalDescription();
      this.sendDescription(from, connection);
    } catch (error) {
      this.options.onError(from, error);
    }
  }

  /** The loudest level (0…1) your microphone is being sent at right now; null when nobody's on the call. */
  async sentLevel(): Promise<number | null> {
    let loudest: number | null = null;
    for (const link of this.links.values()) {
      const sender = link.transceiver?.sender;
      if (!sender?.track) continue;
      const stats = await sender.getStats();
      stats.forEach((report: { type?: string; kind?: string; audioLevel?: number }) => {
        if (report.type === "media-source" && report.kind === "audio" && typeof report.audioLevel === "number") loudest = Math.max(loudest ?? 0, report.audioLevel);
      });
    }
    return loudest;
  }

  close() {
    for (const id of [...this.links.keys()]) this.hangUp(id);
  }

  private dial(peerId: string): Link {
    const connection = this.options.createConnection();
    const isOfferer = this.options.selfId < peerId;
    const link: Link = { connection, isPolite: !isOfferer, transceiver: null, isMakingOffer: false, isIgnoringOffer: false };
    this.links.set(peerId, link);

    connection.addEventListener("negotiationneeded", async () => {
      try {
        link.isMakingOffer = true;
        await connection.setLocalDescription();
        this.sendDescription(peerId, connection);
      } catch (error) {
        this.options.onError(peerId, error);
      } finally {
        link.isMakingOffer = false;
      }
    });
    connection.addEventListener("icecandidate", (event) => {
      this.options.channel.send(peerId, { kind: "candidate", candidate: event.candidate ? event.candidate.toJSON() : null });
    });
    connection.addEventListener("track", (event) => this.options.onStream(peerId, event.streams[0] ?? new MediaStream([event.track])));
    connection.addEventListener("connectionstatechange", () => {
      const state = connection.connectionState;
      if (state === "connected") this.options.onState(peerId, "connected");
      else if (state === "failed") {
        this.options.onState(peerId, "failed");
        // The offerer retries with fresh candidates; a network change can make a dead path live again.
        if (isOfferer) connection.restartIce();
      } else if (state === "new" || state === "connecting") this.options.onState(peerId, "connecting");
    });

    this.options.onState(peerId, "connecting");
    if (isOfferer) {
      link.transceiver = connection.addTransceiver("audio", { direction: "sendrecv" });
      link.transceiver.sender.replaceTrack(this.microphone).catch((error: unknown) => this.options.onError(peerId, error));
    }
    return link;
  }

  private sendDescription(peerId: string, connection: RTCPeerConnection) {
    const description = connection.localDescription;
    if (description) this.options.channel.send(peerId, { kind: "description", description: { type: description.type, sdp: description.sdp } });
  }

  private hangUp(peerId: string) {
    this.links.get(peerId)?.connection.close();
    this.links.delete(peerId);
    this.options.onStream(peerId, null);
  }
}
