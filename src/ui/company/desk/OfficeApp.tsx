import { CONTRACTOR_FEE_CENTS, ROOM_KINDS, SERVER_TIERS } from "../../../domain/company/catalog.ts";
import { companyLevel } from "../../../domain/company/levels.ts";
import { capacityRps, checkRoomPurchase, checkServerPurchase, racks, seats, uncoveredRoles } from "../../../domain/company/rules.ts";
import { formatCents } from "../../../domain/economy.ts";
import { ROLE_INFO } from "../../../domain/roles.ts";
import type { WorkDaySettlement } from "../../../storage/company-protocol.ts";
import { useCompanyAction, useDesk, type CompanyDesk } from "./desk.ts";

const settled = (day: WorkDaySettlement) => {
  const revenue = day.lines.filter((line) => line.reason === "revenue").reduce((sum, line) => sum + line.amountCents, 0);
  const skipped = day.undiscussed.length > 0 ? ` Half pay, no discussion: ${day.undiscussed.join(", ")}.` : "";
  return `Day ${day.workDay} closed: +${formatCents(revenue)}, ${formatCents(day.fundsAfter)} left.${day.isPayrollShort ? " Pay ran short." : ""}${skipped}`;
};

/** How the company stands, and for the founder, closing the day and buying rooms and servers. */
export function OfficeApp({ desk }: { desk: CompanyDesk }) {
  const { api, company } = desk;
  const { isFounder, book, category } = useDesk(desk);
  const { act, notice, isBusy } = useCompanyAction(desk.refresh);
  const missing = uncoveredRoles(book);
  const next = companyLevel({ lifetimeRevenueCents: company.lifetimeRevenueCents, workDays: company.workDay }).next;
  const capacity = capacityRps(company.servers);

  return (
    <div className="desk">
      <dl className="desk__stats">
        <Stat label="Funds" value={formatCents(company.fundsCents)} />
        <Stat label={company.levelTitle} value={`Day ${company.workDay}`} hint={next ? `${next.title} at ${formatCents(next.minRevenueCents)} and day ${next.minWorkDays}` : undefined} />
        <Stat label="Desks" value={`${company.members.length}/${seats(company.rooms)}`} />
        <Stat label="Traffic served" value={`${Math.min(100, Math.round((capacity / category.demandRps) * 100))}%`} hint={`${capacity} of ${category.demandRps} rps`} />
      </dl>
      {missing.length > 0 && (
        <p className="company__warning">
          No {missing.map((role) => ROLE_INFO[role].label).join(", ")}: contractors {formatCents(CONTRACTOR_FEE_CENTS[1])}–{formatCents(CONTRACTOR_FEE_CENTS[5])} an issue.
        </p>
      )}

      {isFounder ? (
        <button type="button" className="button button--primary desk__primary" disabled={isBusy} onClick={() => void act(() => api.settleWorkDay({}), settled)}>
          Close today’s work day
        </button>
      ) : (
        <p className="company__note">The founder closes each work day.</p>
      )}
      <p className="company__note">Answer at least one discussion card at your room’s screen each day, or that day pays half.</p>

      {isFounder && (
        <ul className="shop" aria-label="Rooms and servers">
          {ROOM_KINDS.map((room) => (
            <li key={room.id} className="shop__item">
              <span>
                <strong>{room.title}</strong>
                <span className="admin__dim">
                  {" "}
                  · {room.seats > 0 ? `${room.seats} desks` : `${room.racks} racks`} · {formatCents(room.upkeepCents)}/day · own {company.rooms.filter((owned) => owned === room.id).length}
                </span>
              </span>
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy || checkRoomPurchase(book, room.id) !== null}
                onClick={() => void act(() => api.buyRoom({ room: room.id }), () => `Bought a ${room.title.toLowerCase()}.`)}
              >
                {formatCents(room.costCents)}
              </button>
            </li>
          ))}
          {SERVER_TIERS.map((tier) => {
            const problem = checkServerPurchase(book, tier.id);
            return (
              <li key={tier.id} className="shop__item">
                <span>
                  <strong>{tier.title}</strong>
                  <span className="admin__dim">
                    {" "}
                    · {tier.capacityRps} rps · {formatCents(tier.upkeepCents)}/day · {problem === "no_free_rack" ? `racks full (${company.servers.length}/${racks(company.rooms)})` : `own ${company.servers.filter((owned) => owned === tier.id).length}`}
                  </span>
                </span>
                <button type="button" className="button button--ghost" disabled={isBusy || problem !== null} onClick={() => void act(() => api.buyServer({ server: tier.id }), () => `Racked a ${tier.title.toLowerCase()}.`)}>
                  {formatCents(tier.costCents)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="company__note" role="status">
        {notice}
      </p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="desk__stat" title={hint}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
