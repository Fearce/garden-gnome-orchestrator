// The console is served either at an origin root (https://localhost:4319/, the local iframe)
// OR under a path prefix when reverse-proxied behind a hostname
// (e.g. https://example.com/orchestrator/). Vite `base: "./"` keeps ASSET urls relative so
// they resolve under either mount; this module does the same for the API + WebSocket urls, which live
// in JS and would otherwise be hard-coded to the origin root and 404 behind the proxy.
//
// `document.baseURI` reflects where index.html was actually served from, so `new URL(".", baseURI)`
// yields "/" at the root and "/orchestrator/" behind the proxy — no build-time base needed.
const MOUNT = new URL(".", document.baseURI).pathname;

/** An API URL relative to wherever the app is mounted. Accepts "/api/x" or "api/x". */
export function apiUrl(path: string): string {
  return MOUNT + path.replace(/^\//, "");
}

/** The /ws WebSocket URL under the current mount (wss on https). */
export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${MOUNT}ws`;
}
