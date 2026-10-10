import { useCallback, useEffect } from "react";
import type { Discussion } from "../app/useShiftGame.ts";
import { failBuzz, getAudio, successChime } from "../audio/index.ts";
import type { PresentedIncident } from "../domain/shift.ts";
import type { Attempt, Progress } from "../domain/progress.ts";
import { ROLE_INFO } from "../domain/roles.ts";
import { ShiftReport } from "./ShiftReport.tsx";
import { ShiftView } from "./ShiftView.tsx";

type Props = {
  discussion: Discussion;
  progress: Progress;
  shareUrl: string;
  onAnswer: (attempt: Attempt) => number;
  onWrapUp: () => void;
  onClose: () => void;
};

/** A discussion at a wall screen: the room's big display, with the cards on it. */
export function DiscussionOverlay({ discussion, progress, shareUrl, onAnswer, onWrapUp, onClose }: Props) {
  const earnings = progress.wallet.ledger.filter((entry) => entry.seq >= discussion.paidFromSeq && entry.reason === "card");
  const roomName = discussion.room ? ROLE_INFO[discussion.room].room : "Library";
  const { engine, voice } = getAudio();
  // The colleague standing at the screen talks it through; one voice per room.
  const presenter = `presenter-${discussion.room ?? "library"}`;
  const onCardShown = useCallback(
    (presented: PresentedIncident) => {
      voice.cancel();
      void voice.speak(`${presented.incident.alert.title}. ${presented.incident.question}`, presenter);
    },
    [presenter, voice],
  );
  const onAnswered = useCallback(
    (presented: PresentedIncident, isCorrect: boolean) => {
      if (isCorrect) successChime(engine);
      else failBuzz(engine);
      voice.cancel();
      void voice.speak(`${isCorrect ? "Nice catch." : "Not quite."} ${presented.incident.explanation.cause}`, presenter);
    },
    [engine, presenter, voice],
  );
  useEffect(() => () => voice.cancel(), [voice]);
  return (
    <section className="discussion" role="dialog" aria-modal="true" aria-label={`Discussion at the ${roomName} screen`}>
      <div className="discussion__frame">
        <header className="discussion__bar">
          <p>
            {roomName} screen · {discussion.run.mode === "rated" ? "today’s problems" : "practice"}
          </p>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Step away
          </button>
        </header>
        <div className="discussion__body">
          {discussion.stage === "cards" ? (
            <ShiftView
              key={discussion.run.incidents.map((item) => item.incident.id).join(",")}
              run={discussion.run}
              onAnswer={onAnswer}
              onFinish={onWrapUp}
              onLeave={onClose}
              onCardShown={onCardShown}
              onAnswered={onAnswered}
            />
          ) : (
            <ShiftReport run={discussion.run} progress={progress} earnings={earnings} shareUrl={shareUrl} onDone={onClose} />
          )}
        </div>
      </div>
    </section>
  );
}
