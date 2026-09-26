import { apiUrl } from "./base.js";
import { useStore } from "../store.js";

// Poll the server's git-update status so the top-bar badge knows when the checkout is behind its
// upstream. Strictly read-only — applying the update is user-initiated (a badge click → applyGitUpdate
// in the store). Every few minutes (and on tab focus) is plenty; the server caches/throttles the fetch.
const POLL_MS = 3 * 60_000;

export function startUpdateWatch(): void {
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const res = await fetch(apiUrl("/api/update/status"), { cache: "no-store" });
      if (!res.ok) return;
      const s = (await res.json()) as {
        behind?: number;
        branch?: string | null;
        remoteSubject?: string | null;
        blockedBy?: string[];
      };
      const behind = s.behind ?? 0;
      useStore.getState().setGitUpdate({
        available: behind > 0,
        behind,
        branch: s.branch ?? null,
        remoteSubject: s.remoteSubject ?? null,
        blockedBy: s.blockedBy ?? [],
      });
    } catch {
      /* offline / transient — keep the last-known state and try again next tick */
    } finally {
      checking = false;
    }
  };
  void check();
  setInterval(() => void check(), POLL_MS);
  window.addEventListener("focus", () => void check());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
}
