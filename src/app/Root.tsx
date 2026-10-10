import { useSyncExternalStore, type ComponentProps } from "react";
import type { AccountApi } from "../storage/account-api.ts";
import type { ProgressStore } from "../storage/progress-store.ts";
import type { ProgressSync } from "../storage/syncing-progress-store.ts";
import { App } from "./App.tsx";
import { AccountContext, useAccount } from "./useAccount.ts";

type Props = Omit<ComponentProps<typeof App>, "store"> & {
  readonly store: ProgressStore;
  readonly sync: ProgressSync;
  readonly accounts: AccountApi;
};

/** The account around the game. When the account's copy of progress replaces this device's, the game restarts from it. */
export function Root({ sync, accounts, store, ...app }: Props) {
  const session = useAccount(accounts, store, sync);
  const { revision } = useSyncExternalStore(
    (listener) => sync.subscribe(listener),
    () => sync.snapshot,
  );
  return (
    <AccountContext value={session}>
      <App key={revision} store={store} {...app} />
    </AccountContext>
  );
}
