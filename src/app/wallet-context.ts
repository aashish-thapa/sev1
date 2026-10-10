import { createContext, useContext } from "react";
import { emptyWallet, type Wallet } from "../domain/economy.ts";

/** The player's wallet, readable anywhere in the office without threading it through every view. */
export const WalletContext = createContext<Wallet>(emptyWallet());

export function useWallet(): Wallet {
  return useContext(WalletContext);
}
