import { useEffect, useRef } from "react";

const DISTANCE_THRESHOLD = 96;
const VELOCITY_THRESHOLD = 0.6; // px per ms

/**
 * Horizontal fling on the element calls `onSwipe` once released past the threshold.
 * Vertical movement is left to the browser (`touch-action: pan-y`), so reading
 * a long card never fights the gesture.
 */
export function useSwipeAway<T extends HTMLElement>(isEnabled: boolean, onSwipe: () => void) {
  const ref = useRef<T>(null);
  const onSwipeRef = useRef(onSwipe);

  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !isEnabled) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isHorizontal: boolean | null = null;

    const reset = () => {
      element.style.transform = "";
      element.style.opacity = "";
      element.dataset.dragging = "false";
    };

    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest("a, button")) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startTime = event.timeStamp;
      isHorizontal = null;
    };

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (isHorizontal === null && Math.hypot(dx, dy) > 8) {
        isHorizontal = Math.abs(dx) > Math.abs(dy);
        if (isHorizontal) element.setPointerCapture(event.pointerId);
      }
      if (!isHorizontal) return;
      element.dataset.dragging = "true";
      element.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      element.style.opacity = String(1 - Math.min(Math.abs(dx) / 480, 0.5));
    };

    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      const dx = event.clientX - startX;
      const velocity = Math.abs(dx) / Math.max(event.timeStamp - startTime, 1);
      const isFling = isHorizontal === true && (Math.abs(dx) > DISTANCE_THRESHOLD || velocity > VELOCITY_THRESHOLD);
      reset();
      if (isFling) onSwipeRef.current();
    };

    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      reset();
    };
  }, [isEnabled]);

  return ref;
}
