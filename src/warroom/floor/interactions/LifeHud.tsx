import type { Cup } from "./coffee.ts";
import type { StandupNotice } from "./useStandup.ts";

type Props = {
  cup: Cup;
  onSip: () => void;
  standup: StandupNotice | null;
};

/** The small, quiet layer of office life over the floor: the sip button while you hold a cup, and the calendar. */
export function LifeHud({ cup, onSip, standup }: Props) {
  return (
    <>
      <div className="life" aria-live="polite">
        {cup.kind === "holding" && (
          <button type="button" className="life__chip life__chip--action" onClick={onSip}>
            <kbd>C</kbd> Sip
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
