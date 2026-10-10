import { describe, expect, it } from "vitest";
import { VoiceMesh, type PeerState, type Signal } from "./mesh.ts";

/** Just enough of RTCPeerConnection's offer/answer state machine to check who offers, answers and sends what. */
class FakeConnection extends EventTarget {
  signalingState: RTCSignalingState = "stable";
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  connectionState: RTCPeerConnectionState = "new";
  readonly transceivers: FakeTransceiver[] = [];
  isClosed = false;

  addTransceiver() {
    const transceiver = new FakeTransceiver();
    this.transceivers.push(transceiver);
    queueMicrotask(() => this.dispatchEvent(new Event("negotiationneeded")));
    return transceiver;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async setLocalDescription() {
    const type: RTCSdpType = this.signalingState === "have-remote-offer" ? "answer" : "offer";
    this.localDescription = { type, sdp: `${type}-sdp` };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: { type: RTCSdpType }) {
    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
      if (this.transceivers.length === 0) this.transceivers.push(new FakeTransceiver());
    } else this.signalingState = "stable";
  }
  async addIceCandidate() {}
  restartIce() {}
  close() {
    this.isClosed = true;
  }
}

class FakeTransceiver {
  direction: RTCRtpTransceiverDirection = "recvonly";
  readonly receiver = { track: { kind: "audio" } };
  sent: unknown = "never set";
  readonly sender = { replaceTrack: async (track: unknown) => void (this.sent = track) };
}

/** Two meshes whose channels deliver straight into each other. */
function pair(firstId: string, secondId: string) {
  const connections = new Map<string, FakeConnection>();
  const states: Record<string, PeerState[]> = { [firstId]: [], [secondId]: [] };
  const meshes = new Map<string, VoiceMesh>();
  const make = (selfId: string) =>
    new VoiceMesh({
      selfId,
      channel: { send: (to: string, signal: Signal) => queueMicrotask(() => void meshes.get(to)?.receive(selfId, signal)) },
      createConnection: () => {
        const connection = new FakeConnection();
        connections.set(selfId, connection);
        return connection as unknown as RTCPeerConnection;
      },
      onStream: () => undefined,
      onState: (_peer, state) => states[selfId].push(state),
      onError: (_peer, error) => {
        throw error;
      },
    });
  meshes.set(firstId, make(firstId));
  meshes.set(secondId, make(secondId));
  return { meshes, connections, states };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("room voice mesh", () => {
  it("lets the lower id offer and the other answer, ending stable on both sides", async () => {
    const { meshes, connections } = pair("a-player", "b-player");
    meshes.get("a-player")?.setPeers(["b-player"]);
    meshes.get("b-player")?.setPeers(["a-player"]);
    await settle();
    expect(connections.get("a-player")?.localDescription?.type).toBe("offer");
    expect(connections.get("b-player")?.localDescription?.type).toBe("answer");
    expect(connections.get("a-player")?.signalingState).toBe("stable");
    expect(connections.get("b-player")?.signalingState).toBe("stable");
  });

  it("sends the microphone both ways and swaps it without renegotiating", async () => {
    const { meshes, connections } = pair("a-player", "b-player");
    const track = { kind: "audio" } as unknown as MediaStreamTrack;
    meshes.get("b-player")?.setMicrophone(track);
    meshes.get("a-player")?.setPeers(["b-player"]);
    meshes.get("b-player")?.setPeers(["a-player"]);
    await settle();
    expect(connections.get("b-player")?.transceivers[0]?.sent).toBe(track);
    expect(connections.get("b-player")?.transceivers[0]?.direction).toBe("sendrecv");
    meshes.get("b-player")?.setMicrophone(null);
    await settle();
    expect(connections.get("b-player")?.transceivers[0]?.sent).toBeNull();
    expect(connections.get("b-player")?.signalingState).toBe("stable");
  });

  it("answers an offer that arrives before the teammate shows up in the player list", async () => {
    const { meshes, connections } = pair("a-player", "b-player");
    meshes.get("a-player")?.setPeers(["b-player"]);
    await settle();
    expect(connections.get("b-player")?.localDescription?.type).toBe("answer");
  });

  it("hangs up on a teammate who leaves, and never calls itself", async () => {
    const { meshes, connections } = pair("a-player", "b-player");
    meshes.get("a-player")?.setPeers(["a-player", "b-player"]);
    await settle();
    expect(connections.size).toBe(2);
    meshes.get("a-player")?.setPeers(["a-player"]);
    expect(connections.get("a-player")?.isClosed).toBe(true);
  });
});
