import { useMemo } from "react";
import type { Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { useRoom } from "../../multiplayer/useRoom.ts";
import type { WallScreen } from "../floor/office.ts";
import type { Incident } from "../incident.ts";
import type { Scenario } from "../scenario.ts";
import { completeLine } from "../shell/shell.ts";
import { laptopBanner } from "./laptop-identity.ts";
import type { IncidentFeed } from "./feed.ts";
import { LiveIncident, type TeamContext } from "./LiveIncident.tsx";

type Props = {
  room: ReturnType<typeof useRoom>;
  scenario: Scenario;
  role: Role;
  overlay: React.ReactNode;
  onUseScreen: (screen: WallScreen) => void;
  onClosed: (incident: Incident) => void;
  onLeave: () => void;
};

/** The office when the incident lives on the room server and teammates share it. */
export function TeamIncident({ room, scenario, role, overlay, onUseScreen, onClosed, onLeave }: Props) {
  const me = room.room?.playerId;
  const team = useMemo<TeamContext | null>(() => {
    if (!room.room) return null;
    return {
      code: room.room.code,
      selfId: room.room.playerId,
      teammates: room.players
        .filter((player) => player.id !== me && player.isConnected)
        .map((player) => ({ id: player.id, name: player.name, roleLabel: ROLE_INFO[player.role].label, position: player.position })),
      activity: room.activity.map((item, index) => ({
        key: `${item.at}-${item.playerId}-${index}`,
        text: `${item.name} (${ROLE_INFO[item.role].label}) ran ${item.line}`,
        isChange: item.didChangeCluster,
      })),
      onPresence: room.sendPresence,
    };
  }, [me, room.activity, room.players, room.room, room.sendPresence]);

  if (!room.incident || !team) {
    return (
      <main className="paged">
        <p className="paged__source">Room {room.room?.code ?? "…"}</p>
        <h1 className="paged__title">Joining the bridge…</h1>
        <p className="paged__brief">{room.status === "reconnecting" ? "Lost the connection — reconnecting." : "Syncing the incident with your team."}</p>
      </main>
    );
  }

  const incident = room.incident;
  // The room starts every laptop empty; greet the player with their role's briefing like solo does.
  const banner = laptopBanner(scenario, role).map((text, index) => ({ id: -1000 + index, text, tone: "dim" as const }));
  const feed: IncidentFeed = {
    incident,
    terminal: [...banner, ...room.terminal],
    history: room.history,
    comms: room.comms,
    run: room.run,
    declare: room.declare,
    complete: (line) => completeLine(line, { cluster: incident.cluster, scenario, history: room.history, role }),
  };

  return (
    <LiveIncident
      scenario={scenario}
      role={role}
      isPaged
      onPage={() => {}}
      onClosed={onClosed}
      onLeave={onLeave}
      onUseScreen={onUseScreen}
      overlay={overlay}
      feed={feed}
      team={team}
    />
  );
}
