import { useContext, useEffect, useState } from "react";
import { AccountContext } from "../app/useAccount.ts";
import { featuredBadge } from "../domain/achievements.ts";
import { ROLE_IDS, type Role } from "../domain/incident.ts";
import type { Progress } from "../domain/progress.ts";
import { ROLE_INFO } from "../domain/roles.ts";
import type { RoomVisibility } from "../multiplayer/protocol.ts";
import { usePublicRooms, type ListPublicRooms } from "../multiplayer/usePublicRooms.ts";
import { useLeaderboard, type FetchLeaderboard } from "../storage/leaderboard-api.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { BadgeMark } from "./Badges.tsx";
import { TagMarks } from "./TagMark.tsx";
import { AdminDashboard } from "./admin/AdminDashboard.tsx";
import { CompanyPage } from "./company/CompanyPage.tsx";
import type { CompanyApi } from "../storage/company-api.ts";
import type { PendingDividend, PendingPayout } from "../storage/company-protocol.ts";
import { isAdmin } from "../domain/tags.ts";
import type { AdminApi } from "../storage/admin-api.ts";
import { LeaderboardPanel } from "./LeaderboardPanel.tsx";
import { Profile } from "./Profile.tsx";
import type { ProSale } from "./ProPanel.tsx";
import { WalletChip } from "./WalletChip.tsx";

type Props = {
  progress: Progress;
  roles: { chosen: Role | null; onChoose: (role: Role) => void };
  onEnterOffice: () => void;
  onFeatureBadge: (badgeId: string | null) => void;
  fetchLeaderboard: FetchLeaderboard;
  proSale: ProSale;
  adminApi: AdminApi;
  company: {
    api: CompanyApi;
    walletCents: number;
    fundCompany: (fundingRef: string, cents: number) => boolean;
    claimPayout: (payout: PendingPayout) => void;
    /** Joins the company's office room at `code`; the app switches to the office once inside. */
    enterOffice: (code: string) => void;
    /** Spends an accepted investment from the wallet; false if the balance is short. */
    invest: (investRef: string, cents: number) => boolean;
    /** Earns a booked dividend into the wallet; claiming twice does nothing. */
    claimDividend: (dividend: PendingDividend) => void;
  };
  rooms: {
    status: string;
    error: string | null;
    onCreate: (name: string, visibility: RoomVisibility) => void;
    onJoin: (code: string, name: string) => void;
    listPublic: ListPublicRooms;
  };
};

const NAME_LIMIT = 24;
const ACCOUNT_PANEL_ID = "account-panel";
/** The profile and the admin dashboard live at their own hashes, so Back returns to the lobby and pages can be linked. */
const PROFILE_HASH = "#profile";
const ADMIN_HASH = "#admin";
const COMPANY_HASH = "#company";

type LobbyView = "home" | "profile" | "admin" | "company";

function useLobbyView(): LobbyView {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return hash === PROFILE_HASH ? "profile" : hash === ADMIN_HASH ? "admin" : hash === COMPANY_HASH ? "company" : "home";
}

/** What sev1 looks like, in the order a shift goes. */
const SCREENS = [
  { src: "/home/wall-screen.webp", width: 760, height: 830, caption: "Problems wait on your role’s wall screen. Read the graph and the logs, make the call." },
  { src: "/home/terminal.webp", width: 1100, height: 700, caption: "When the pager goes off, open your laptop and fix it from a real-feeling shell." },
  { src: "/home/office.webp", width: 1200, height: 675, caption: "Colleagues walk over with news. In a room, your teammates are on the floor with you." },
] as const;

/** The lobby: what the game is, who you are in it, the three ways to start, and the board. Your profile opens in its place. */
export function Briefing({ progress, roles, onEnterOffice, onFeatureBadge, fetchLeaderboard, rooms, proSale, adminApi, company }: Props) {
  const session = useContext(AccountContext);
  const role = roles.chosen ?? "infrastructure";
  // Until the player types, rooms use their account name, which may arrive after the first render.
  const [typedName, setTypedName] = useState<string | null>(null);
  const name = typedName ?? session?.account?.username ?? "";
  const isSignedIn = session?.status === "signed-in";
  // The panel stays open only while the account is as it was when opened, so a successful sign-in folds it away.
  const [openedAs, setOpenedAs] = useState<string | null>(null);
  const isAccountOpen = openedAs !== null && openedAs === session?.status;
  const setAccountOpen = (isOpen: boolean) => setOpenedAs(isOpen ? (session?.status ?? null) : null);
  const shown = featuredBadge(progress);
  const leaderboard = useLeaderboard(fetchLeaderboard, `${session?.status}:${session?.account?.username ?? ""}`);
  const view = useLobbyView();
  const isProfileOpen = view === "profile";
  // Only a link for admins; the server refuses everyone else's dashboard requests regardless.
  const canAdmin = isSignedIn && isAdmin(session?.account?.tags ?? []);

  return (
    <main className="home">
      <header className="home__bar">
        <a className="wordmark home__home-link" href="#" aria-label="sev1, back to the lobby">
          sev1
        </a>
        <div className="home__bar-end">
          <WalletChip />
          <a className="button button--ghost home__account-toggle" href={COMPANY_HASH} aria-current={view === "company" ? "page" : undefined}>
            Company
          </a>
          {canAdmin && (
            <a className="button button--ghost home__account-toggle" href={ADMIN_HASH} aria-current={view === "admin" ? "page" : undefined}>
              Dashboard
            </a>
          )}
          <a className="button button--ghost home__account-toggle" href={PROFILE_HASH} aria-current={isProfileOpen ? "page" : undefined}>
            {isSignedIn ? session?.account?.username : "Profile"}
            {isSignedIn && <TagMarks ids={session?.account?.tags ?? []} />}
            {shown && <BadgeMark badge={shown} />}
          </a>
          {session?.status === "anonymous" && (
            <button
              type="button"
              className="button button--ghost home__account-toggle"
              aria-expanded={isAccountOpen}
              aria-controls={ACCOUNT_PANEL_ID}
              onClick={() => setAccountOpen(!isAccountOpen)}
            >
              Log in / Sign up
            </button>
          )}
        </div>
      </header>

      {isAccountOpen && (
        <div id={ACCOUNT_PANEL_ID} className="home__account-panel">
          <AccountPanel />
        </div>
      )}

      {session?.status === "anonymous" && !isAccountOpen && (
        <p className="home__guest" role="note">
          <span>
            You’re playing as a guest. Your money, level and progress are kept in this browser only, and they’re gone if you clear it or switch device.
          </span>
          <button type="button" className="button button--ghost home__guest-action" aria-controls={ACCOUNT_PANEL_ID} onClick={() => setAccountOpen(true)}>
            Sign up to keep them
          </button>
        </p>
      )}

      {view === "company" ? (
        <CompanyPage
          api={company.api}
          isSignedIn={isSignedIn}
          username={session?.account?.username ?? null}
          walletCents={company.walletCents}
          defaultRole={role}
          fundCompany={company.fundCompany}
          claimPayout={company.claimPayout}
          onSignUp={() => setAccountOpen(true)}
          enterOffice={company.enterOffice}
          invest={company.invest}
          claimDividend={company.claimDividend}
        />
      ) : view === "admin" ? (
        canAdmin ? <AdminDashboard api={adminApi} /> : <p className="admin__note">The dashboard is for admins.</p>
      ) : isProfileOpen ? (
        <Profile progress={progress} onFeatureBadge={onFeatureBadge} proSale={proSale} />
      ) : (
        <>
          <section className="home__intro" aria-labelledby="home-title">
            <div className="home__pitch">
              <h1 id="home-title" className="home__title">
                Production is down.
                <span className="home__title-sub">You’re on call.</span>
              </h1>
              <p className="home__lede">
                sev1 is an on-call simulator. Walk a 3D office, read real-looking alerts, logs and graphs, and fix live outages from a terminal, on your own or with
                your team. You start as an intern and get paid for every minute on the floor.
              </p>
              <RolePicker chosen={role} onChoose={roles.onChoose} />
            </div>
            <figure className="home__shot home__shot--hero">
              <img src="/home/data-centre.webp" width={1600} height={900} alt="The glass-walled data centre: server racks labelled with live pod and database status, colleagues in the office beyond." />
            </figure>
          </section>

          <section className="home__play" aria-labelledby="play-title">
            <h2 id="play-title" className="home__heading">
              Play
            </h2>
            <label className="home__name">
              <span>Your name in rooms</span>
              <input value={name} maxLength={NAME_LIMIT} autoComplete="nickname" placeholder="Maya" onChange={(event) => setTypedName(event.target.value)} />
              <span className="home__name-shows">
                {shown ? (
                  <>
                    Teammates see <BadgeMark badge={shown} /> {shown.title} by your name.
                  </>
                ) : (
                  <>
                    Pick a badge in your <a href={PROFILE_HASH}>profile</a> to show it by your name.
                  </>
                )}
              </span>
            </label>
            <div className="home__modes">
              <article className="mode">
                <h3 className="mode__title">Solo</h3>
                <p className="mode__body">
                  Take today’s problems at the {ROLE_INFO[role].room} screen and wait for the pager. Colleagues cover the other roles.
                </p>
                <button type="button" className="button button--primary mode__action" onClick={onEnterOffice}>
                  Enter the office
                </button>
              </article>
              <HostRoom name={name.trim()} rooms={rooms} />
              <JoinRoom name={name.trim()} rooms={rooms} />
            </div>
            <p className="home__status" role="status">
              {rooms.status === "connecting" ? "Connecting to the room…" : (rooms.error ?? "")}
            </p>
          </section>

          <LeaderboardPanel view={leaderboard} you={isSignedIn ? (session?.account?.username ?? null) : null} onSignUp={() => setAccountOpen(true)} />

          <section className="home__how" aria-labelledby="how-title">
            <h2 id="how-title" className="home__heading">
              How a shift goes
            </h2>
            <ol className="home__screens">
              {SCREENS.map((screen) => (
                <li key={screen.src}>
                  <figure className="home__shot">
                    <img src={screen.src} width={screen.width} height={screen.height} alt="" loading="lazy" />
                    <figcaption>{screen.caption}</figcaption>
                  </figure>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      <footer className="home__foot">
        <p>Sound on recommended. Works on desktop and on phones held sideways.</p>
      </footer>
    </main>
  );
}

function RolePicker({ chosen, onChoose }: { chosen: Role; onChoose: (role: Role) => void }) {
  return (
    <fieldset className="role-picker">
      <legend className="role-picker__legend">Your role</legend>
      <div className="role-picker__options">
        {ROLE_IDS.map((role) => (
          <label key={role} className="role-picker__option">
            <input type="radio" name="role" value={role} checked={chosen === role} onChange={() => onChoose(role)} />
            <span>{ROLE_INFO[role].label}</span>
          </label>
        ))}
      </div>
      <p className="role-picker__blurb">{ROLE_INFO[chosen].blurb}</p>
    </fieldset>
  );
}

function HostRoom({ name, rooms }: { name: string; rooms: Props["rooms"] }) {
  const [visibility, setVisibility] = useState<RoomVisibility>("private");
  const isBusy = rooms.status === "connecting";
  return (
    <article className="mode">
      <h3 className="mode__title">Host a room</h3>
      <p className="mode__body">One outage for up to five people, each in their own role. Nobody can fix it alone.</p>
      <div className="mode__choice" role="radiogroup" aria-label="Who can join">
        <label className="mode__choice-option">
          <input type="radio" name="visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />
          <span>
            <strong>Private</strong> · invite with the code
          </span>
        </label>
        <label className="mode__choice-option">
          <input type="radio" name="visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} />
          <span>
            <strong>Public</strong> · anyone can join
          </span>
        </label>
      </div>
      <button type="button" className="button button--ghost mode__action" disabled={!name || isBusy} onClick={() => rooms.onCreate(name, visibility)}>
        Create room
      </button>
      {!name && <p className="mode__hint">Add your name above first.</p>}
    </article>
  );
}

function JoinRoom({ name, rooms }: { name: string; rooms: Props["rooms"] }) {
  const [code, setCode] = useState("");
  const publicRooms = usePublicRooms(rooms.listPublic, true);
  const isBusy = rooms.status === "connecting";
  const canJoin = Boolean(name) && !isBusy;
  return (
    <article className="mode">
      <h3 className="mode__title">Join a room</h3>
      <div className="mode__list" aria-live="polite">
        {publicRooms.status === "loading" && <p className="mode__body">Looking for open rooms…</p>}
        {publicRooms.status === "unavailable" && <p className="mode__body">Can’t reach the room list right now. A code still works.</p>}
        {publicRooms.status === "ready" && publicRooms.rooms.length === 0 && <p className="mode__body">No public rooms open. Host one, or ask a friend for their code.</p>}
        {publicRooms.status === "ready" && publicRooms.rooms.length > 0 && (
          <ul className="open-rooms">
            {publicRooms.rooms.map((room) => (
              <li key={room.code} className="open-rooms__row">
                <span className="open-rooms__who">
                  <strong>{room.host}’s room</strong>
                  <span>
                    {room.scenarioTitle} · {room.players}/{room.maxPlayers}
                  </span>
                </span>
                <button type="button" className="button button--ghost open-rooms__join" disabled={!canJoin} onClick={() => rooms.onJoin(room.code, name)}>
                  Join
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mode__code">
        <input
          value={code}
          maxLength={4}
          aria-label="Room code"
          placeholder="CODE"
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
        />
        <button type="button" className="button button--ghost" disabled={!canJoin || code.length !== 4} onClick={() => rooms.onJoin(code, name)}>
          Join with code
        </button>
      </div>
      {!name && <p className="mode__hint">Add your name above first.</p>}
    </article>
  );
}
