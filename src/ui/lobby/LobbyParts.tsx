import { useState, type ReactNode } from "react";
import { careerAt } from "../../domain/career.ts";
import { ROLE_IDS, type Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import { ROOM_MODES, type RoomMode, type RoomVisibility } from "../../multiplayer/protocol.ts";
import { usePublicRooms, type ListPublicRooms } from "../../multiplayer/usePublicRooms.ts";
import type { LeaderboardView } from "../../storage/leaderboard-api.ts";
import { AVATAR_COUNT, avatarNumber, POSES, stepAvatar, type Pose } from "../../domain/look.ts";
import type { AvatarId } from "../../warroom/floor/assets/catalog.ts";

/** Who you are, top left: name, marks, rank and how far to the next promotion. */
export function PlayerCard({ name, marks, experience, href }: { name: string; marks: ReactNode; experience: number; href: string }) {
  const career = careerAt(experience);
  const span = career.nextAt === null ? 1 : career.nextAt - career.levelStartsAt;
  const toNext = career.nextAt === null ? 1 : (experience - career.levelStartsAt) / span;
  return (
    <a className="player-card" href={href}>
      <span className="player-card__level" aria-hidden="true">
        {career.level + 1}
      </span>
      <span className="player-card__who">
        <span className="player-card__name">
          {name} {marks}
        </span>
        <span className="player-card__title">{career.title}</span>
        <span
          className="player-card__xp"
          role="progressbar"
          aria-label={career.nextAt === null ? "Top rank" : `Experience to the next rank`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(toNext * 100)}
        >
          <span style={{ inlineSize: `${Math.round(toNext * 100)}%` }} />
        </span>
      </span>
    </a>
  );
}

export type LobbyRailItem = { readonly href: string; readonly label: string; readonly isCurrent: boolean };

/** The menu down the left edge, as in a game's lobby. */
export function LobbyRail({ items }: { items: readonly LobbyRailItem[] }) {
  return (
    <nav className="lobby-rail" aria-label="Lobby">
      {items.map((item) => (
        <a key={item.href} className="lobby-rail__item" href={item.href} aria-current={item.isCurrent ? "page" : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/** The top three, at a glance; the full board is a click away. */
export function TopRanks({ view, href }: { view: LeaderboardView; href: string }) {
  if (view.status !== "ready" || view.board.entries.length === 0) return null;
  return (
    <a className="top-ranks" href={href} aria-label="Top players: open the full board">
      <span className="top-ranks__title">Top on call</span>
      <ol>
        {view.board.entries.slice(0, 3).map((entry) => (
          <li key={entry.username}>
            <span className="top-ranks__rank">{entry.rank}</span>
            <span className="top-ranks__name">{entry.username}</span>
            <span className="top-ranks__xp">{entry.experience.toLocaleString("en-US")}</span>
          </li>
        ))}
      </ol>
    </a>
  );
}

type Mode = "solo" | "host" | "join";

/** Solo is your own shift, or a race against one random opponent (a bot crew when nobody's around). */
type SoloKind = "shift" | "random";

/** What the lobby can do with rooms: host one, join one, and list the open ones. */
export type RoomActions = {
  status: string;
  error: string | null;
  onCreate: (name: string, visibility: RoomVisibility, scenarioId: string, format: RoomMode) => void;
  onJoin: (code: string, name: string) => void;
  /** Starts a random 1v1: a matchmade room on an incident picked for this player, searching at once. */
  onFindOpponent: (name: string) => void;
  listPublic: ListPublicRooms;
};

type ModeCardProps = {
  role: Role;
  onRole: (role: Role) => void;
  /** Rooms show this; a guest types it. */
  name: string;
  onName: ((name: string) => void) | null;
  onSolo: () => void;
  /** What a room this player hosts may play: their unlocked War Rooms and the cross-team incident. */
  incidents: readonly { readonly id: string; readonly title: string; readonly tier: number }[];
  rooms: RoomActions;
};

/** Bottom right: pick a role and a way to play, then START. */
export function ModeCard({ role, onRole, name, onName, onSolo, incidents, rooms }: ModeCardProps) {
  const [mode, setMode] = useState<Mode>("solo");
  const [soloKind, setSoloKind] = useState<SoloKind>("shift");
  const [visibility, setVisibility] = useState<RoomVisibility>("private");
  const [format, setFormat] = useState<RoomMode>("coop");
  // The list follows role and level, so a pick it no longer holds falls back to the first: the cross-team incident.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const incident = incidents.find((candidate) => candidate.id === pickedId) ?? incidents[0];
  const [code, setCode] = useState("");
  const publicRooms = usePublicRooms(rooms.listPublic, mode === "join");
  const isBusy = rooms.status === "connecting";
  const isRoomBound = mode !== "solo" || soloKind === "random";
  const needsName = isRoomBound && !name;

  const start = () => {
    if (mode === "solo" && soloKind === "shift") onSolo();
    else if (mode === "solo") rooms.onFindOpponent(name);
    // Matchmade rooms are never listed, so only the code brings friends in.
    else if (mode === "host") rooms.onCreate(name, format === "matchmade" ? "private" : visibility, incident.id, format);
    else if (code.length === 4) rooms.onJoin(code, name);
  };
  const canStart = !isBusy && !needsName && (mode !== "join" || code.length === 4);

  return (
    <section className="mode-card" aria-label="Play">
      <div className="mode-card__roles" role="radiogroup" aria-label="Your role">
        {ROLE_IDS.map((option) => (
          <button key={option} type="button" role="radio" aria-checked={option === role} className="mode-card__role" onClick={() => onRole(option)}>
            {ROLE_INFO[option].label}
          </button>
        ))}
      </div>

      <div className="mode-card__modes" role="tablist" aria-label="How to play">
        {(["solo", "host", "join"] as const).map((option) => (
          <button key={option} type="button" role="tab" aria-selected={mode === option} className="mode-card__mode" onClick={() => setMode(option)}>
            {option === "solo" ? "Solo" : option === "host" ? "Squad" : "Join"}
          </button>
        ))}
      </div>

      <div className="mode-card__detail">
        {mode === "solo" && (
          <div className="mode-card__choice" role="radiogroup" aria-label="Solo play">
            {(["shift", "random"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={soloKind === option} className="mode-card__pill" onClick={() => setSoloKind(option)}>
                {option === "shift" ? "Shift" : "Random 1v1"}
              </button>
            ))}
          </div>
        )}
        {mode === "solo" && <p>{soloKind === "shift" ? "Your shift, colleagues on the other roles." : "Race a random opponent on the same incident, or a bot crew if nobody's around."}</p>}
        {mode === "host" && (
          <div className="mode-card__choice" role="radiogroup" aria-label="Incident">
            {incidents.map((candidate) => (
              <button key={candidate.id} type="button" role="radio" aria-checked={candidate === incident} className="mode-card__pill" onClick={() => setPickedId(candidate.id)}>
                {candidate.title} · tier {candidate.tier}
              </button>
            ))}
          </div>
        )}
        {mode === "host" && (
          <div className="mode-card__choice" role="radiogroup" aria-label="Format">
            {ROOM_MODES.map((option) => (
              <button key={option} type="button" role="radio" aria-checked={format === option} className="mode-card__pill" onClick={() => setFormat(option)}>
                {FORMAT_LABEL[option]}
              </button>
            ))}
          </div>
        )}
        {mode === "host" && format !== "matchmade" && (
          <div className="mode-card__choice" role="radiogroup" aria-label="Who can join">
            {(["private", "public"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={visibility === option} className="mode-card__pill" onClick={() => setVisibility(option)}>
                {option === "private" ? "Invite only" : "Open to anyone"}
              </button>
            ))}
          </div>
        )}
        {mode === "join" && (
          <>
            <input
              className="mode-card__code"
              value={code}
              maxLength={4}
              aria-label="Room code"
              placeholder="CODE"
              autoCapitalize="characters"
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
            />
            {publicRooms.status === "ready" && publicRooms.rooms.length > 0 && (
              <ul className="mode-card__rooms">
                {publicRooms.rooms.slice(0, 4).map((room) => (
                  <li key={room.code}>
                    <button type="button" className="mode-card__room" aria-pressed={code === room.code} onClick={() => setCode(room.code)}>
                      <span>
                        {room.host}
                        {room.mode === "versus" && <span className="mode-card__versus"> Versus</span>}
                      </span>
                      <span className="admin__dim">
                        {room.players}/{room.maxPlayers}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {onName && isRoomBound && (
          <input className="mode-card__name" value={name} maxLength={24} autoComplete="nickname" placeholder="Your name" aria-label="Your name in rooms" onChange={(event) => onName(event.target.value)} />
        )}
      </div>

      <button type="button" className="mode-card__start" disabled={!canStart} onClick={start}>
        {isBusy ? "Connecting…" : mode === "join" ? "Join" : "Start"}
      </button>
      {rooms.error && (
        <p className="mode-card__error" role="status">
          {rooms.error}
        </p>
      )}
    </section>
  );
}

/** The wardrobe: step through bodies on the stage, pick a pose, and wear it. */
export function CharacterPicker({
  draft,
  onDraft,
  isWorn,
  onWear,
}: {
  draft: { readonly avatar: AvatarId; readonly pose: Pose };
  onDraft: (draft: { avatar: AvatarId; pose: Pose }) => void;
  /** The draft is already what you wear. */
  isWorn: boolean;
  onWear: () => void;
}) {
  return (
    <section className="wardrobe" aria-label="Your character">
      <div className="wardrobe__step">
        <button type="button" className="wardrobe__arrow" aria-label="Previous body" onClick={() => onDraft({ ...draft, avatar: stepAvatar(draft.avatar, -1) })}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="wardrobe__count" aria-live="polite">
          {avatarNumber(draft.avatar)} / {AVATAR_COUNT}
        </span>
        <button type="button" className="wardrobe__arrow" aria-label="Next body" onClick={() => onDraft({ ...draft, avatar: stepAvatar(draft.avatar, 1) })}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="mode-card__choice" role="radiogroup" aria-label="Lobby pose">
        {POSES.map((pose) => (
          <button key={pose} type="button" role="radio" aria-checked={draft.pose === pose} className="mode-card__pill" onClick={() => onDraft({ ...draft, pose })}>
            {POSE_LABEL[pose]}
          </button>
        ))}
      </div>
      <button type="button" className="mode-card__start" disabled={isWorn} onClick={onWear}>
        {isWorn ? "Wearing" : "Wear this"}
      </button>
    </section>
  );
}

const FORMAT_LABEL: Readonly<Record<RoomMode, string>> = { coop: "Co-op", versus: "Versus by code", matchmade: "Random opponents" };

const POSE_LABEL: Readonly<Record<Pose, string>> = { idle: "Standing", phone: "On the phone", talk: "Talking" };
