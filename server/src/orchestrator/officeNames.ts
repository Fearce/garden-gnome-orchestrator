import { agentKey, type Role } from "../types.js";

export const OFFICE_NAME_MAX = 24;

/** One live agent as the uniqueness pass sees it. */
export interface LiveAgentRef {
  threadId: string;
  role: Role;
  startedAt: number;
}

/** Normalise an agent's self-chosen name; "" when nothing usable is left. */
export function cleanOfficeName(raw: string): string {
  return raw
    .replace(/[`*_"]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, OFFICE_NAME_MAX)
    .trim();
}

/** `preferred` if nobody in `taken` holds it (case-insensitively), else the first free "<name> 2", "<name> 3", … */
export function firstFreeName(preferred: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(preferred.toLowerCase())) return preferred;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${preferred.slice(0, OFFICE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Re-derive name uniqueness across the live set: walking in seniority order (earliest start first) so
 * whoever has used a name longest keeps it, a later agent whose self-picked name is already held by a
 * live agent — or by one of its own task's other roles — gets a numbered variant. Agents that have not
 * named themselves yet are skipped. Returns only the keys whose stored name must change.
 */
export function resolveLiveNameCollisions(live: readonly LiveAgentRef[], names: Readonly<Record<string, string>>): Map<string, string> {
  const ordered = live
    .map((l) => ({ ...l, key: agentKey(l.threadId, l.role) }))
    .filter((l) => names[l.key])
    .sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  const used = new Set<string>();
  const changes = new Map<string, string>();
  for (const l of ordered) {
    const taskMates = Object.entries(names)
      .filter(([k]) => k.startsWith(`${l.threadId}::`) && k !== l.key)
      .map(([, v]) => v);
    const chosen = firstFreeName(names[l.key]!, new Set([...used, ...taskMates]));
    used.add(chosen);
    if (chosen !== names[l.key]) changes.set(l.key, chosen);
  }
  return changes;
}
