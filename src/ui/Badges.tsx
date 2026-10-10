import { badgeStandings, type Badge, type BadgeStanding } from "../domain/achievements.ts";
import type { Progress } from "../domain/progress.ts";

/** A badge's mark: its family glyph in its tier's colour. */
export function BadgeMark({ badge, isEarned = true }: { badge: Badge; isEarned?: boolean }) {
  return (
    <span className="badge-mark" data-tier={badge.tier} data-earned={isEarned} aria-hidden="true">
      {badge.glyph}
    </span>
  );
}

type ShelfProps = {
  progress: Progress;
  featured: string | null;
  onFeature: (badgeId: string | null) => void;
};

/** Every badge: earned ones you can show by your name, locked ones with how far you are. */
export function BadgeShelf({ progress, featured, onFeature }: ShelfProps) {
  const standings = badgeStandings(progress);
  const earned = standings.filter((standing) => standing.isEarned).length;
  return (
    <section className="badges" aria-labelledby="badges-title">
      <header className="badges__head">
        <h2 id="badges-title" className="home__heading">
          Badges
        </h2>
        <p className="badges__count">
          {earned} of {standings.length} earned
        </p>
      </header>
      <ul className="badges__grid">
        {standings.map((standing) => (
          <BadgeCard key={standing.badge.id} standing={standing} isFeatured={featured === standing.badge.id} onFeature={onFeature} />
        ))}
      </ul>
    </section>
  );
}

function BadgeCard({ standing, isFeatured, onFeature }: { standing: BadgeStanding; isFeatured: boolean; onFeature: ShelfProps["onFeature"] }) {
  const { badge, current, isEarned } = standing;
  return (
    <li className="badge-card" data-earned={isEarned}>
      <BadgeMark badge={badge} isEarned={isEarned} />
      <div className="badge-card__text">
        <p className="badge-card__title">{badge.title}</p>
        <p className="badge-card__description">{badge.description}</p>
        {isEarned ? (
          <button
            type="button"
            className="badge-card__feature"
            aria-pressed={isFeatured}
            onClick={() => onFeature(isFeatured ? null : badge.id)}
          >
            {isFeatured ? "Shown by your name" : "Show by my name"}
          </button>
        ) : (
          <>
            <progress className="badge-card__meter" max={badge.target} value={current} aria-label={`${badge.title}: ${current} of ${badge.target}`} />
            <p className="badge-card__progress">
              {current.toLocaleString("en-US")} / {badge.target.toLocaleString("en-US")}
            </p>
          </>
        )}
      </div>
    </li>
  );
}
