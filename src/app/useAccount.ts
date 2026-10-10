import { createContext, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Account } from "../storage/account-protocol.ts";
import type { AccountApi, AccountProblem, Outcome, SignedIn } from "../storage/account-api.ts";
import type { ProgressStore } from "../storage/progress-store.ts";
import type { ProgressSync, SyncStatus } from "../storage/syncing-progress-store.ts";

export type AccountStatus = "checking" | "anonymous" | "signed-in";

export type AccountSession = {
  readonly status: AccountStatus;
  readonly account: Account | null;
  readonly sync: SyncStatus;
  readonly problem: AccountProblem | null;
  readonly isBusy: boolean;
  signUp(username: string, password: string): Promise<void>;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
};

/** Null outside the app shell (tests, stories): account UI then renders nothing. */
export const AccountContext = createContext<AccountSession | null>(null);

type State = { readonly status: AccountStatus; readonly account: Account | null; readonly problem: AccountProblem | null; readonly isBusy: boolean };

/** Who's signed in, and the bridge between signing in and syncing progress. */
export function useAccount(api: AccountApi, store: ProgressStore, sync: ProgressSync): AccountSession {
  const [state, setState] = useState<State>({ status: "checking", account: null, problem: null, isBusy: false });
  const snapshot = useSyncExternalStore(
    (listener) => sync.subscribe(listener),
    () => sync.snapshot,
  );

  useEffect(() => {
    let isCurrent = true;
    const restore = async () => {
      const me = await api.me();
      if (!isCurrent) return;
      if (!me.ok || me.value === null) {
        setState({ status: "anonymous", account: null, problem: null, isBusy: false });
        return;
      }
      const saved = await api.loadProgress();
      if (!isCurrent) return;
      setState({ status: "signed-in", account: me.value, problem: null, isBusy: false });
      if (saved.ok) await sync.signedIn(saved.value);
    };
    // restore() reports every outcome through state; there's no caller to hand a rejection to.
    void restore();
    return () => {
      isCurrent = false;
    };
  }, [api, sync]);

  const enter = useCallback(
    async (attempt: () => Promise<Outcome<SignedIn>>) => {
      setState((current) => ({ ...current, isBusy: true, problem: null }));
      const outcome = await attempt();
      if (!outcome.ok) {
        setState((current) => ({ ...current, isBusy: false, problem: outcome.problem }));
        return;
      }
      setState({ status: "signed-in", account: outcome.value.account, problem: null, isBusy: false });
      await sync.signedIn(outcome.value.progress);
    },
    [sync],
  );

  const signUp = useCallback((username: string, password: string) => enter(() => api.signUp(username, password, store.load())), [api, enter, store]);
  const signIn = useCallback((username: string, password: string) => enter(() => api.signIn(username, password)), [api, enter]);
  const signOut = useCallback(async () => {
    setState((current) => ({ ...current, isBusy: true, problem: null }));
    const outcome = await api.signOut();
    if (!outcome.ok) {
      setState((current) => ({ ...current, isBusy: false, problem: outcome.problem }));
      return;
    }
    sync.signedOut();
    setState({ status: "anonymous", account: null, problem: null, isBusy: false });
  }, [api, sync]);

  return { ...state, sync: snapshot.status, signUp, signIn, signOut };
}
