import { useEffect, useState } from "react";
import { getAudio, successChime } from "../audio/index.ts";
import { useCareer } from "../app/career-context.ts";
import type { Career } from "../domain/career.ts";
import { formatCents, SALARY_CENTS_PER_MINUTE } from "../domain/economy.ts";

const SHOWN_MS = 6_000;

/** The moment a promotion lands: a chime, the manager saying it out loud, and the new pay rate. Silent for the level you arrived with. */
export function PromotionToast() {
  const career = useCareer();
  const [announcedLevel, setAnnouncedLevel] = useState(career.level);
  const [promotion, setPromotion] = useState<Career | null>(null);

  if (career.level > announcedLevel) {
    setAnnouncedLevel(career.level);
    setPromotion(career);
  }

  useEffect(() => {
    if (promotion === null) return;
    const { engine, voice } = getAudio();
    successChime(engine);
    void voice.speak(`Congratulations, you're now ${promotion.title}.`, "manager");
    const timer = window.setTimeout(() => setPromotion(null), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [promotion]);

  return (
    <p className="promotion" role="status" aria-live="polite">
      {promotion && (
        <span className="promotion__card">
          <strong>Promoted to {promotion.title}</strong>
          <span>Pay is now {formatCents(SALARY_CENTS_PER_MINUTE[promotion.level] * 60)}/h on the floor, and harder incidents can page you.</span>
        </span>
      )}
    </p>
  );
}
