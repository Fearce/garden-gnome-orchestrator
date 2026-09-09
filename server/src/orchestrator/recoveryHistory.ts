import type { Message } from "../types.js";

const MAX_HISTORY_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 3_000;

function clipped(content: string): string {
  const value = content.trim();
  if (value.length <= MAX_MESSAGE_CHARS) return value;
  return `${value.slice(0, MAX_MESSAGE_CHARS)}\n[…message clipped…]`;
}

/** Bounded durable conversation context for a fresh session replacing an unavailable provider rollout. */
export function recoveryHistoryBlock(messages: Message[]): string {
  const candidates = messages
    .filter((message) => (message.kind === "text" || message.kind === "system") && message.content.trim())
    .map((message) => `[${message.role}/${message.kind}]\n${clipped(message.content)}`);
  const selected: string[] = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const item = candidates[i]!;
    if (selected.length && chars + item.length > MAX_HISTORY_CHARS) break;
    selected.push(item);
    chars += item.length;
  }
  if (!selected.length) return "";
  return [
    "## Durable task history recovered from the server",
    "The previous provider rollout is unavailable. Continue from this recent persisted conversation and the current working tree; do not redo completed work.",
    ...selected.reverse(),
  ].join("\n\n");
}
