import type { FeedItem } from "../types.js";

/** What the ⛏ tools toggle hides: the mechanics of a run, never what an agent says. Reasoning stays
 *  visible because Opus 5.5 writes its progress narration inside thinking blocks. */
export function isToolActivity(item: FeedItem): boolean {
  return item.kind === "tool" || item.kind === "tool_result";
}
