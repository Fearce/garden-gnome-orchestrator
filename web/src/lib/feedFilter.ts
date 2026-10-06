import type { FeedItem } from "../types.js";

/** What the ⛏ tools toggle hides: the mechanics of a run, never what an agent says. Reasoning stays
 *  visible because Opus 5.5 writes its progress narration inside thinking blocks. */
export function isToolActivity(item: FeedItem): boolean {
  return item.kind === "tool" || item.kind === "tool_result";
}

const QA_LIFECYCLE_LINES = [
  /^\[delivered\] RI-[a-f0-9]{8} reached active qa run [a-f0-9]{8}; its verdict is held until the instruction is acknowledged and acted on\.$/,
  /^\u21aa RI-[a-f0-9]{8} survived the server restart; prior QA delivery is no longer claimed, and the next QA run will receive it with its attachments\.$/,
  /^\u29d7 RI-[a-f0-9]{8} survived the server restart and is queued for the next implementor run; it is not claimed as delivered to the dead one\.$/,
];

/** Old QA bookkeeping stays in history, but should not bury owner instructions on every deploy.
 * Match only the generated system lines, never agent prose, owner text or attachment-bearing rows. */
export function isQaLifecycleNoise(item: FeedItem): boolean {
  if (item.kind !== "system" || item.role !== "director" || item.attachments?.length) return false;
  return QA_LIFECYCLE_LINES.some((pattern) => pattern.test(item.text));
}
