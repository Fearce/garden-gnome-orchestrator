import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
  className?: string;
}

interface State {
  error: Error | null;
}

function chunkLoadFailed(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(message);
}

export class LazyChunkBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (!chunkLoadFailed(error)) return;
    try {
      const key = `ggo-lazy-reload:${this.props.label}:${__BUILD_SHA__}`;
      if (sessionStorage.getItem(key) === "1") return;
      sessionStorage.setItem(key, "1");
      window.location.reload();
    } catch {
      // If storage is unavailable, fall through to the visible refresh affordance instead of looping.
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.className ?? "lazy-error"} role="alert">
        <div className="lazy-error-card">
          <strong>{this.props.label} did not load.</strong>
          <p>Refresh to load the current console bundle.</p>
          <button className="btn sm" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </div>
    );
  }
}
