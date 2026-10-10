import { Component, type ReactNode } from "react";

type Props = { readonly children: ReactNode; readonly onLeave: () => void };
type State = { readonly error: Error | null };

/**
 * Keeps a failure inside the office (a chunk that won't load, a bug in the 3D scene) from
 * unmounting the whole app: the player sees what broke and how to get out, and the app around
 * it, room connection included, stays up.
 */
export class OfficeErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="paged office-error" role="alert">
        <h1 className="paged__title">The office didn’t load</h1>
        <p className="paged__brief">
          Something broke on our side, and it isn’t your connection. Reloading usually fixes it; if you were in a room, join it again with the same code.
        </p>
        <p className="office-error__detail">{error.message}</p>
        <div className="office-error__actions">
          <button type="button" className="button button--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              this.setState({ error: null });
              this.props.onLeave();
            }}
          >
            Back to the lobby
          </button>
        </div>
      </main>
    );
  }
}
