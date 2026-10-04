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
  // A remote link without Google sign-in configured refuses everything with 403; it is still GGO.
  if (response.status === 401 || response.status === 403) return "ggo";
  if (!response.ok) return "other";
  try {
    const body = (await response.json()) as { authed?: unknown };
    return typeof body.authed === "boolean" ? "ggo" : "other";
  } catch {
    return "other";
  }
}
