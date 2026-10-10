import type { Wellbeing } from "../../../domain/wellbeing.ts";
import { Meters } from "./Meters.tsx";
import type { StandupNotice } from "./useStandup.ts";

type Props = {
  /** What C does right now, if anything: sip the coffee or eat the snack. */
  held: "coffee" | "snack" | null;
  onConsume: () => void;
  standup: StandupNotice | null;
  wellbeing: Wellbeing;
  reduceMotion: boolean;
};

/** The small, quiet layer of office life over the floor: your energy and fullness, the C button while you hold something, and the calendar. */
export function LifeHud({ held, onConsume, standup, wellbeing, reduceMotion }: Props) {
  return (
    <>
      <Meters wellbeing={wellbeing} reduceMotion={reduceMotion} />
      <div className="life" aria-live="polite">
        {held && (
          <button type="button" className="life__chip life__chip--action" onClick={onConsume}>
            <kbd>C</kbd> {held === "coffee" ? "Sip" : "Eat"}
          </button>
        )}
      </div>
      {standup && (
        <p className="life__notice" role="status">
          {standup.kind === "invite" ? (
            <>
              <strong>Calendar · Daily stand-up</strong> now, meeting room A. Walk over and join.
            </>
          ) : (
            <>
              <strong>Sam Tan</strong> {standup.line}
            </>
          )}
        </p>
      )}
    </>
  );
}
