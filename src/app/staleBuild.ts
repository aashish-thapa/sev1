/**
 * A tab can outlive a deploy: its cached page still asks for the previous build's code-split
 * chunks (the 3D office is one), which the host no longer has. Vite reports that failure as
 * `vite:preloadError`; reloading once fetches the current build. A second failure inside the
 * guard window means a reload won't help, so the error is left to reach the error screen.
 */

const RELOADED_AT_KEY = "sev1.staleBuildReloadAt";
const GUARD_MS = 30_000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Page = Pick<Window, "addEventListener"> & { readonly location: Pick<Location, "reload"> };

export function reloadOnStaleBuild(target: Page, storage: Storage | null, now: () => number = Date.now) {
  target.addEventListener("vite:preloadError", (event) => {
    // Without storage there's no way to tell a first failure from a reload loop, so don't try.
    if (!storage) return;
    try {
      if (now() - Number(storage.getItem(RELOADED_AT_KEY) ?? 0) < GUARD_MS) return;
      storage.setItem(RELOADED_AT_KEY, String(now()));
    } catch {
      return;
    }
    event.preventDefault();
    target.location.reload();
  });
}
