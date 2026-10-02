import type { DirectorSharingDTO, SharedDirectorAvailability } from "../types.js";

/** The browser's own IANA zone: the zone a deadline typed into a date/time field is read in. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A deadline with its zone spelled out, e.g. "Fri 2 Oct, 14:30 CEST". `timeZone` defaults to the browser's. */
export function formatDeadline(ms: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(ms);
  }
}

/** "in 2 h 5 min" / "in 40 s"; "now" once it has passed. */
export function timeLeft(ms: number, now = Date.now()): string {
  const left = ms - now;
  if (left <= 0) return "now";
  const min = Math.floor(left / 60_000);
  if (min < 1) return `in ${Math.ceil(left / 1000)} s`;
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  if (days) return `in ${days} d ${hours} h`;
  if (hours) return `in ${hours} h ${mins} min`;
  return `in ${mins} min`;
}

/** Epoch ms as the value of an `<input type="datetime-local">`, in the browser's zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value read in the browser's zone, as epoch ms (NaN when empty or invalid). */
export function fromLocalInput(value: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

/** A ready reason for the share form to refuse before sending. The server re-checks every one. */
export function deadlineProblem(ms: number, now = Date.now()): string | null {
  if (!Number.isFinite(ms)) return "Pick a deadline.";
  if (ms < now + 60_000) return "The deadline must be at least a minute in the future.";
  if (ms > now + 30 * 24 * 60 * 60_000) return "The deadline can be at most 30 days away.";
  return null;
}

/** Why sharing cannot work from this console right now, or null when it can. */
export function relayProblem(relay: DirectorSharingDTO["relay"]): string | null {
  if (relay === "office-offline") return "Join the online office (Settings > Office) to share or use a Director.";
  if (relay === "relay-unsupported") return "The office relay does not support Director sharing yet. It needs the relay update deployed.";
  return null;
}

export function availabilityLabel(state: SharedDirectorAvailability): string {
  switch (state) {
    case "available": return "Available";
    case "busy": return "Busy";
    case "expired": return "Expired";
    case "withdrawn": return "No longer shared";
    case "donor-offline": return "Donor offline";
    case "office-offline": return "Office offline";
    case "relay-unsupported": return "Relay not updated";
  }
}
