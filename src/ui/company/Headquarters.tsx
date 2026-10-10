import { useState, type FormEvent } from "react";
import { categoryById, CONTRACTOR_FEE_CENTS, ROLE_MINIMUM_PAY_CENTS, ROOM_KINDS, SERVER_TIERS } from "../../domain/company/catalog.ts";
import { capacityRps, checkOffer, checkRoomPurchase, checkServerPurchase, racks, seats, uncoveredRoles, type CompanyBook } from "../../domain/company/rules.ts";
import { formatCents } from "../../domain/economy.ts";
import { ROLE_IDS, type Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { CompanyApi, CompanyOutcome } from "../../storage/company-api.ts";
import { companyErrorText } from "./errors.ts";
import type { Company, WorkDaySettlement } from "../../storage/company-protocol.ts";
import type { Task } from "../../domain/work/task.ts";
import { useWorkLog } from "../work/useWorkLog.ts";
import { WorkBoard } from "../work/WorkBoard.tsx";

type Props = {
  api: CompanyApi;
  company: Company;
  username: string | null;
  onChanged: () => void;
  tasks: readonly Task[];
  /** The local day, YYYY-MM-DD. */
  day: string;
};

const REASON_LABEL: Readonly<Record<Company["ledger"][number]["reason"], string>> = {
  seed: "Seed",
  revenue: "Revenue",
  "room-upkeep": "Room upkeep",
  "server-upkeep": "Server upkeep",
  contractor: "Contractor",
  payroll: "Payroll",
  "room-purchase": "Room bought",
  "server-purchase": "Server bought",
};

const OFFER_PROBLEM: Readonly<Record<"below_minimum" | "no_free_desk", string>> = {
  below_minimum: "That’s below the minimum for the role.",
  no_free_desk: "Every desk is taken or promised; buy another bay first.",
};

/** The company's HQ: money, people, rooms, servers, the day's books. Only the founder buys, hires and sets pay. */
export function Headquarters({ api, company, username, onChanged, tasks, day }: Props) {
  const work = useWorkLog(day);
  const myRole = company.members.find((member) => member.username === username)?.role ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setBusy] = useState(false);
  const isFounder = company.members.some((member) => member.isFounder && member.username === username);
  const category = categoryById(company.category);
  // The page checks the same rules as the server to explain a disabled button; the server is still the one that decides.
  const book: CompanyBook = {
    category: company.category,
    fundsCents: company.fundsCents,
    members: company.members.map((member) => ({ userId: member.username, role: member.role, payCents: member.payCents })),
    rooms: company.rooms,
    servers: company.servers,
  };
  const missing = uncoveredRoles(book);

  const act = async <T,>(work: () => Promise<CompanyOutcome<T>>, done: (value: T) => string) => {
    setBusy(true);
    setNotice(null);
    const outcome = await work();
    setBusy(false);
    setNotice(outcome.ok ? done(outcome.value) : companyErrorText(outcome.error, outcome.message));
    if (outcome.ok) onChanged();
  };

  const settled = (day: WorkDaySettlement) => {
    const revenue = day.lines.filter((line) => line.reason === "revenue").reduce((sum, line) => sum + line.amountCents, 0);
    return `Work day ${day.workDay} closed: ${formatCents(revenue)} revenue, ${formatCents(day.fundsAfter)} left.${day.isPayrollShort ? " Funds ran short, so everyone got the same share of their pay." : ""}`;
  };

  return (
    <div className="hq">
      <header className="hq__head">
        <h1 className="home__title company__title">{company.name}</h1>
        <p className="company__lede">
          {category.title} · work day {company.workDay} · {isFounder ? "you founded it" : "you work here"}
        </p>
      </header>

      <dl className="admin__tiles">
        <Tile label="Funds" value={formatCents(company.fundsCents)} />
        <Tile label="Desks" value={`${company.members.length} of ${seats(company.rooms)}`} />
        <Tile label="Racks" value={`${company.servers.length} of ${racks(company.rooms)}`} />
        <Tile label="Capacity, requests/s" value={`${capacityRps(company.servers)} of ${category.demandRps}`} />
        <Tile label="Payroll a day" value={formatCents(company.members.reduce((sum, member) => sum + member.payCents, 0))} />
        <Tile label="Up to a day" value={formatCents(category.baseRevenueCents)} />
      </dl>

      {missing.length > 0 && (
        <p className="company__warning">
          Nobody holds {missing.map((role) => ROLE_INFO[role].label).join(", ")}. Their issues need a contractor: {formatCents(CONTRACTOR_FEE_CENTS[1])} to{" "}
          {formatCents(CONTRACTOR_FEE_CENTS[5])} each, by difficulty.
        </p>
      )}
      {capacityRps(company.servers) < category.demandRps && (
        <p className="company__warning">Your servers can’t serve all of {category.title}’s traffic, so part of each day’s revenue is lost. Buy servers below.</p>
      )}

      <section className="company__panel" aria-labelledby="day-title">
        <h2 id="day-title" className="admin__heading">
          The work day
        </h2>
        <p className="company__note">Closing the day books revenue, upkeep and everyone’s pay. Any member can close it, once a day, after a shift.</p>
        <button
          type="button"
          className="button button--primary hq__close"
          disabled={isBusy}
          onClick={() => void act(() => api.settleWorkDay({ tasksShipped: work.shippedToday.size }), settled)}
        >
          Close today’s work day
        </button>
      </section>

      {myRole && (
        <WorkBoard
          tasks={tasks}
          role={myRole}
          category={company.category}
          day={day}
          finishedBefore={work.finishedBefore}
          shippedToday={work.shippedToday}
          onShipped={work.ship}
        />
      )}

      <section className="company__panel" aria-labelledby="staff-title">
        <h2 id="staff-title" className="admin__heading">
          Staff
        </h2>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Pay a day</th>
            </tr>
          </thead>
          <tbody>
            {company.members.map((member) => (
              <tr key={member.username}>
                <th scope="row">
                  {member.username}
                  {member.isFounder && <span className="admin__dim"> · founder</span>}
                </th>
                <td>{ROLE_INFO[member.role].label}</td>
                <td>
                  {isFounder ? (
                    <PayEditor
                      role={member.role}
                      payCents={member.payCents}
                      disabled={isBusy}
                      onSave={(payCents) => void act(() => api.setMember({ username: member.username, role: member.role, payCents }), () => `${member.username} now earns ${formatCents(payCents)} a day.`)}
                    />
                  ) : (
                    formatCents(member.payCents)
                  )}
                </td>
              </tr>
            ))}
            {company.pendingInvitations.map((invitation) => (
              <tr key={invitation.id} className="hq__pending">
                <th scope="row">
                  {invitation.username} <span className="admin__dim">· invited</span>
                </th>
                <td>{ROLE_INFO[invitation.role].label}</td>
                <td>{formatCents(invitation.payCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isFounder && (
          <InviteForm
            book={book}
            pending={company.pendingInvitations.length}
            disabled={isBusy}
            onInvite={(username, role, payCents) =>
              void act(() => api.invite({ username, role, payCents }), () => `Offer sent to ${username}. They’ll see it in their company page.`)
            }
          />
        )}
      </section>

      {isFounder && (
        <section className="company__panel" aria-labelledby="shop-title">
          <h2 id="shop-title" className="admin__heading">
            Rooms and servers
          </h2>
          <ul className="shop">
            {ROOM_KINDS.map((room) => {
              const problem = checkRoomPurchase(book, room.id);
              return (
                <li key={room.id} className="shop__item">
                  <span>
                    <strong>{room.title}</strong>
                    <span className="admin__dim">
                      {" "}
                      · {room.seats > 0 ? `${room.seats} desks` : `${room.racks} racks`} · {formatCents(room.upkeepCents)} a day upkeep · own {company.rooms.filter((owned) => owned === room.id).length}
                    </span>
                  </span>
                  <button type="button" className="button button--ghost" disabled={isBusy || problem !== null} onClick={() => void act(() => api.buyRoom({ room: room.id }), () => `Bought a ${room.title.toLowerCase()}.`)}>
                    Buy for {formatCents(room.costCents)}
                  </button>
                </li>
              );
            })}
            {SERVER_TIERS.map((tier) => {
              const problem = checkServerPurchase(book, tier.id);
              return (
                <li key={tier.id} className="shop__item">
                  <span>
                    <strong>{tier.title}</strong>
                    <span className="admin__dim">
                      {" "}
                      · {tier.capacityRps} rps · {formatCents(tier.upkeepCents)} a day · {problem === "no_free_rack" ? "needs a free rack" : `own ${company.servers.filter((owned) => owned === tier.id).length}`}
                    </span>
                  </span>
                  <button type="button" className="button button--ghost" disabled={isBusy || problem !== null} onClick={() => void act(() => api.buyServer({ server: tier.id }), () => `Bought a ${tier.title.toLowerCase()}.`)}>
                    Buy for {formatCents(tier.costCents)}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="company__note hq__notice" role="status">
        {notice}
      </p>

      <section className="company__panel" aria-labelledby="ledger-title">
        <h2 id="ledger-title" className="admin__heading">
          Books
        </h2>
        {company.ledger.length === 0 ? (
          <p className="company__note">Nothing booked yet.</p>
        ) : (
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">What</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {[...company.ledger].reverse().map((line, index) => (
                <tr key={`${line.at}-${index}`}>
                  <td>{line.workDay}</td>
                  <td>
                    {REASON_LABEL[line.reason]}
                    {line.note && <span className="admin__dim"> · {line.note}</span>}
                  </td>
                  <td className={line.amountCents < 0 ? "hq__out" : "hq__in"}>
                    {line.amountCents < 0 ? "−" : "+"}
                    {formatCents(Math.abs(line.amountCents))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin__tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PayEditor({ role, payCents, disabled, onSave }: { role: Role; payCents: number; disabled: boolean; onSave: (payCents: number) => void }) {
  const [dollars, setDollars] = useState(Math.round(payCents / 100));
  const minimum = ROLE_MINIMUM_PAY_CENTS[role] / 100;
  return (
    <span className="hq__pay">
      <input type="number" inputMode="numeric" min={minimum} value={dollars} aria-label="Pay a day, dollars" onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      <button type="button" className="button button--quiet" disabled={disabled || dollars < minimum || dollars * 100 === payCents} onClick={() => onSave(dollars * 100)}>
        Save
      </button>
    </span>
  );
}

function InviteForm({ book, pending, disabled, onInvite }: { book: CompanyBook; pending: number; disabled: boolean; onInvite: (username: string, role: Role, payCents: number) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("frontend");
  const [dollars, setDollars] = useState(ROLE_MINIMUM_PAY_CENTS.frontend / 100);
  const problem = checkOffer(book, role, dollars * 100, pending);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem || !username.trim()) return;
    onInvite(username.trim(), role, dollars * 100);
    setUsername("");
  };

  return (
    <form className="hq__invite" onSubmit={submit}>
      <label className="home__name">
        <span>Invite by username</span>
        <input value={username} maxLength={24} autoCapitalize="none" spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label className="home__name">
        <span>Role</span>
        <select
          value={role}
          onChange={(event) => {
            const next = event.target.value as Role;
            setRole(next);
            setDollars(Math.max(dollars, ROLE_MINIMUM_PAY_CENTS[next] / 100));
          }}
        >
          {ROLE_IDS.map((option) => (
            <option key={option} value={option}>
              {ROLE_INFO[option].label} (min {formatCents(ROLE_MINIMUM_PAY_CENTS[option])})
            </option>
          ))}
        </select>
      </label>
      <label className="home__name">
        <span>Pay a day, dollars</span>
        <input type="number" inputMode="numeric" min={ROLE_MINIMUM_PAY_CENTS[role] / 100} value={dollars} onChange={(event) => setDollars(Math.floor(Number(event.target.value) || 0))} />
      </label>
      <button type="submit" className="button button--ghost" disabled={disabled || problem !== null || !username.trim()}>
        Send offer
      </button>
      {problem && <p className="company__note">{OFFER_PROBLEM[problem]}</p>}
    </form>
  );
}
