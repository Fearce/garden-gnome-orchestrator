import type { ImplementationMemo } from "./types.js";

/** Merge authoritative history with live rows by stable memo id. `updatedAt` resolves a reconnect race:
 * a late history response must not overwrite a newer deliverable refresh that already streamed live. */
export function mergeImplementationMemos(
  existing: readonly ImplementationMemo[],
  incoming: readonly ImplementationMemo[],
): ImplementationMemo[] {
  const byId = new Map(existing.map((memo) => [memo.id, memo]));
  for (const memo of incoming) {
    const prior = byId.get(memo.id);
    // Equal clocks keep the already-rendered row. Server writes are strictly monotonic, so equality
    // means duplicate delivery; retaining local state also prevents an equal-time stale history row
    // from erasing a live event during reconnect.
    if (!prior || memo.updatedAt > prior.updatedAt) byId.set(memo.id, memo);
  }
  return [...byId.values()].sort((a, b) => a.revision - b.revision || a.createdAt - b.createdAt);
}

export interface ImplementationMemoSelection {
  current: ImplementationMemo | null;
  latestUseful: ImplementationMemo | null;
  featured: ImplementationMemo | null;
}

/** Feature the newest actual completion. If the newest attempt failed/interrupted, keep that warning
 * visible as `current` while the preceding useful completion remains one click away. */
export function selectImplementationMemos(memos: readonly ImplementationMemo[]): ImplementationMemoSelection {
  const ordered = [...memos].sort((a, b) => a.revision - b.revision || a.createdAt - b.createdAt);
  const current = ordered.at(-1) ?? null;
  const latestUseful = [...ordered].reverse().find((memo) => memo.outcome === "completed" && !!memo.report?.trim()) ?? null;
  return { current, latestUseful, featured: latestUseful ?? current };
}
