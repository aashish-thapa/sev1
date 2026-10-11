import { useEffect, useState } from "react";
import { LOBBY_BACKDROP } from "../lobby/backdrop.ts";
import { LOADING_TIPS } from "./tips.ts";

const TIP_SECONDS = 5;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Tab"]);

type Props = {
  /** How much has loaded, from 0 to 1. */
  progress: number;
  /** Everything has loaded; the next key or tap starts the game. */
  onEnter: (() => void) | null;
  reduceMotion: boolean;
};

/** The title screen: key art, what the game is, and a bar that fills while the lobby loads behind it. */
export function LoadingScreen({ progress, onEnter, reduceMotion }: Props) {
  const tip = useRotatingTip(reduceMotion);
  const percent = Math.round(progress * 100);

  useEffect(() => {
    if (!onEnter) return;
    const enter = (event: KeyboardEvent) => {
      // Modifier keys alone are someone reaching for a shortcut, not saying "start".
      if (MODIFIER_KEYS.has(event.key)) return;
      onEnter();
    };
    window.addEventListener("keydown", enter);
    return () => window.removeEventListener("keydown", enter);
  }, [onEnter]);

  return (
    // A tap starts on click, not pointerdown, so the release can't land on a lobby button beneath.
    <div className="loading" data-ready={onEnter !== null} onClick={onEnter ?? undefined}>
      <img className="loading__art" src={LOBBY_BACKDROP} alt="" />
      <div className="loading__title">
        <p className="loading__kicker">An on-call game</p>
        <h1 className="loading__name">sev1</h1>
        <p className="loading__tagline">Read the alert. Make the call. Keep production up.</p>
      </div>

      <div className="loading__foot">
        <p className="loading__tip" key={tip} aria-live="polite">
          <span className="loading__tip-label">Tip</span>
          {LOADING_TIPS[tip]}
        </p>
        {onEnter ? (
          <button type="button" className="loading__enter" autoFocus>
            Press any key to start
          </button>
        ) : (
          <div className="loading__bar" role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span className="loading__fill" style={{ inlineSize: `${percent}%` }} />
            <span className="loading__percent">{percent}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Steps through the tips; with reduced motion it holds the first, which says what the game is. */
function useRotatingTip(reduceMotion: boolean): number {
  const [tip, setTip] = useState(0);
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => setTip((shown) => (shown + 1) % LOADING_TIPS.length), TIP_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);
  return tip;
}
