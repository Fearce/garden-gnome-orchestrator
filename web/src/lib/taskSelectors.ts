import type { AgentRun, Finding, Thread } from "../types.js";

// Immutable store collections let all card subscribers share one index per collection revision.
// Weak keys release old snapshots; token deltas do not rebuild these fleet-wide indexes.
function grouped<T, C extends object>(rows: (collection: C) => readonly T[], key: (row: T) => string | undefined) {
  const cache = new WeakMap<C, Map<string, T[]>>();
  const empty: T[] = [];
  return (collection: C, id: string): readonly T[] => {
    let index = cache.get(collection);
    if (!index) {
      index = new Map();
      for (const row of rows(collection)) {
        const id = key(row);
        if (!id) continue;
        const group = index.get(id);
        if (group) group.push(row);
        else index.set(id, [row]);
      }
      cache.set(collection, index);
    }
    return index.get(id) ?? empty;
  };
}

export const taskRuns = grouped<AgentRun, Record<string, AgentRun>>(Object.values, (run) => run.threadId);
export const taskFindings = grouped<Finding, Finding[]>((findings) => findings, (finding) => finding.threadId);
export const taskChildren = grouped<Thread, Record<string, Thread>>(Object.values, (thread) => thread.parentId ?? undefined);

/** Pair with useShallow: updates belonging to other tasks keep every selected value identical. */
export function taskRecords<T>(records: Record<string, T>, ids: readonly string[]): Record<string, T> {
  const selected: Record<string, T> = {};
  for (const id of ids) if (records[id] !== undefined) selected[id] = records[id]!;
  return selected;
}
