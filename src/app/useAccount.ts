import { createContext, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Account, Entitlements, PendingGrant } from "../storage/account-protocol.ts";
import type { AccountApi, AccountProblem, Outcome, SignedIn } from "../storage/account-api.ts";
import type { ProgressStore } from "../storage/progress-store.ts";
import type { ProgressSync, SyncStatus } from "../storage/syncing-progress-store.ts";

export type AccountStatus = "checking" | "anonymous" | "signed-in";

export type AccountSession = {
  readonly status: AccountStatus;
  readonly account: Account | null;
  /** What the account has paid for, from the server; null for guests. */
  readonly entitlements: Entitlements | null;
  /** Money an admin granted, waiting to be claimed into the wallet; empty for guests. */
  readonly pendingGrants: readonly PendingGrant[];
  readonly sync: SyncStatus;
  readonly problem: AccountProblem | null;
  readonly isBusy: boolean;
  signUp(username: string, password: string): Promise<void>;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Asks the server again who's signed in, what they're entitled to and what's waiting for them. */
  refresh(): Promise<void>;
};

/** Null outside the app shell (tests, stories): account UI then renders nothing. */
export const AccountContext = createContext<AccountSession | null>(null);

type State = {
  readonly status: AccountStatus;
  readonly account: Account | null;
  readonly entitlements: Entitlements | null;
  readonly pendingGrants: readonly PendingGrant[];
  readonly problem: AccountProblem | null;
  readonly isBusy: boolean;
};

const SIGNED_OUT: State = { status: "anonymous", account: null, entitlements: null, pendingGrants: [], problem: null, isBusy: false };

/** Who's signed in, and the bridge between signing in and syncing progress. */
export function useAccount(api: AccountApi, store: ProgressStore, sync: ProgressSync): AccountSession {
  const [state, setState] = useState<State>({ ...SIGNED_OUT, status: "checking" });
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
        setState(SIGNED_OUT);
        return;
      }
      const saved = await api.loadProgress();
      if (!isCurrent) return;
      setState({ status: "signed-in", account: me.value.account, entitlements: me.value.entitlements, pendingGrants: me.value.pendingGrants, problem: null, isBusy: false });
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
      setState({ status: "signed-in", account: outcome.value.account, entitlements: null, pendingGrants: [], problem: null, isBusy: false });
      await sync.signedIn(outcome.value.progress);
      // Sign-in doesn't carry entitlements or grants; ask once, so a returning player has both straight away.
      const me = await api.me();
      if (me.ok && me.value) {
        const { entitlements, pendingGrants } = me.value;
        setState((current) => ({ ...current, entitlements, pendingGrants }));
      }
    },
    [api, sync],
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
    setState(SIGNED_OUT);
  }, [api, sync]);

  const refresh = useCallback(async () => {
    const me = await api.me();
    if (me.ok && me.value) {
      const { account, entitlements, pendingGrants } = me.value;
      setState((current) => ({ ...current, account, entitlements, pendingGrants }));
    }
  }, [api]);

  // A save that claimed grants clears them on the server; once it lands, ask again so the list empties.
  const previousSync = useRef(snapshot.status);
  const hasPendingGrants = state.pendingGrants.length > 0;
  useEffect(() => {
    const wasSaving = previousSync.current === "saving";
    previousSync.current = snapshot.status;
    if (wasSaving && snapshot.status === "saved" && hasPendingGrants) void refresh();
  }, [hasPendingGrants, refresh, snapshot.status]);

  return { ...state, sync: snapshot.status, signUp, signIn, signOut, refresh };
}
