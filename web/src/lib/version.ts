import { apiUrl } from "./base.js";
import { useStore } from "../store.js";

// Self-update: a deploy rebuilds the bundle (new content-hashed JS filename) and restarts the
// server, but an already-open tab or the always-on Dashboard-Deck kiosk keeps running the old code
// forever — the recurring "I deployed the fix but my view is still broken" trap. This polls the
// server's current bundle hash and reloads when it no longer matches the one this page loaded, so an
// open client picks up a deploy on its own within a minute (and instantly when refocused).

function loadedBundle(): string | null {
  // index.html loads exactly one module entry: <script type="module" src="./assets/index-<hash>.js">.
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return el ? (el.src.split("/").pop() ?? null) : null;
}

/** Don't reload out from under someone mid-typing — losing a half-written inject/brief is worse than
 *  running stale for one more poll. Defers the reload to the next tick once the field is idle. */
function isUserTyping(): boolean {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (tag === "TEXTAREA" || tag === "INPUT") && !!el.value && el.value.trim().length > 0;
}

export function startVersionWatch(): void {
  const loaded = loadedBundle();
  if (!loaded) return; // dev (Vite) or an unexpected shell — nothing to compare against
  let reloading = false;
  const check = async (): Promise<void> => {
    if (reloading || document.hidden) return;
    try {
      const res = await fetch(apiUrl("/api/version"), { cache: "no-store" });
      if (!res.ok) return;
      const { web } = (await res.json()) as { web?: string | null };
      if (!web || web === loaded) return;
      // A newer build is live. Surface the quiet top-bar badge regardless of focus so an active
      // operator can refresh on their own terms…
      useStore.getState().setUpdateReady(true);
      // …but don't yank a half-written inject/brief out from under someone mid-typing: an idle tab
      // (incl. the always-on kiosk) still self-heals by reloading; a typing one keeps the badge up.
      if (isUserTyping()) return;
      reloading = true;
      location.reload();
    } catch {
      /* offline / transient — try again on the next tick */
    }
  };
  setInterval(check, 60_000);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
}
