import { useEffect, useState } from "react";
import { formatCents } from "../../domain/economy.ts";
import type { AdminStats } from "../../storage/admin-protocol.ts";
import type { AdminApi, AdminRead } from "../../storage/admin-api.ts";
import { findScenario } from "../../warroom/scenarios/index.ts";
import { LevelBars, SignupsChart } from "./charts.tsx";
import { UserSearch } from "./UserSearch.tsx";

type Props = { api: AdminApi };

/** What's going on in sev1, for accounts tagged admin. Read-only; the server checks the tag on every request. */
export function AdminDashboard({ api }: Props) {
  const [stats, setStats] = useState<AdminRead<AdminStats> | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.stats(controller.signal).then(setStats, () => undefined);
    return () => controller.abort();
  }, [api, refreshes]);

  if (!stats) return <p className="admin__note">Loading the numbers…</p>;
  if (!stats.ok) {
    return (
      <p className="admin__note">
        {stats.problem === "forbidden" ? "This account can’t open the dashboard." : "Couldn’t reach the dashboard’s data. Try again in a moment."}
      </p>
    );
  }
  const data = stats.value;
  const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);

  return (
    <section className="admin" aria-labelledby="admin-title">
      <header className="admin__head">
        <h1 id="admin-title" className="home__title admin__title">
          Dashboard
        </h1>
        <p className="admin__meta">
          As of {new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} ·{" "}
          <button type="button" className="admin__refresh" onClick={() => setRefreshes((count) => count + 1)}>
            Refresh
          </button>
        </p>
        <p className="admin__note">Counts are accounts only: guests keep their progress in their own browser, so the server never sees them.</p>
      </header>

      <dl className="admin__tiles">
        <Tile label="Accounts" value={data.accounts.total} />
        <Tile label="New today" value={data.accounts.newToday} />
        <Tile label="New, 7 days" value={data.accounts.new7d} />
        <Tile label="Active today" value={data.activity.active1d} />
        <Tile label="Active, 7 days" value={data.activity.active7d} />
        <Tile label="Public rooms live" value={data.rooms.publicLive} />
      </dl>

      <div className="admin__grid">
        <section className="admin__panel" aria-labelledby="signups-title">
          <h2 id="signups-title" className="admin__heading">
            Signups, last 30 days
          </h2>
          <SignupsChart days={data.accounts.signupsByDay} />
        </section>
        <section className="admin__panel" aria-labelledby="levels-title">
          <h2 id="levels-title" className="admin__heading">
            Career levels
          </h2>
          <LevelBars levels={data.levels} />
        </section>
      </div>

      <section className="admin__panel" aria-labelledby="warrooms-title">
        <h2 id="warrooms-title" className="admin__heading">
          War Rooms
        </h2>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Incident</th>
              <th scope="col">Players</th>
              <th scope="col">Plays</th>
              <th scope="col">Passed</th>
              <th scope="col">Grade S</th>
            </tr>
          </thead>
          <tbody>
            {data.warRooms.map((room) => (
              <tr key={room.scenarioId}>
                <th scope="row">{findScenario(room.scenarioId)?.title ?? room.scenarioId}</th>
                <td>{room.players}</td>
                <td>{room.plays}</td>
                <td>
                  {room.passed} <span className="admin__dim">({pct(room.passed, room.players)})</span>
                </td>
                <td>{room.sGrades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="admin__grid">
        <section className="admin__panel" aria-labelledby="economy-title">
          <h2 id="economy-title" className="admin__heading">
            Economy and Pro
          </h2>
          <dl className="admin__tiles admin__tiles--compact">
            <Tile label="Earned in game" value={formatCents(data.economy.earnedCentsTotal)} />
            <Tile label="From salary" value={formatCents(data.economy.byReason.salary)} />
            <Tile label="From calls" value={formatCents(data.economy.byReason.card)} />
            <Tile label="From incidents" value={formatCents(data.economy.byReason.incident)} />
            <Tile label="Solutions bought" value={data.economy.solutionsBought} />
            <Tile label="Correct calls" value={data.cards.correctTotal} />
            <Tile label="Pro now" value={data.pro.active} />
            <Tile label="Pro ever" value={data.pro.everSubscribed} />
          </dl>
        </section>
        <section className="admin__panel" aria-labelledby="top-title">
          <h2 id="top-title" className="admin__heading">
            Top players
          </h2>
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">Level</th>
                <th scope="col">XP</th>
              </tr>
            </thead>
            <tbody>
              {data.topPlayers.map((player) => (
                <tr key={player.username}>
                  <td>{player.rank}</td>
                  <th scope="row">{player.username}</th>
                  <td>{player.title}</td>
                  <td>{player.experience.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <UserSearch api={api} />
    </section>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="admin__tile">
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? value.toLocaleString("en-US") : value}</dd>
    </div>
  );
}
