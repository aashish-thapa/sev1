import { useEffect, useState } from "react";
import type { AdminUser } from "../../storage/admin-protocol.ts";
import type { AdminApi, AdminRead } from "../../storage/admin-api.ts";

/** Pause after typing before searching, so each keystroke isn't a query. */
const SEARCH_DELAY_MS = 300;

/** Find accounts by the start of their username: level, experience, tags and when they last played. */
export function UserSearch({ api }: { api: AdminApi }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AdminRead<readonly AdminUser[]> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.users(query.trim(), controller.signal).then(setResult, () => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query]);

  const when = (at: number | null) => (at === null ? "never" : new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));

  return (
    <section className="admin__panel" aria-labelledby="users-title">
      <h2 id="users-title" className="admin__heading">
        Players
      </h2>
      <label className="home__name">
        <span>Username starts with</span>
        <input value={query} maxLength={24} autoCapitalize="none" spellCheck={false} placeholder="any" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {!result ? (
        <p className="admin__note">Searching…</p>
      ) : !result.ok ? (
        <p className="admin__note">{result.problem === "forbidden" ? "This account can’t search players." : "Couldn’t reach the player list."}</p>
      ) : result.value.length === 0 ? (
        <p className="admin__note">No accounts match.</p>
      ) : (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Level</th>
              <th scope="col">XP</th>
              <th scope="col">Tags</th>
              <th scope="col">Joined</th>
              <th scope="col">Last played</th>
            </tr>
          </thead>
          <tbody>
            {result.value.map((user) => (
              <tr key={user.username}>
                <th scope="row">{user.username}</th>
                <td>{user.title}</td>
                <td>{user.experience.toLocaleString("en-US")}</td>
                <td>{user.tags.length > 0 ? user.tags.join(", ") : <span className="admin__dim">none</span>}</td>
                <td>{when(user.createdAt)}</td>
                <td>{when(user.lastActive)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
