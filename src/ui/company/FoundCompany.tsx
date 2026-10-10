import { useState, type FormEvent } from "react";
import { CATEGORIES, FOUNDING_RUNWAY_DAYS, roomKindById, type CategoryId } from "../../domain/company/catalog.ts";
import { FOUNDING_MINIMUM_CENTS } from "../../domain/company/rules.ts";
import { formatCents } from "../../domain/economy.ts";
import { ROLE_IDS, type Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { CompanyApi } from "../../storage/company-api.ts";
import { companyErrorText } from "./errors.ts";

type Props = {
  api: CompanyApi;
  walletCents: number;
  defaultRole: Role;
  /** Moves the seed from the wallet; returns why it couldn't, or null. */
  onFounded: (fundingRef: string, seedCents: number) => string | null;
};

const dollars = (cents: number) => Math.floor(cents / 100);

/** Name it, pick what it makes, your own role, and how much of your earnings to put in. */
export function FoundCompany({ api, walletCents, defaultRole, onFounded }: Props) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<CategoryId>("ecommerce");
  const [role, setRole] = useState<Role>(defaultRole);
  const [seedDollars, setSeedDollars] = useState(dollars(FOUNDING_MINIMUM_CENTS));
  const [problem, setProblem] = useState<string | null>(null);
  const [isBusy, setBusy] = useState(false);

  const seedCents = seedDollars * 100;
  const canAfford = walletCents >= FOUNDING_MINIMUM_CENTS;
  const isValid = name.trim().length >= 3 && seedCents >= FOUNDING_MINIMUM_CENTS && seedCents <= walletCents;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid || isBusy) return;
    setBusy(true);
    setProblem(null);
    const founded = await api.found({ name: name.trim(), category, role, seedCents });
    setBusy(false);
    if (!founded.ok) return setProblem(companyErrorText(founded.error, founded.message));
    setProblem(onFounded(founded.value.fundingRef, founded.value.seedCents));
  };

  return (
    <form className="company__panel found" onSubmit={(event) => void submit(event)}>
      <h1 className="home__title company__title">Start a company</h1>
      <p className="company__lede">
        Put in money you’ve earned and hire other players into real roles. It needs at least {formatCents(FOUNDING_MINIMUM_CENTS)}: your first bay (
        {formatCents(roomKindById("bay").costCents)}, bought from the seed) and {FOUNDING_RUNWAY_DAYS} work days of pay. A starter server comes free, so day one can
        earn. You have <strong>{formatCents(walletCents)}</strong>.
      </p>

      <label className="home__name">
        <span>Company name</span>
        <input value={name} minLength={3} maxLength={40} placeholder="Night Shift Labs" onChange={(event) => setName(event.target.value)} />
      </label>

      <fieldset className="found__categories">
        <legend className="role-picker__legend">What it makes</legend>
        {CATEGORIES.map((option) => (
          <label key={option.id} className="found__category">
            <input type="radio" name="category" value={option.id} checked={category === option.id} onChange={() => setCategory(option.id)} />
            <strong>{option.title}</strong>
            <span>{option.pitch}</span>
            <span className="found__meta">
              Up to {formatCents(option.baseRevenueCents)} a work day · needs {option.keyRoles.map((key) => ROLE_INFO[key].label).join(", ")}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="role-picker">
        <legend className="role-picker__legend">Your role in it</legend>
        <div className="role-picker__options">
          {ROLE_IDS.map((option) => (
            <label key={option} className="role-picker__option">
              <input type="radio" name="founder-role" value={option} checked={role === option} onChange={() => setRole(option)} />
              <span>{ROLE_INFO[option].label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="home__name">
        <span>Seed, in dollars (from your wallet)</span>
        <input
          type="number"
          inputMode="numeric"
          min={dollars(FOUNDING_MINIMUM_CENTS)}
          max={dollars(walletCents)}
          value={seedDollars}
          onChange={(event) => setSeedDollars(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
        />
      </label>

      <div className="found__actions">
        <button type="submit" className="button button--primary" disabled={!isValid || isBusy}>
          {isBusy ? "Founding…" : `Found it with ${formatCents(seedCents)}`}
        </button>
        <p className="company__note" role="status">
          {problem ??
            (!canAfford
              ? `Earn ${formatCents(FOUNDING_MINIMUM_CENTS - walletCents)} more in job mode to found a company.`
              : seedCents > walletCents
                ? "That’s more than your wallet holds."
                : "")}
        </p>
      </div>
    </form>
  );
}
