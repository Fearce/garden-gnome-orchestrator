import type { FeedItem, Thread } from "../types.js";

/** The collaborator threads of a shotgun lead, oldest first. A collaborator has no board card of its
 *  own, so the lead's panel is the only place its work can be seen. */
export function collaboratorIdsOf(threads: Record<string, Thread>, leadId: string): string[] {
  return Object.values(threads)
    .filter((t) => t.parentId === leadId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => t.id);
}

export interface CollaboratorFeed {
  threadId: string;
  items: FeedItem[];
}

/** The lead's feed with every collaborator's rows interleaved by time. `sourceOf` records which
 *  collaborator wrote a row, so it is labelled with that agent's name rather than the lead's.
 *
 *  A collaborator's synthesized `brief:` row is dropped: it is the planner-written assignment, and in
 *  the lead's feed it would render as a director message the owner never wrote. The agents strip
 *  already shows each share. */
export function mergeCollaboratorFeeds(
  lead: FeedItem[],
  collaborators: CollaboratorFeed[],
  floor?: number,
): { items: FeedItem[]; sourceOf: Map<FeedItem, string> } {
  const sourceOf = new Map<FeedItem, string>();
  if (!collaborators.length) return { items: lead, sourceOf };
  const items = floor === undefined ? [...lead] : lead.filter((f) => f.at >= floor || isBrief(f));
  for (const c of collaborators) {
    for (const item of c.items) {
      if (isBrief(item)) continue;
      if (floor !== undefined && item.at < floor) continue;
      sourceOf.set(item, c.threadId);
      items.push(item);
    }
  }
  // Stable sort: rows with the same timestamp keep lead-first, then collaborator order.
  items.sort((a, b) => a.at - b.at);
  return { items, sourceOf };
}

/** Where the merged timeline is complete. History pages hold a fixed number of MESSAGES, so a busy
 *  agent's newest page spans minutes while a quiet one's spans hours. Below the newest "oldest loaded
 *  row" among feeds that still have older pages, only the quiet agent would show, which reads as the
 *  busy one having said nothing. Rows under this floor wait until "Load earlier history" fills it. */
export function historyFloor(feeds: { items: FeedItem[]; hasMore: boolean }[]): number | undefined {
  let floor: number | undefined;
  for (const f of feeds) {
    if (!f.hasMore) continue;
    let oldest = Infinity;
    for (const item of f.items) if (!isBrief(item) && item.at < oldest) oldest = item.at;
    if (oldest !== Infinity && (floor === undefined || oldest > floor)) floor = oldest;
  }
  return floor;
}

const isBrief = (f: FeedItem): boolean => f.kind === "system" && !!f.id?.startsWith("brief:");
