import type { Session } from "electron";

export type Reachability = "ggo" | "other" | "none";

/**
 * Ask the address whether a GGO server is there. `/api/me` is the probe because every build answers it
 * without a session, including through a remote link that gates every other route, and its shape is
 * GGO's own: a different program squatting the port answers something else and reads as "other".
 * Goes through the window's session so proxies and certificates behave exactly as the page will.
 */
export async function probeServer(session: Session, server: string, timeoutMs = 3_000): Promise<Reachability> {
  let response: Response;
  try {
    response = await session.fetch(new URL("api/me", server).href, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "none";
  }
  return (await isGgoAnswer(response)) ? "ggo" : "other";
}

/** Whether a `/api/me` response is GGO's. */
export async function isGgoAnswer(response: Response): Promise<boolean> {
  if (response.status !== 200 && response.status !== 403) return false;
  let body: { authed?: unknown; error?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return false;
  }
  if (response.status === 200) return typeof body.authed === "boolean";
  // A remote link without Google sign-in configured refuses everything with this 403
  // (server/src/remoteAccess.ts); it is still GGO. Any other 403 is somebody else's.
  return typeof body.error === "string" && body.error.startsWith("remote access needs Google sign-in");
}
