import { useState } from "react";
import type { LocalDate } from "../domain/calendar.ts";
import { ROLE_IDS, type IncidentCard, type Role } from "../domain/incident.ts";
import { hasFinishedShift, liveStreak, type Progress } from "../domain/progress.ts";
import { overallRating } from "../domain/rating.ts";
import { ROLE_INFO } from "../domain/roles.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { WalletChip } from "./WalletChip.tsx";
import { formatCents, SALARY_CENTS_PER_MINUTE } from "../domain/economy.ts";

const VISIBLE_QUEUE = 6;

type Props = {
  progress: Progress;
  today: LocalDate;
  queuedAlerts: readonly IncidentCard["alert"][];
  roles: { chosen: Role | null; counts: Readonly<Record<Role, number>>; onChoose: (role: Role) => void };
  onEnterOffice: () => void;
  team: {
    status: string;
    error: string | null;
    onCreate: (name: string) => void;
    onJoin: (code: string, name: string) => void;
  };
};

const NAME_LIMIT = 24;

/** Start a shared war room or join a teammate's with their 4-letter code. */
function TeamPanel({ team }: { team: Props["team"] }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const trimmed = name.trim();
  const isBusy = team.status === "connecting";
  return (
    <section className="team-lobby" aria-labelledby="team-heading">
      <h2 id="team-heading" className="team-lobby__title">
        Play with your team
      </h2>
      <p className="team-lobby__lede">One outage, everyone in their own role. Infra can’t fix it alone.</p>
      <label className="team-lobby__field">
        <span>Your name</span>
        <input value={name} maxLength={NAME_LIMIT} autoComplete="nickname" onChange={(event) => setName(event.target.value)} placeholder="Maya" />
      </label>
      <div className="team-lobby__row">
        <button type="button" className="button button--ghost" disabled={!trimmed || isBusy} onClick={() => team.onCreate(trimmed)}>
          Create room
        </button>
        <span className="team-lobby__or">or</span>
        <input
          className="team-lobby__code"
          value={code}
          maxLength={4}
          aria-label="Room code"
          placeholder="CODE"
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
        />
        <button type="button" className="button button--ghost" disabled={!trimmed || code.length !== 4 || isBusy} onClick={() => team.onJoin(code, trimmed)}>
          Join
        </button>
      </div>
      <p className="team-lobby__status" role="status">
        {isBusy ? "Connecting to the room server…" : (team.error ?? "")}
      </p>
    </section>
  );
}

function RolePicker({ roles, onPicked }: { roles: Props["roles"]; onPicked?: () => void }) {
  return (
    <fieldset className="roles">
      <legend className="roles__legend">Your role decides which problems page you — and which room is yours.</legend>
      <div className="roles__grid">
        {ROLE_IDS.map((role) => (
          <button
            key={role}
            type="button"
            className="roles__option"
            aria-pressed={roles.chosen === role}
            onClick={() => {
              roles.onChoose(role);
              onPicked?.();
            }}
          >
            <span className="roles__label">{ROLE_INFO[role].label}</span>
            <span className="roles__blurb">{ROLE_INFO[role].blurb}</span>
            <span className="roles__room">
              {ROLE_INFO[role].room} · {roles.counts[role]} problems
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function Briefing({ progress, today, queuedAlerts, roles, onEnterOffice, team }: Props) {
  const [isChangingRole, setChangingRole] = useState(false);
  const streak = liveStreak(progress, today);
  const isDone = hasFinishedShift(progress, today);

  if (roles.chosen === null || isChangingRole) {
    return (
      <main className="briefing briefing--onboarding">
        <header className="briefing__bar">
          <p className="wordmark">sev1</p>
        </header>
        <section className="briefing__main">
          <h1 className="briefing__display">
            Who are you
            <span className="briefing__display-sub">on this team?</span>
          </h1>
          <RolePicker roles={roles} onPicked={() => setChangingRole(false)} />
        </section>
      </main>
    );
  }

  const info = ROLE_INFO[roles.chosen];
  return (
    <main className="briefing">
      <header className="briefing__bar">
        <p className="wordmark">sev1</p>
        <dl className="briefing__stats">
          <div>
            <dt>Streak</dt>
            <dd>{streak} {streak === 1 ? "day" : "days"}</dd>
          </div>
          <div>
            <dt>Rating</dt>
            <dd>{overallRating(progress.ratings)}</dd>
          </div>
          <WalletChip />
        </dl>
      </header>

      {queuedAlerts.length > 0 && (
        <ol className="queue" aria-label="Problems waiting for you">
          {queuedAlerts.slice(0, VISIBLE_QUEUE).map((alert, index) => (
            <li key={index} className="queue__page" data-severity={alert.severity}>
              <span className="queue__time">{alert.firedAt}</span>
              <span className="queue__severity">{alert.severity}</span>
              <span className="queue__service">{alert.service}</span>
            </li>
          ))}
          {queuedAlerts.length > VISIBLE_QUEUE && <li className="queue__more">+{queuedAlerts.length - VISIBLE_QUEUE} more on the screen</li>}
        </ol>
      )}

      <section className="briefing__main">
        <h1 className="briefing__display">
          {info.label}
          <span className="briefing__display-sub">on call today</span>
        </h1>
        <p className="briefing__lede">
          {isDone
            ? `Today’s problems are done. The ${info.room} screen still has practice, and the pager can still go off.`
            : `${queuedAlerts.length} problems wait on the ${info.room} screen. Walk over and talk them through — and keep your laptop close: the pager can go off any time.`}
        </p>
        <p className="briefing__pay">
          The job pays {formatCents(SALARY_CENTS_PER_MINUTE)} for every active minute on the floor, plus a bonus for each correct call and each incident
          you close.
        </p>
        <div className="briefing__actions">
          <button type="button" className="button button--primary briefing__cta" onClick={onEnterOffice}>
            Enter the office
          </button>
          <button type="button" className="button button--quiet" onClick={() => setChangingRole(true)}>
            Change role
          </button>
        </div>
      </section>

      <TeamPanel team={team} />
      <AccountPanel />

      <footer className="briefing__foot">
        <p>Sound on recommended · works on desktop and phones (play sideways).</p>
      </footer>
    </main>
  );
}
