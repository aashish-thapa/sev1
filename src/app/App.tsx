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
import { LookContext } from "./look-context.ts";
import { WalletContext } from "./wallet-context.ts";
import { AccountContext } from "./useAccount.ts";
import { CompanyOfficeContext } from "../warroom/floor/company-office/context.ts";
import { visitedLayout, type CompanyLayout } from "../warroom/floor/company-office/plan.ts";
import { LaptopAppsContext } from "../warroom/ui/laptop-apps.ts";
import { useCompanyLaptopApps } from "../ui/company/desk/useCompanyLaptopApps.tsx";
import type { Company, DealWire } from "../storage/company-protocol.ts";
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
  // Solo play rotates through the role's unlocked War Rooms; a room plays the incident its host picked.
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
  // Null leaves it to the server: you are then drawn from your player id, as before.
  const avatar = game.progress.look.avatar ?? undefined;
  // The company whose office room you walked into from the HQ: its floor shows only what it bought.
  const [companyOffice, setCompanyOffice] = useState<{ readonly code: string; readonly companyId: string; readonly company: CompanyLayout } | null>(null);
  const enterCompanyOffice = useCallback(
    async (code: string) => {
      // Know the office's layout before stepping in, so you start at your desk, not behind a shut door.
      const mine = await companyApi.mine();
      const company = mine.ok ? mine.value.company : null;
      if (company) setCompanyOffice({ code, companyId: company.id, company });
      // In the office you're who the company hired you as, not your lobby role.
      const companyRole = company?.members.find((member) => member.username === username)?.role ?? role;
      room.join(code, { name: username ?? "", role: companyRole, badge, avatar });
    },
    [avatar, badge, companyApi, role, room, username],
  );
  // A meeting in your own company's office is just going to work; a visitor walks in on the deal's pass.
  const enterCompanyMeeting = useCallback(
    async (code: string, companyId: string) => {
      const mine = await companyApi.mine();
      if (mine.ok && mine.value.company?.id === companyId) return enterCompanyOffice(code);
      // A visitor walks into someone else's office: draw what that company bought, then step in as yourself.
      const layout = await companyApi.officeLayout(companyId);
      if (layout.ok) setCompanyOffice({ code, companyId, company: visitedLayout(layout.value) });
      room.join(code, { name: username ?? "", role, badge, avatar });
    },
    [avatar, badge, companyApi, enterCompanyOffice, role, room, username],
  );
  const officeVisit = useMemo(
    () => (companyOffice && isInRoom && room.room?.code === companyOffice.code ? { company: companyOffice.company, me: username } : null),
    [companyOffice, isInRoom, room.room?.code, username],
  );

  const refreshOffice = useCallback((company: Company) => setCompanyOffice((office) => (office && office.companyId === company.id ? { ...office, company } : office)), []);
  const { invest } = game;
  const payForDeal = useCallback(
    (deal: DealWire) => {
      // Repeating a ref is a no-op, so seeing the agreed deal on every refetch pays once.
      if (deal.investRef) invest(deal.investRef, deal.terms.amountCents);
    },
    [invest],
  );
  const companyApps = useCompanyLaptopApps(companyApi, username, {
    officeCompanyId: officeVisit ? (companyOffice?.companyId ?? null) : null,
    onCompany: refreshOffice,
    onAgreed: payForDeal,
  });

  const leaveOffice = () => {
    if (isInRoom) room.leave();
    game.leaveOffice();
  };

  return (
    <WalletContext value={game.progress.wallet}>
    <LookContext value={game.progress.look}>
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
          onChooseLook={game.chooseLook}
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
            enterMeeting: enterCompanyMeeting,
          }}
          fetchLeaderboard={fetchLeaderboard}
          rooms={{
            status: room.status,
            error: room.error?.message ?? null,
            onCreate: (name, visibility, scenarioId) => room.create(scenarioId, { name, role, badge, avatar }, visibility),
            onJoin: (code, name) => room.join(code, { name, role, badge, avatar }),
            listPublic: fetchPublicRooms,
          }}
        />
      )}
      </WellbeingContext>
      </CareerContext>
    </LookContext>
    </WalletContext>
  );
}
