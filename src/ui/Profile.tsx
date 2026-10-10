import { useContext } from "react";
import { AccountContext } from "../app/useAccount.ts";
import { featuredBadge } from "../domain/achievements.ts";
import { careerLevel, passedWarRooms } from "../domain/career.ts";
import { formatCents } from "../domain/economy.ts";
import type { Progress } from "../domain/progress.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { BadgeMark, BadgeShelf } from "./Badges.tsx";
import { CareerLadder } from "./Career.tsx";

type Props = {
  progress: Progress;
  onFeatureBadge: (badgeId: string | null) => void;
};

/** Everything about you: who you are, how far you've come, and what you've earned. */
export function Profile({ progress, onFeatureBadge }: Props) {
  const session = useContext(AccountContext);
  const shown = featuredBadge(progress);
  const career = careerLevel(progress);
  const earnedCents = Object.values(progress.wallet.earnedCents).reduce((sum, cents) => sum + cents, 0);
  const stats = [
    { label: "Correct calls", value: progress.correctCards.toLocaleString("en-US") },
    { label: "Best streak", value: `${progress.bestStreak} ${progress.bestStreak === 1 ? "day" : "days"}` },
    { label: "War Rooms passed", value: String(passedWarRooms(progress).length) },
    { label: "Earned in total", value: formatCents(earnedCents) },
  ];

  return (
    <section className="profile" aria-labelledby="profile-title">
      <header className="profile__head">
        <h1 id="profile-title" className="home__title profile__name">
          <span>{session?.status === "signed-in" ? session.account?.username : "Guest"}</span>
          {shown && (
            <span className="profile__shown">
              <BadgeMark badge={shown} /> {shown.title}
            </span>
          )}
        </h1>
        <p className="profile__title">{career.title}</p>
      </header>

      <div className="profile__account">
        <AccountPanel />
      </div>

      <CareerLadder career={career} />

      <dl className="profile__stats">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>

      <BadgeShelf progress={progress} featured={shown?.id ?? null} onFeature={onFeatureBadge} />
    </section>
  );
}
