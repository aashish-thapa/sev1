import { useWallet } from "../app/wallet-context.ts";
import { formatCents } from "../domain/economy.ts";

/** The balance, as a HUD/lobby stat. */
export function WalletChip() {
  const { balanceCents } = useWallet();
  return (
    <div className="wallet-chip">
      <dt>Earned</dt>
      <dd>{formatCents(balanceCents)}</dd>
    </div>
  );
}
