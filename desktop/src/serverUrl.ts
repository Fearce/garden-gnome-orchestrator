/** The address `npm run serve` / `npm start` listens on (server PORT default, see server/src/config.ts). */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4317/";

const THREAD_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A GGO console address the desktop window may load: http(s) only, no embedded credentials, no query or
 * fragment, and a trailing slash so a mounted console (`https://example.com/orchestrator/`) stays one
 * base URL. A bare `host:port` is read as http. Returns null for anything else.
 */
export function normalizeServerUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** This machine, so a stopped server here is one the desktop app can offer to start. */
export function isLocalServer(server: string): boolean {
  const host = new URL(server).hostname;
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Whether `candidate` is a page of the console at `server`: same origin and inside its mount path. */
export function isServerPage(candidate: string, server: string): boolean {
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    return false;
  }
  const base = new URL(server);
  return target.origin === base.origin && target.pathname.startsWith(base.pathname);
}

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

/** The console's start page, optionally opening one task (web/src/lib/desktop.ts reads `?thread=`). */
export function consoleUrl(server: string, threadId?: string | null): string {
  const url = new URL(server);
  if (threadId && isThreadId(threadId)) url.searchParams.set("thread", threadId);
  return url.href;
}

/** The console path a desktop sign-in ticket is redeemed at (server/src/desktop.ts). */
export function redeemUrl(server: string, ticket: string, threadId?: string | null): string {
  const url = new URL("api/desktop/redeem", server);
  url.searchParams.set("ticket", ticket);
  if (threadId && isThreadId(threadId)) url.searchParams.set("thread", threadId);
  return url.href;
}

/** Where to probe whether a GGO server is answering. Unauthenticated, cheap, and present on every build. */
export function healthUrl(server: string): string {
  return new URL("api/health", server).href;
}
