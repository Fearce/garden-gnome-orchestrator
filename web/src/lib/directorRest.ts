import { useEffect, useState } from "react";

export type DirectorRest = "chair" | "sleep";
/** AFK this long and the director takes a chair; this long and it goes to bed. A skip-director send is
 *  not director work, so it never resets the clock. */
export const DIRECTOR_CHAIR_MS = 30 * 60 * 1000;
export const DIRECTOR_BEDTIME_MS = 4 * 60 * 60 * 1000;

/** Standing while it works or has only just stopped; an unknown idle clock stands rather than guess. */
export function directorRest(busy: boolean, idleSince: number | null, now = Date.now()): DirectorRest | undefined {
  if (busy || idleSince == null) return undefined;
  const afk = now - idleSince;
  return afk >= DIRECTOR_BEDTIME_MS ? "sleep" : afk >= DIRECTOR_CHAIR_MS ? "chair" : undefined;
}

/** When the pose next changes on its own, or null when only a busy event can change it. */
export function directorRestChangesAt(busy: boolean, idleSince: number | null, now = Date.now()) {
  if (busy || idleSince == null) return null;
  const next = [idleSince + DIRECTOR_CHAIR_MS, idleSince + DIRECTOR_BEDTIME_MS].find((at) => at > now);
  return next ?? null;
}

/** One deadline per pose change, not a polling clock. The server owns idle time across reloads and restarts. */
export function useDirectorRest(busy: boolean, idleSince: number | null, enabled: boolean) {
  const [, wake] = useState(0);
  const changesAt = enabled ? directorRestChangesAt(busy, idleSince) : null;
  useEffect(() => {
    if (changesAt == null) return;
    const timer = window.setTimeout(() => wake((v) => v + 1), Math.max(0, changesAt - Date.now() + 30));
    return () => window.clearTimeout(timer);
  }, [changesAt]);
  return directorRest(busy, idleSince);
}
