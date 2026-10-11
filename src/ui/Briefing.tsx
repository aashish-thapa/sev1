import { lazy, Suspense, useContext, useEffect, useState } from "react";
import { careerLevel } from "../domain/career.ts";
import { CharacterPicker, LobbyRail, ModeCard, PlayerCard, TopRanks, type RoomActions } from "./lobby/LobbyParts.tsx";
import { useLook } from "../app/look-context.ts";
import type { Look } from "../domain/look.ts";
import { wornAvatar } from "../warroom/floor/people/avatars.ts";
import { loadLobbyScene } from "./lobby/lobbySceneLoader.ts";
import { LOBBY_BACKDROP } from "./lobby/backdrop.ts";

const LobbyScene = lazy(loadLobbyScene);
const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
import { AccountContext } from "../app/useAccount.ts";
import { featuredBadge } from "../domain/achievements.ts";
import type { Role } from "../domain/incident.ts";
import type { Progress } from "../domain/progress.ts";
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
    /** Joins a company's office for an investment meeting, as member or visitor. */
    enterMeeting: (code: string, companyId: string) => void;
  };
  /** Saves the body and pose you chose to wear. */
  onChooseLook: (look: Look) => void;
  rooms: RoomActions;
};

const ACCOUNT_PANEL_ID = "account-panel";
/** The profile and the admin dashboard live at their own hashes, so Back returns to the lobby and pages can be linked. */
const PROFILE_HASH = "#profile";
const ADMIN_HASH = "#admin";
const COMPANY_HASH = "#company";
const RANKS_HASH = "#ranks";
const CHARACTER_HASH = "#character";

type LobbyView = "home" | "character" | "profile" | "admin" | "company" | "ranks";

function useLobbyView(): LobbyView {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return hash === PROFILE_HASH ? "profile" : hash === ADMIN_HASH ? "admin" : hash === COMPANY_HASH ? "company" : hash === RANKS_HASH ? "ranks" : hash === CHARACTER_HASH ? "character" : "home";
}


/** The lobby: what the game is, who you are in it, the three ways to start, and the board. Your profile opens in its place. */
export function Briefing({ progress, roles, onEnterOffice, onFeatureBadge, onChooseLook, fetchLeaderboard, rooms, proSale, adminApi, company }: Props) {
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
  // Only a link for admins; the server refuses everyone else's dashboard requests regardless.
  const canAdmin = isSignedIn && isAdmin(session?.account?.tags ?? []);

  const experience = careerLevel(progress).experience;
  const playerName = isSignedIn ? (session?.account?.username ?? "") : name;
  const look = useLook();
  const worn = { avatar: wornAvatar(look.avatar, playerName || "guest"), pose: look.pose };
  // What you're trying on in the wardrobe; null until you change something, so it follows what you wear.
  const [tryingOn, setTryingOn] = useState<typeof worn | null>(null);
  const shownLook = view === "character" ? (tryingOn ?? worn) : worn;
  const rail = [
    { href: "#", label: "Play", isCurrent: view === "home" },
    { href: CHARACTER_HASH, label: "Character", isCurrent: view === "character" },
    { href: PROFILE_HASH, label: "Career", isCurrent: view === "profile" },
    { href: COMPANY_HASH, label: "Company", isCurrent: view === "company" },
    { href: RANKS_HASH, label: "Ranks", isCurrent: view === "ranks" },
    ...(canAdmin ? [{ href: ADMIN_HASH, label: "Dashboard", isCurrent: view === "admin" }] : []),
  ];

  return (
    <main className="lobby" data-view={view}>
      <div className="lobby__stage" aria-hidden="true">
        <img className="lobby__backdrop" src={LOBBY_BACKDROP} alt="" />
        <Suspense fallback={null}>
          <LobbyScene avatar={shownLook.avatar} pose={shownLook.pose} isAside={view !== "home" && view !== "character"} reduceMotion={reduceMotion} />
        </Suspense>
      </div>

      <header className="lobby__top">
        <PlayerCard
          name={isSignedIn ? (session?.account?.username ?? "") : "Guest"}
          marks={
            <>
              {isSignedIn && <TagMarks ids={session?.account?.tags ?? []} />}
              {shown && <BadgeMark badge={shown} />}
            </>
          }
          experience={experience}
          href={PROFILE_HASH}
        />
        <div className="lobby__top-end">
          <WalletChip />
          {session?.status === "anonymous" && (
            <button type="button" className="button button--ghost" aria-expanded={isAccountOpen} aria-controls={ACCOUNT_PANEL_ID} onClick={() => setAccountOpen(!isAccountOpen)}>
              Log in
            </button>
          )}
        </div>
      </header>

      <LobbyRail items={rail} />

      {isAccountOpen && (
        <div id={ACCOUNT_PANEL_ID} className="lobby__account">
          <AccountPanel />
        </div>
      )}

      {view === "home" ? (
        <>
          {session?.status === "anonymous" && !isAccountOpen && (
            <button type="button" className="lobby__guest" aria-controls={ACCOUNT_PANEL_ID} onClick={() => setAccountOpen(true)}>
              Guest: progress stays on this device. <strong>Sign up to keep it</strong>
            </button>
          )}
          <TopRanks view={leaderboard} href={RANKS_HASH} />
          <ModeCard role={role} onRole={roles.onChoose} name={name.trim()} onName={isSignedIn ? null : setTypedName} onSolo={onEnterOffice} rooms={rooms} />
        </>
      ) : view === "character" ? (
        <CharacterPicker
          draft={shownLook}
          onDraft={setTryingOn}
          isWorn={look.avatar === shownLook.avatar && look.pose === shownLook.pose}
          onWear={() => {
            onChooseLook({ avatar: shownLook.avatar, pose: shownLook.pose });
            setTryingOn(null);
          }}
        />
      ) : (
        <section className="lobby__panel">
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
              enterMeeting={company.enterMeeting}
            />
          ) : view === "admin" ? (
            canAdmin ? <AdminDashboard api={adminApi} /> : <p className="admin__note">The dashboard is for admins.</p>
          ) : view === "ranks" ? (
            <LeaderboardPanel view={leaderboard} you={isSignedIn ? (session?.account?.username ?? null) : null} onSignUp={() => setAccountOpen(true)} />
          ) : (
            <Profile progress={progress} onFeatureBadge={onFeatureBadge} proSale={proSale} />
          )}
        </section>
      )}
    </main>
  );
}

