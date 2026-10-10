import type { Cup } from "./coffee.ts";
import type { StandupNotice } from "./useStandup.ts";

type Props = {
  cup: Cup;
  /** Seconds of caffeine left; zero when none. */
  caffeine: number;
  onSip: () => void;
  standup: StandupNotice | null;
  /** Paged and away from your desk: where to go to work. */
  showDeskHint: boolean;
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The small, quiet layer of office life over the floor: your coffee, the calendar, where your desk is. */
export function LifeHud({ cup, caffeine, onSip, standup, showDeskHint }: Props) {
  return (
    <>
      <div className="life" aria-live="polite">
        {cup.kind === "brewing" && <p className="life__chip">Brewing…</p>}
        {cup.kind === "holding" && (
          <button type="button" className="life__chip life__chip--action" onClick={onSip}>
            <kbd>C</kbd> Sip · {cup.sipsLeft} left
          </button>
        )}
        {caffeine > 0 && <p className="life__chip life__chip--good">Caffeinated · {clock(caffeine)}</p>}
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
      {showDeskHint && (
        <p className="life__hint">Your desk is on the dev floor, front row by the data-centre glass. Sit down to work at your monitors, or press L for your laptop.</p>
      )}
    </>
  );
}
