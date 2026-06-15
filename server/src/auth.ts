import { config } from "./config.js";

export const AUTH_COOKIE = "orch_auth";

export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** True when auth is disabled (no AUTH_TOKEN) or the request carries the valid cookie. */
export function isAuthed(cookieHeader: string | undefined): boolean {
  if (!config.authToken) return true;
  return cookieValue(cookieHeader, AUTH_COOKIE) === config.authToken;
}
