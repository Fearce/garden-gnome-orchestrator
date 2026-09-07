import { apiUrl } from "./base.js";

export async function coordinatedRestartPending(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl("/api/deploy/status"), { cache: "no-store" });
    if (!res.ok) return false;
    const status = (await res.json()) as { pending?: unknown };
    return !!status.pending;
  } catch {
    return false;
  }
}
