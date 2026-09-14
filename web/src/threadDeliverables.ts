import type { Finding } from "./types.js";

/**
 * Merge a task's durable file findings by database identity. History replies can race a just-streamed
 * bridge/tool event, so a reply must never erase that newer live card. Unlike activity, this index is
 * deliberately uncapped: every row has an owner-addressable View/Download action.
 */
export function mergeThreadDeliverables(existing: Finding[], incoming: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of existing) if (finding.kind === "deliverable") byId.set(finding.id, finding);
  for (const finding of incoming) if (finding.kind === "deliverable") byId.set(finding.id, finding);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function deliverablesByThread(findings: Finding[]): Record<string, Finding[]> {
  const grouped: Record<string, Finding[]> = {};
  for (const finding of findings) {
    if (finding.kind !== "deliverable") continue;
    grouped[finding.threadId] = mergeThreadDeliverables(grouped[finding.threadId] ?? [], [finding]);
  }
  return grouped;
}

/** A board hello is intentionally bounded, so reconnect it into—not over—the already-open task index. */
export function mergeDeliverableIndexes(
  existing: Record<string, Finding[]>,
  incoming: Record<string, Finding[]>,
): Record<string, Finding[]> {
  const merged = { ...existing };
  for (const [threadId, findings] of Object.entries(incoming)) {
    merged[threadId] = mergeThreadDeliverables(merged[threadId] ?? [], findings);
  }
  return merged;
}
