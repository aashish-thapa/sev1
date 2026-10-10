import { useEffect } from "react";
import { Briefing } from "../ui/Briefing.tsx";
import { DiscussionOverlay } from "../ui/DiscussionOverlay.tsx";
import { findScenario, soloScenarioFor, TEAM_SCENARIO } from "../warroom/scenarios/index.ts";
import { preloadFloor } from "../warroom/ui/floorLoader.ts";
import { WarRoomView } from "../warroom/ui/WarRoomView.tsx";
import { useRoom } from "../multiplayer/useRoom.ts";
import { PayoutToast } from "../ui/PayoutToast.tsx";
import { useActivityClock } from "./useActivityClock.ts";
import { useShiftGame, type GameServices } from "./useShiftGame.ts";
import { WalletContext } from "./wallet-context.ts";

/** Rooms share the app's origin (the dev server proxies /rooms to the room server). */
function roomUrl(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rooms`;
}

type Props = GameServices & { readonly shareUrl: string };

export function App({ shareUrl, ...services }: Props) {
  const game = useShiftGame(services);
  const room = useRoom({ url: roomUrl() });
  const role = game.progress.role ?? "infrastructure";
  const isInRoom = room.room !== null && room.status !== "left" && room.status !== "failed";
  // Solo infra gets the pure infra outage; other roles and every team room get the cross-team meltdown.
  const scenario = isInRoom ? (findScenario(room.room?.scenarioId ?? "") ?? TEAM_SCENARIO) : soloScenarioFor(role);

  // Fetch the 3D office while the player is still in the lobby.
  useEffect(preloadFloor, []);

  const isInOffice = game.screen.name === "office" || isInRoom;
  // Salary is for time on the floor; the lobby is the walk to work.
  useActivityClock(isInOffice, game.paySalary);

  const overlay = game.discussion ? (
    <DiscussionOverlay
      discussion={game.discussion}
      progress={game.progress}
      shareUrl={shareUrl}
      onAnswer={game.answer}
      onWrapUp={game.wrapUpDiscussion}
      onClose={game.closeDiscussion}
    />
  ) : null;

  return (
    <WalletContext value={game.progress.wallet}>
      {isInOffice ? (
        <>
          <WarRoomView
            key={`${scenario.id}:${isInRoom ? room.room?.code : "solo"}`}
            scenario={scenario}
            role={role}
            onFinish={(result, startedAt) => game.recordWarRoom(scenario, result, { isTeam: isInRoom, startedAt })}
            onLeave={() => {
              if (isInRoom) room.leave();
              game.leaveOffice();
            }}
            room={isInRoom ? room : undefined}
            onUseScreen={(screen) => game.openDiscussion(screen.role)}
            onPaged={game.closeDiscussion}
            overlay={overlay}
          />
          <PayoutToast />
        </>
      ) : (
        <Briefing
          progress={game.progress}
          today={game.today}
          queuedAlerts={game.queuedAlerts}
          roles={{ chosen: game.progress.role, counts: game.roleCounts, onChoose: game.chooseRole }}
          onEnterOffice={game.enterOffice}
          team={{
            status: room.status,
            error: room.error?.message ?? null,
            onCreate: (name) => room.create(TEAM_SCENARIO.id, name, role),
            onJoin: (code, name) => room.join(code, name, role),
          }}
        />
      )}
    </WalletContext>
  );
}
