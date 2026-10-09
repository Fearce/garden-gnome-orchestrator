/**
 * Bounded follow-up batching for the CLI backends (Codex, Grok).
 *
 * A CLI run cannot accept input mid-turn, so every send that arrives while a turn is busy is queued and
 * the queue becomes the next turn's prompt. Codex turns here routinely run for hours, and a busy shared
 * repo pushes every office post into every live implementor: on 2026-10-08 one queued batch reached
 * 956,965 characters (about 200 office posts, each with its own chat preview and communication-policy
 * frame), and the next ones were refused outright by Codex's `turn/start` limit of 1,048,576 characters
 * (`input_too_large`), killing tasks after 2–9 hours of work.
 *
 * The bound keeps every required entry verbatim, fills the remaining budget with the NEWEST ambient
 * entries (office chat, notices), and names what it left out, so nothing disappears silently. Owner text
 * is never truncated: if steering alone is over the limit, the provider's own refusal still surfaces.
 */

/** Only the orchestrator emits this marker; `neutralizeSteeringMarkers` escapes it in peer text.
 *  Re-exported by `orchestrator/injection.ts`, which owns the steering frame. */
export const OWNER_STEERING_TAG = "OWNER STEERING";

/** Codex's `turn/start` refuses input longer than this many characters (`input_too_large`). */
export const CODEX_TURN_INPUT_MAX_CHARS = 1_048_576;

/** The share of a turn the queued follow-ups may take, leaving room for recall, the question doctrine
 *  and the resume-as-fresh kickoff that can be folded in front of them. */
export const BATCHED_INPUT_BUDGET_CHARS = 600_000;

const SEPARATOR = "\n\n";

export interface BoundedBatch {
  text: string;
  /** Ambient entries left out of `text`; 0 when the whole batch fit. */
  omitted: number;
  omittedChars: number;
  /** Original entry indexes whose text/attachments may receive a provider consumption receipt. */
  keptIndexes: number[];
}

export interface BatchedInputEntry {
  text: string;
  /** Only explicit peer chat/status may be omitted. Untagged owner/control input stays required. */
  ambient?: boolean;
}

function omissionNotice(omitted: number, chars: number): string {
  return `[GGO: ${omitted} older queued update${omitted === 1 ? "" : "s"} (${chars.toLocaleString("en-US")} characters of office chat and status notices) arrived while your last turn ran and ${omitted === 1 ? "was" : "were"} left out to keep this turn under the provider's input limit. ` +
    "Required inputs, including owner steering, are never left out. The newest updates follow in arrival order.]";
}

/** Bound only explicitly ambient messages. Required inputs can exceed the budget, never be truncated. */
export function boundBatchedInput(entries: readonly BatchedInputEntry[], budget = BATCHED_INPUT_BUDGET_CHARS): BoundedBatch {
  const joinEntries = (indexes: number[]) => indexes.map((i) => entries[i]!.text).filter(Boolean).join(SEPARATOR);
  const allIndexes = entries.map((_, i) => i);
  const whole = joinEntries(allIndexes);
  if (whole.length <= budget) return { text: whole, omitted: 0, omittedChars: 0, keptIndexes: allIndexes };

  const keep = new Array<boolean>(entries.length).fill(false);
  let ambientCount = 0;
  let ambientChars = 0;
  entries.forEach((entry, i) => {
    // Receipts can bind owner text without a steering frame. Never discard their actual input.
    keep[i] = entry.ambient !== true || entry.text.includes(`[${OWNER_STEERING_TAG}`) || entry.text.includes("[GGO receipt");
    if (!keep[i]) { ambientCount++; ambientChars += entry.text.length; }
  });
  if (!ambientCount) return { text: whole, omitted: 0, omittedChars: 0, keptIndexes: allIndexes };
  const required = joinEntries(allIndexes.filter((i) => keep[i]));
  // Reserve the longest possible notice before choosing entries, including singular/plural wording.
  const noticeReserve = Math.max(omissionNotice(1, ambientChars).length, omissionNotice(ambientCount, ambientChars).length) + SEPARATOR.length;
  let used = required.length;
  let hasText = !!required;
  // Newest ambient entries first: the latest office state is what the agent can still act on.
  let full = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    const text = entries[i]!.text;
    const cost = text.length + (hasText && text ? SEPARATOR.length : 0);
    if (full || used + cost + noticeReserve > budget) {
      full = true;
      continue;
    }
    keep[i] = true;
    used += cost;
    hasText ||= !!text;
  }
  let omitted = 0;
  let omittedChars = 0;
  entries.forEach((entry, i) => {
    if (keep[i]) return;
    omitted++;
    omittedChars += entry.text.length;
  });
  const keptIndexes = allIndexes.filter((i) => keep[i]);
  const text = joinEntries(keptIndexes);
  const notice = omissionNotice(omitted, omittedChars);
  // An almost-full required recovery kickoff may leave no space even for the notice. The runner still
  // reports the omission in the feed; avoid making otherwise valid required input exceed the limit.
  const withNotice = [notice, text].filter(Boolean).join(SEPARATOR);
  return { text: withNotice.length <= budget ? withNotice : text, omitted, omittedChars, keptIndexes };
}
