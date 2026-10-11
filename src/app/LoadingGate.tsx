import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoadingScreen } from "../ui/loading/LoadingScreen.tsx";
import { trackLoading } from "./boot.ts";

const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Props = {
  /** Everything the first screen needs; the title screen waits for all of them to settle. */
  tasks: readonly PromiseLike<unknown>[];
  /** Keeps the app out of reach of focus and clicks while the title screen covers it. */
  setAppInert: (isInert: boolean) => void;
  children: ReactNode;
};

/**
 * Holds the title screen over the app until the player starts. The app mounts underneath at
 * once, so the lobby, the account and the 3D stage load while the player reads.
 */
export function LoadingGate({ tasks, setAppInert, children }: Props) {
  const [progress, setProgress] = useState(0);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    void trackLoading(tasks, (fraction) => {
      if (isCurrent) setProgress(fraction);
    });
    return () => {
      isCurrent = false;
    };
  }, [tasks]);

  useEffect(() => setAppInert(!hasEntered), [hasEntered, setAppInert]);

  const isLoaded = progress >= 1;
  return (
    <>
      {children}
      {!hasEntered &&
        createPortal(<LoadingScreen progress={progress} onEnter={isLoaded ? () => setHasEntered(true) : null} reduceMotion={reduceMotion} />, document.body)}
    </>
  );
}
