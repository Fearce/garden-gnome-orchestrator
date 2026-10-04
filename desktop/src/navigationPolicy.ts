import { isServerPage } from "./serverUrl";

/** The desktop app's own pages (connection screen), served by the `ggo-app` protocol handler. */
export const APP_SCHEME = "ggo-app";
const APP_HOST = "shell";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export type Navigation =
  /** Stay in the window: a console page, or the app's own connection screen. */
  | "allow"
  /** Leave GGO: hand the link to the system browser. */
  | "external"
  /** Google refuses embedded sign-in, so the desktop app signs in through the system browser instead. */
  | "browser-sign-in"
  | "deny";

export type WindowOpen = "child" | "external" | "deny";

function parse(target: string): URL | null {
  try {
    return new URL(target);
  } catch {
    return null;
  }
}

function isExternalScheme(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
}

/** Node's URL gives a custom scheme an opaque origin ("null"), so the scheme and host are compared. */
function isAppUrl(url: URL | null): boolean {
  return !!url && url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
}

export function isAppPage(target: string): boolean {
  return isAppUrl(parse(target));
}

/** What a top-level navigation (link, form, redirect) in the main window may do. */
export function classifyNavigation(target: string, server: string): Navigation {
  const url = parse(target);
  if (!url) return "deny";
  if (isServerPage(target, server)) return url.pathname.endsWith("/api/auth/google") ? "browser-sign-in" : "allow";
  if (isAppUrl(url)) return "allow";
  return isExternalScheme(url) ? "external" : "deny";
}

/** What `window.open` / `target="_blank"` may do: a console page (a deliverable preview) opens in a
 *  locked-down child window that shares the session; anything else leaves for the system browser. */
export function classifyWindowOpen(target: string, server: string): WindowOpen {
  const url = parse(target);
  if (!url) return "deny";
  if (isServerPage(target, server)) return "child";
  return isExternalScheme(url) ? "external" : "deny";
}

/** Browser permissions the console uses: completion alerts, the copy buttons, remote-control fullscreen.
 *  Everything else (camera, microphone, geolocation, HID, …) is refused. */
const CONSOLE_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);

/** Permission checks report only an origin, so the console's origin (not its mount path) is the test. */
export function permissionAllowed(permission: string, requestingUrl: string, server: string): boolean {
  return CONSOLE_PERMISSIONS.has(permission) && parse(requestingUrl)?.origin === new URL(server).origin;
}
