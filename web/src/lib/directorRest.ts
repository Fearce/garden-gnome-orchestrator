import { useEffect, useState } from "react";

export type DirectorRest = "chair" | "sleep";
export const DIRECTOR_BEDTIME_MS = 8 * 60 * 60 * 1000;

export function directorRest(busy: boolean, idleSince: number | null, now = Date.now()): DirectorRest | undefined {
  if (busy) return undefined;
  return idleSince != null && now - idleSince >= DIRECTOR_BEDTIME_MS ? "sleep" : "chair";
}

/** One deadline, not a polling clock. The server owns idle time across reloads and restarts. */
export function useDirectorRest(busy: boolean, idleSince: number | null, enabled: boolean) {
  const [, wake] = useState(0);
  useEffect(() => {
    if (!enabled || busy || idleSince == null) return;
    const remaining = idleSince + DIRECTOR_BEDTIME_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => wake((v) => v + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [busy, idleSince, enabled]);
  return directorRest(busy, idleSince);
}
