import { useEffect, useState } from "react";
import { useWallet } from "../app/wallet-context.ts";
import { formatCents } from "../domain/economy.ts";

const SHOWN_MS = 2_800;

/** "+$25.00 · Correct call" each time the wallet is paid; quiet for anything paid before it mounted. */
export function PayoutToast() {
  const { ledger, nextSeq } = useWallet();
  const [firstSeq] = useState(nextSeq);
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);
  const newest = ledger.at(-1);
  const shown = newest && newest.seq >= firstSeq && newest.seq !== dismissedSeq ? newest : null;
  const shownSeq = shown?.seq ?? null;

  useEffect(() => {
    if (shownSeq === null) return;
    const timer = window.setTimeout(() => setDismissedSeq(shownSeq), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [shownSeq]);

  return (
    <p className="payout" role="status" aria-live="polite">
      {shown && (
        <span key={shown.seq} className="payout__line" data-reason={shown.reason}>
          <strong>{shown.amountCents > 0 ? "+" : "−"}{formatCents(Math.abs(shown.amountCents))}</strong> {shown.note}
        </span>
      )}
    </p>
  );
}
