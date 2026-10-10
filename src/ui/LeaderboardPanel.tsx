import { badgeById } from "../domain/achievements.ts";
import type { LeaderboardView } from "../storage/leaderboard-api.ts";
import { BadgeMark } from "./Badges.tsx";
import { TagMarks } from "./TagMark.tsx";

type Props = {
  view: LeaderboardView;
  /** The signed-in player's username, to mark their row; null for guests. */
  you: string | null;
  onSignUp: () => void;
};

/** The top accounts by experience, and where you stand. */
export function LeaderboardPanel({ view, you, onSignUp }: Props) {
  return (
    <section className="leaderboard" aria-labelledby="leaderboard-title">
      <header className="badges__head">
        <h2 id="leaderboard-title" className="home__heading">
          Leaderboard
        </h2>
        <p className="badges__count">By experience</p>
      </header>
      {view.status === "loading" && <p className="leaderboard__note">Loading the board…</p>}
      {view.status === "unavailable" && <p className="leaderboard__note">The leaderboard isn’t reachable right now.</p>}
      {view.status === "ready" && (
        <>
          {view.board.entries.length === 0 ? (
            <p className="leaderboard__note">Nobody’s on the board yet. Sign up and close an incident to be first.</p>
          ) : (
            <ol className="leaderboard__list">
              {view.board.entries.map((entry) => {
                const badge = entry.featuredBadge ? badgeById(entry.featuredBadge) : undefined;
                return (
                  <li key={entry.username} className="leaderboard__row" data-you={entry.username === you}>
                    <span className="leaderboard__rank">{entry.rank}</span>
                    <span className="leaderboard__who">
                      <strong>
                        {entry.username}
                        <TagMarks ids={entry.tags} />
                        {badge && (
                          <span className="leaderboard__badge" title={badge.title}>
                            <BadgeMark badge={badge} />
                          </span>
                        )}
                      </strong>
                      <span>{entry.title}</span>
                    </span>
                    <span className="leaderboard__xp">{entry.experience.toLocaleString("en-US")} XP</span>
                  </li>
                );
              })}
            </ol>
          )}
          {view.board.me ? (
            <p className="leaderboard__note">
              You’re #{view.board.me.rank} with {view.board.me.experience.toLocaleString("en-US")} XP.
            </p>
          ) : you ? (
            <p className="leaderboard__note">You’ll be ranked once you’ve answered a card or closed an incident.</p>
          ) : (
            <p className="leaderboard__note">
              Guests aren’t ranked.{" "}
              <button type="button" className="leaderboard__signup" onClick={onSignUp}>
                Sign up to get on the board
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
