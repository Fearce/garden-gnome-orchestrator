import type { ThreadSummary } from "../types.js";

/** Keep the complete sortable task index; defer old cards' text and checkout details until visible.
 * Optional null/default fields carry no information and otherwise repeat hundreds of times. */
export function compactBoardThread(thread: ThreadSummary): ThreadSummary {
  const compact = Object.fromEntries(Object.entries(thread).filter(([, value]) =>
    value != null && (!Array.isArray(value) || value.length > 0),
  )) as ThreadSummary;
  if (!["done", "closed", "cancelled"].includes(thread.state)) return compact;
  const { worktrees, ...index } = compact;
  return { ...index, briefPreview: "", latestMessagePreview: "", summaryDeferred: true };
}
