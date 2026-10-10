import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { careerLevel } from "../domain/career.ts";
import { warRoomPlays } from "../domain/progress.ts";
import { Briefing } from "../ui/Briefing.tsx";
import { OfficeErrorBoundary } from "../ui/OfficeErrorBoundary.tsx";
import type { ProSale } from "../ui/ProPanel.tsx";
import type { AdminApi } from "../storage/admin-api.ts";
import type { CompanyApi } from "../storage/company-api.ts";
import { DiscussionOverlay } from "../ui/DiscussionOverlay.tsx";
import { findScenario, soloScenarioFor, TEAM_SCENARIO } from "../warroom/scenarios/index.ts";
import { preloadFloor } from "../warroom/ui/floorLoader.ts";
import { WarRoomView } from "../warroom/ui/WarRoomView.tsx";
import { useRoom } from "../multiplayer/useRoom.ts";
import { fetchPublicRooms } from "../multiplayer/usePublicRooms.ts";
import { fetchLeaderboard } from "../storage/leaderboard-api.ts";
import { featuredBadge } from "../domain/achievements.ts";
import { PayoutToast } from "../ui/PayoutToast.tsx";
import { PromotionToast } from "../ui/PromotionToast.tsx";
import { CareerContext } from "./career-context.ts";
import { useActivityClock } from "./useActivityClock.ts";
import { useShiftGame, type GameServices } from "./useShiftGame.ts";
import { WalletContext } from "./wallet-context.ts";
import { AccountContext } from "./useAccount.ts";
import { CompanyOfficeContext } from "../warroom/floor/company-office/context.ts";
import { LaptopAppsContext } from "../warroom/ui/laptop-apps.ts";
import { useCompanyLaptopApps } from "../ui/company/desk/useCompanyLaptopApps.tsx";
import type { Company } from "../storage/company-protocol.ts";
import { useClaimGrants } from "./useClaimGrants.ts";
import { WellbeingContext } from "./wellbeing-context.ts";

/** Rooms share the app's origin (the dev server proxies /rooms to the room server). */
function roomUrl(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rooms`;
}

type Props = GameServices & {
  readonly shareUrl: string;
  readonly proSale: ProSale;
  readonly adminApi: AdminApi;
  readonly companyApi: CompanyApi;
};

export function App({ shareUrl, proSale, adminApi, companyApi, ...services }: Props) {
  const game = useShiftGame(services);
  useClaimGrants(useContext(AccountContext)?.pendingGrants, game.progress.wallet, game.claimGrant);
  const room = useRoom({ url: roomUrl() });
  const username = useContext(AccountContext)?.account?.username ?? null;
  const role = game.progress.role ?? "infrastructure";
  const isInRoom = room.room !== null && room.status !== "left" && room.status !== "failed";
  // Solo infra rotates through the pure infra outages; other roles and every team room get the cross-team meltdown.
  const career = useMemo(() => careerLevel(game.progress), [game.progress]);
  const wellbeing = useMemo(
    () => ({ wellbeing: game.progress.wellbeing, takeFromPantry: game.takeFromPantry, consume: game.consume }),
    [game.consume, game.progress.wellbeing, game.takeFromPantry],
  );
  const scenario = isInRoom ? (findScenario(room.room?.scenarioId ?? "") ?? TEAM_SCENARIO) : soloScenarioFor(role, warRoomPlays(game.progress), career.level);

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

  // Rooms show it by your name; only an earned badge is ever sent.
  const badge = featuredBadge(game.progress)?.id ?? null;
  // The company whose office room you walked into from the HQ: its floor shows only what it bought.
  const [companyOffice, setCompanyOffice] = useState<{ readonly code: string; readonly company: Company } | null>(null);
  const enterCompanyOffice = useCallback(
    async (code: string) => {
      // Know the office's layout before stepping in, so you start at your desk, not behind a shut door.
      const mine = await companyApi.mine();
      const company = mine.ok ? mine.value.company : null;
      if (company) setCompanyOffice({ code, company });
      // In the office you're who the company hired you as, not your lobby role.
      const companyRole = company?.members.find((member) => member.username === username)?.role ?? role;
      room.join(code, { name: username ?? "", role: companyRole, badge });
    },
    [badge, companyApi, role, room, username],
  );
  const officeVisit = useMemo(
    () => (companyOffice && isInRoom && room.room?.code === companyOffice.code ? { company: companyOffice.company, me: username } : null),
    [companyOffice, isInRoom, room.room?.code, username],
  );

  const companyApps = useCompanyLaptopApps(companyApi, username, officeVisit !== null);

  const leaveOffice = () => {
    if (isInRoom) room.leave();
    game.leaveOffice();
  };

  return (
    <WalletContext value={game.progress.wallet}>
      <CareerContext value={career}>
      <WellbeingContext value={wellbeing}>
      {isInOffice ? (
        <OfficeErrorBoundary onLeave={leaveOffice}>
          <CompanyOfficeContext value={officeVisit}>
          <LaptopAppsContext value={companyApps}>
          <WarRoomView
            key={`${scenario.id}:${isInRoom ? room.room?.code : "solo"}`}
            scenario={scenario}
            role={role}
            onFinish={(result, startedAt) => game.recordWarRoom(scenario, result, { isTeam: isInRoom, startedAt })}
            onBuySolution={(startedAt) => game.buySolution(scenario, startedAt)}
            hints={{ usedToday: game.hintsUsedToday, spend: game.spendHint }}
            onLeave={leaveOffice}
            room={isInRoom ? room : undefined}
            onUseScreen={(screen) => game.openDiscussion(screen.role)}
            onPaged={game.closeDiscussion}
            overlay={overlay}
          />
          </LaptopAppsContext>
          </CompanyOfficeContext>
          <PayoutToast />
          <PromotionToast />
        </OfficeErrorBoundary>
      ) : (
        <Briefing
          progress={game.progress}
          roles={{ chosen: game.progress.role, onChoose: game.chooseRole }}
          onEnterOffice={game.enterOffice}
          onFeatureBadge={game.featureBadge}
          proSale={proSale}
          adminApi={adminApi}
          company={{
            api: companyApi,
            walletCents: game.progress.wallet.balanceCents,
            fundCompany: game.fundCompany,
            claimPayout: game.claimPayout,
            enterOffice: enterCompanyOffice,
            invest: game.invest,
            claimDividend: game.claimDividend,
          }}
          fetchLeaderboard={fetchLeaderboard}
          rooms={{
            status: room.status,
            error: room.error?.message ?? null,
            onCreate: (name, visibility) => room.create(TEAM_SCENARIO.id, { name, role, badge }, visibility),
            onJoin: (code, name) => room.join(code, { name, role, badge }),
            listPublic: fetchPublicRooms,
          }}
        />
      )}
      </WellbeingContext>
      </CareerContext>
    </WalletContext>
  );
}
