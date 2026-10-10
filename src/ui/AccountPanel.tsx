import { useContext, useState, type FormEvent } from "react";
import { AccountContext, type AccountSession } from "../app/useAccount.ts";
import type { SyncStatus } from "../storage/syncing-progress-store.ts";

const SYNC_LABEL: Readonly<Record<SyncStatus, string>> = {
  local: "Saved on this device",
  saving: "Saving to your account…",
  saved: "Money and progress saved to your account",
  offline: "Can't reach the server — saved on this device for now",
  rejected: "Your account couldn't take this save — kept on this device",
};

/** Sign up to keep your money across devices; playing never needs an account. */
export function AccountPanel() {
  const session = useContext(AccountContext);
  if (!session || session.status === "checking") return null;
  return (
    <section className="account" aria-labelledby="account-heading">
      <h2 id="account-heading" className="account__title">
        Your account
      </h2>
      {session.status === "signed-in" && session.account ? <SignedIn session={session} username={session.account.username} /> : <SignInForm session={session} />}
    </section>
  );
}

function SignedIn({ session, username }: { session: AccountSession; username: string }) {
  return (
    <>
      <p className="account__lede">
        Signed in as <strong className="account__name">{username}</strong>
      </p>
      <div className="account__row">
        <p className="account__status" role="status">
          {session.problem?.message ?? SYNC_LABEL[session.sync]}
        </p>
        <button type="button" className="button button--quiet" disabled={session.isBusy} onClick={() => void session.signOut()}>
          Log out
        </button>
      </div>
    </>
  );
}

function SignInForm({ session }: { session: AccountSession }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const isReady = username.trim().length >= 3 && password.length >= 8 && !session.isBusy;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isReady) return;
    // Both buttons submit the form; the one pressed says which it was.
    const isSignIn = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "sign-in";
    // The session reports success or failure through its own state.
    void (isSignIn ? session.signIn(username.trim(), password) : session.signUp(username.trim(), password));
  };

  return (
    <form className="account__form" onSubmit={submit}>
      <p className="account__lede">Play without an account — sign up to keep your money.</p>
      <div className="account__row">
        <label className="account__field">
          <span>Username</span>
          <input value={username} maxLength={24} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="account__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            minLength={8}
            maxLength={128}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>
      <div className="account__row">
        <button type="submit" name="intent" value="sign-up" className="button button--ghost" disabled={!isReady}>
          Sign up
        </button>
        <button type="submit" name="intent" value="sign-in" className="button button--quiet" disabled={!isReady}>
          Log in
        </button>
      </div>
      <p className="account__status" role="status">
        {session.isBusy ? "Checking…" : (session.problem?.message ?? "")}
      </p>
    </form>
  );
}
