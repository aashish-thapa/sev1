import { formatCents, SALARY_CENTS_PER_MINUTE, type LedgerEntry } from "../domain/economy.ts";

type Line = { readonly key: string; readonly label: string; readonly amountCents: number };

/** Salary arrives a minute at a time; on a payslip it reads as one line, bonuses as their own. */
function linesOf(entries: readonly LedgerEntry[]): Line[] {
  const salary = entries.filter((entry) => entry.reason === "salary");
  const bonuses = entries.filter((entry) => entry.reason !== "salary").map((entry) => ({ key: String(entry.seq), label: entry.note, amountCents: entry.amountCents }));
  const salaryCents = salary.reduce((sum, entry) => sum + entry.amountCents, 0);
  const minutes = salaryCents / SALARY_CENTS_PER_MINUTE;
  return salaryCents > 0 ? [{ key: "salary", label: `Salary · ${minutes} active ${minutes === 1 ? "minute" : "minutes"}`, amountCents: salaryCents }, ...bonuses] : bonuses;
}

type Props = {
  entries: readonly LedgerEntry[];
  /** Shown when nothing was earned, so the player knows why. */
  emptyNote: string;
};

export function Payslip({ entries, emptyNote }: Props) {
  const lines = linesOf(entries);
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return (
    <table className="payslip">
      <caption>Payslip</caption>
      <tbody>
        {lines.length === 0 ? (
          <tr>
            <td colSpan={2} className="payslip__empty">
              {emptyNote}
            </td>
          </tr>
        ) : (
          lines.map((line) => (
            <tr key={line.key}>
              <th scope="row">{line.label}</th>
              <td>{formatCents(line.amountCents)}</td>
            </tr>
          ))
        )}
      </tbody>
      {lines.length > 1 && (
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{formatCents(total)}</td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
