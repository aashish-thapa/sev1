import { useCareer } from "../app/career-context.ts";
import type { Career } from "../domain/career.ts";
import { TITLES } from "../domain/career.ts";
import { formatCents, SALARY_CENTS_PER_MINUTE } from "../domain/economy.ts";

const perHour = (career: Career) => `${formatCents(SALARY_CENTS_PER_MINUTE[career.level] * 60)}/h`;

/** Lobby: where you stand on the ladder, what it pays, and how far the next promotion is. */
export function CareerLadder({ career }: { career: Career }) {
  const next = career.nextAt === null ? null : TITLES[career.level + 1];
  return (
    <section className="career" aria-label="Your career">
      <p className="career__title">
        {career.title} <span className="career__pay">· paid {perHour(career)} while you’re on the floor</span>
      </p>
      {next && career.nextAt !== null ? (
        <>
          <progress className="career__meter" max={career.nextAt} value={career.experience} aria-label={`Experience toward ${next}`} />
          <p className="career__next">
            {career.experience} / {career.nextAt} XP to {next} · {formatCents(SALARY_CENTS_PER_MINUTE[(career.level + 1) as Career["level"]] * 60)}/h. Correct calls and closed incidents count.
          </p>
        </>
      ) : (
        <p className="career__next">Top of the ladder. Every incident still pays.</p>
      )}
    </section>
  );
}

/** HUD stat: just the title. */
export function CareerChip() {
  const career = useCareer();
  return (
    <div className="career-chip">
      <dt>Level</dt>
      <dd>{career.title}</dd>
    </div>
  );
}
