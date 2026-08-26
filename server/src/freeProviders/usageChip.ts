import type { ProviderConnectionState, ProviderUsageSnapshot } from "./types.js";

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}K`;
  return value < 10 && !Number.isInteger(value) ? value.toFixed(2) : String(Math.round(value));
}

function valueLabel(value: number, unit?: string): string {
  return unit?.toLowerCase().includes("usd") ? `$${value.toFixed(value < 1 ? 2 : 1)}` : compact(value);
}

export function formatUsageChip(input: {
  usage: ProviderUsageSnapshot;
  state: ProviderConnectionState;
  configured: boolean;
  optionalCredential: boolean;
}): string {
  const { usage, state } = input;
  if (!input.configured && !input.optionalCredential) return "Quota · awaiting auth";
  if (state === "quota-exhausted") return "Quota exhausted · 0 left";
  if (state === "rate-limited") return "Rate limited · retry later";
  if (usage.quotaKind === "prototype") return "Free prototype · cap not exposed";
  const estimate = usage.estimated ? "~" : "";
  if (usage.remaining != null && usage.limit != null) {
    return `${estimate}${valueLabel(usage.remaining, usage.unit)} / ${valueLabel(usage.limit, usage.unit)} ${usage.unit ?? "quota"} left`;
  }
  if (usage.used != null) return `${estimate}${valueLabel(usage.used, usage.unit)} ${usage.unit ?? "quota"} used`;
  if (usage.limit != null) return `${estimate}${valueLabel(usage.limit, usage.unit)} ${usage.unit ?? "allowance"} · balance external`;
  if (input.optionalCredential) return "Anonymous quota · local estimate";
  return usage.stale ? "Quota signal stale" : "Quota · not exposed";
}
