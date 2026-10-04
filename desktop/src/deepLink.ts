import { isThreadId } from "./serverUrl";

/** The scheme the web console's "Open in desktop" button and the browser sign-in handoff launch. */
export const PROTOCOL = "ggo";

/** 32 random bytes, base64url: the shape server/src/desktop.ts mints. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export function isTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET.test(value);
}

export type DeepLink =
  | { kind: "open"; thread: string | null; ticket: string | null }
  | { kind: "auth"; ticket: string };

/**
 * Parse a `ggo://open?thread=…&ticket=…` or `ggo://auth?ticket=…` link. Any page on the internet can
 * launch the scheme, so everything is validated here and a malformed part drops the whole link rather
 * than being passed on: a ticket only signs in if the configured server minted it, and a thread id only
 * selects a task the signed-in console already has.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;
  const ticket = url.searchParams.get("ticket");
  const thread = url.searchParams.get("thread");
  if (ticket !== null && !isTicket(ticket)) return null;
  if (thread !== null && !isThreadId(thread)) return null;
  const action = url.hostname || url.pathname.replace(/^\/+|\/+$/g, "");
  if (action === "open") return { kind: "open", thread, ticket };
  if (action === "auth" && ticket) return { kind: "auth", ticket };
  return null;
}

/** On Windows and Linux a launched link arrives as a command-line argument of the new process. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${PROTOCOL}://`)) ?? null;
}
