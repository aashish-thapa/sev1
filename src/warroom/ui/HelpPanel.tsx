import { useState } from "react";
import { useCareer } from "../../app/career-context.ts";
import { useWallet } from "../../app/wallet-context.ts";
import { formatCents } from "../../domain/economy.ts";
import { hasBoughtSolution, solutionPriceCents } from "../../domain/purchases.ts";
import type { IncidentHelp } from "./incident-help.ts";

/** Hints are free only on guided incidents; past that you're paid to diagnose. */
const FREE_HINT_TIER = 1;

type Props = {
  help: IncidentHelp;
  /** Puts a solution command in the terminal prompt, ready to run. */
  onSuggest: (command: string) => void;
};

export function HelpPanel({ help, onSuggest }: Props) {
  return (
    <div className="help">
      <Hints help={help} />
      <Solution help={help} onSuggest={onSuggest} />
    </div>
  );
}

function Hints({ help }: { help: IncidentHelp }) {
  const [shown, setShown] = useState(0);
  const { hints, tier } = help.scenario;
  if (tier > FREE_HINT_TIER) {
    return (
      <section className="help__section" aria-labelledby="help-hints">
        <h3 id="help-hints" className="help__heading">
          Hints
        </h3>
        <p className="help__note">Free hints are for guided incidents. At this level you’re paid to diagnose — or you can buy the worked solution.</p>
      </section>
    );
  }
  return (
    <section className="help__section" aria-labelledby="help-hints">
      <h3 id="help-hints" className="help__heading">
        Hints <span className="help__tag">free on guided incidents</span>
      </h3>
      <ol className="help__hints">
        {hints.slice(0, shown).map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ol>
      {shown < hints.length && (
        <button type="button" className="button button--ghost" onClick={() => setShown((count) => count + 1)}>
          {shown === 0 ? "Show a hint" : "Another hint"}
        </button>
      )}
    </section>
  );
}

function Solution({ help, onSuggest }: Props) {
  const wallet = useWallet();
  const career = useCareer();
  const [isConfirming, setConfirming] = useState(false);
  const steps = help.scenario.solution[help.role] ?? [];
  const isBought = hasBoughtSolution(wallet, { scenarioId: help.scenario.id, runStartedAt: help.runStartedAt });
  const price = solutionPriceCents(help.scenario.tier, career.level);
  const shortBy = price - wallet.balanceCents;

  if (isBought) {
    return (
      <section className="help__section" aria-labelledby="help-solution">
        <h3 id="help-solution" className="help__heading">
          Worked solution <span className="help__tag">bought · this run pays no bonus</span>
        </h3>
        <ol className="help__steps">
          {steps.map((step, index) => (
            <li key={`${index}-${step.command}`} className="help__step">
              <button type="button" className="help__command" onClick={() => onSuggest(step.command)} title="Put it in the terminal">
                <code>{step.command}</code>
              </button>
              <p className="help__why">{step.why}</p>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section className="help__section" aria-labelledby="help-solution">
      <h3 id="help-solution" className="help__heading">
        Worked solution
      </h3>
      <p className="help__note">
        Every step, in order, with why — {steps.length} steps for your role. It costs {formatCents(price)} at your level, and the run then pays no incident bonus
        and earns no experience toward promotion.
      </p>
      {shortBy > 0 ? (
        <p className="help__short" role="status">
          You have {formatCents(wallet.balanceCents)} — {formatCents(shortBy)} short. Close incidents and make correct calls to earn it.
        </p>
      ) : isConfirming ? (
        <div className="help__confirm">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              help.buy();
              setConfirming(false);
            }}
          >
            Spend {formatCents(price)}
          </button>
          <button type="button" className="button button--quiet" onClick={() => setConfirming(false)}>
            Keep trying
          </button>
        </div>
      ) : (
        <button type="button" className="button button--ghost" onClick={() => setConfirming(true)}>
          Buy the solution · {formatCents(price)}
        </button>
      )}
    </section>
  );
}
