import type { Voice } from "../../multiplayer/voice/useVoice.ts";
import { TagMarks } from "../../ui/TagMark.tsx";

type Member = { readonly id: string; readonly name: string; readonly isMicOn: boolean; readonly tags: readonly string[] };

type Props = {
  voice: Voice;
  selfId: string;
  /** Everyone connected to the room, you included. */
  members: readonly Member[];
};

const MIC_LABEL: Readonly<Record<Voice["mic"]["name"], string>> = {
  off: "Mic off",
  asking: "Allow mic…",
  on: "Mic on",
  denied: "Mic blocked",
};

/** Room voice, like a squad game's: open mic or hold V, mute everyone, and see who's talking. */
export function VoiceControls({ voice, selfId, members }: Props) {
  return (
    <section className="voice" aria-label="Voice chat">
      <ul className="voice__roster">
        {members.map((member) => {
          const isSelf = member.id === selfId;
          const level = voice.levels.get(member.id) ?? 0;
          const isTalking = level > 0 && (isSelf ? voice.isTransmitting : true);
          const state = isSelf ? null : voice.peers.get(member.id);
          return (
            <li key={member.id} className="voice__member" data-talking={isTalking} data-failed={state === "failed"}>
              <span className="voice__light" aria-hidden="true" style={{ opacity: isTalking ? 0.45 + level * 0.55 : undefined }} />
              <span className="voice__name">
                {member.name}
                <TagMarks ids={member.tags} />
                {isSelf && " (you)"}
              </span>
              <span className="voice__state">
                {state === "failed" ? "can’t connect" : state === "connecting" ? "connecting…" : member.isMicOn ? "mic on" : "muted"}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="voice__buttons">
        <button type="button" className="voice__button" aria-pressed={voice.mic.name === "on"} disabled={voice.mic.name === "asking"} onClick={voice.toggleMic}>
          {MIC_LABEL[voice.mic.name]}
        </button>
        <button type="button" className="voice__button" aria-pressed={!voice.isSpeakerOn} onClick={voice.toggleSpeaker}>
          {voice.isSpeakerOn ? "Speaker on" : "Speaker muted"}
        </button>
      </div>
      <p className="voice__hint" role="status">
        {voice.mic.name === "denied" ? voice.mic.reason : voice.isTransmitting && voice.mic.name !== "on" ? "Talking…" : "Hold V to talk"}
      </p>
    </section>
  );
}
