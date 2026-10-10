import { useEffect, useState, type FormEvent } from "react";
import { formatCents } from "../../domain/economy.ts";
import { MAX_GRANT_CENTS, type Grant } from "../../storage/admin-protocol.ts";
import type { AdminApi } from "../../storage/admin-api.ts";

type Props = { api: AdminApi; username: string; onClose: () => void };

/**
 * Put test money in one player's wallet. Two steps, amount then confirm, so a slipped digit doesn't
 * go straight out. The player's game claims it next time it loads; grants never count toward badges.
 */
export function GiveMoney({ api, username, onClose }: Props) {
  const [dollars, setDollars] = useState(100);
  const [note, setNote] = useState("");
  const [isConfirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly Grant[] | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const cents = Math.round(dollars * 100);
  const isValid = Number.isFinite(dollars) && cents > 0 && cents <= MAX_GRANT_CENTS;

  useEffect(() => {
    const controller = new AbortController();
    api.grants(username, controller.signal).then((read) => setHistory(read.ok ? read.value : []), () => undefined);
    return () => controller.abort();
  }, [api, username, refreshes]);

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid) return;
    if (!isConfirming) return setConfirming(true);
    setStatus("Sending…");
    const result = await api.grant({ username, amountCents: cents, note: note.trim() });
    setConfirming(false);
    setStatus(
      result.ok
        ? `Granted ${formatCents(result.value.amountCents)} to ${username}. It lands in their wallet next time their game loads.`
        : result.problem === "forbidden"
          ? "This account can’t grant money."
          : result.problem === "unknown_user"
            ? `There’s no player called ${username}; nothing was granted.`
            : "Couldn’t reach the server; nothing was granted.",
    );
    if (result.ok) setRefreshes((count) => count + 1);
  };

  return (
    <div className="give">
      <form className="give__form" onSubmit={(event) => void send(event)}>
        <label className="home__name">
          <span>Amount, dollars (up to {formatCents(MAX_GRANT_CENTS)})</span>
          <input
            type="number"
            inputMode="decimal"
            min={0.01}
            step={0.01}
            max={MAX_GRANT_CENTS / 100}
            value={dollars}
            onChange={(event) => {
              setDollars(Number(event.target.value));
              setConfirming(false);
            }}
          />
        </label>
        <label className="home__name">
          <span>Note (optional)</span>
          <input value={note} maxLength={120} placeholder="Testing startup mode" onChange={(event) => setNote(event.target.value)} />
        </label>
        <button type="submit" className={isConfirming ? "button button--primary" : "button button--ghost"} disabled={!isValid}>
          {isConfirming ? `Confirm: give ${formatCents(cents)} to ${username}` : "Give money"}
        </button>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </form>
      <p className="company__note" role="status">
        {status}
      </p>
      {history && history.length > 0 && (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Granted</th>
              <th scope="col">Amount</th>
              <th scope="col">Note</th>
              <th scope="col">By</th>
              <th scope="col">Claimed</th>
            </tr>
          </thead>
          <tbody>
            {history.map((grant) => (
              <tr key={grant.id}>
                <td>{new Date(grant.grantedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{formatCents(grant.amountCents)}</td>
                <td>{grant.note || <span className="admin__dim">none</span>}</td>
                <td>{grant.grantedBy}</td>
                <td>{grant.claimedAt === null ? <span className="admin__dim">not yet</span> : new Date(grant.claimedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
