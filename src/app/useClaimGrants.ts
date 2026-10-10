import { useEffect } from "react";
import { payRef } from "../domain/economy.ts";
import type { Wallet } from "../domain/economy.ts";
import type { PendingGrant } from "../storage/account-protocol.ts";

/**
 * Claims money an admin granted into the wallet, wherever the player is in the game. One grant per
 * render: each claim commits new progress, which re-runs this for the next, so none overwrite another.
 */
export function useClaimGrants(pendingGrants: readonly PendingGrant[] | undefined, wallet: Wallet, claimGrant: (grant: PendingGrant) => void): void {
  const unclaimed = pendingGrants?.find((grant) => !wallet.ledger.some((entry) => entry.ref === payRef.grant(grant.id)));
  useEffect(() => {
    if (unclaimed) claimGrant(unclaimed);
  }, [claimGrant, unclaimed]);
}
