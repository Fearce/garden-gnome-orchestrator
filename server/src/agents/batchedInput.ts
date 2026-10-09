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
 * The bound keeps every owner-steering entry verbatim, fills the remaining budget with the NEWEST ambient
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
}

function isOwnerSteering(text: string): boolean {
  return text.includes(`[${OWNER_STEERING_TAG}`);
}

/** Join queued follow-ups in arrival order, within `budget` characters where the batch allows it. */
export function boundBatchedInput(texts: readonly string[], budget = BATCHED_INPUT_BUDGET_CHARS): BoundedBatch {
  const entries = texts.filter(Boolean);
  const whole = entries.join(SEPARATOR);
  if (whole.length <= budget) return { text: whole, omitted: 0, omittedChars: 0 };

  const keep = new Array<boolean>(entries.length).fill(false);
  let used = 0;
  entries.forEach((text, i) => {
    if (!isOwnerSteering(text)) return;
    keep[i] = true;
    used += text.length + SEPARATOR.length;
  });
  // Newest ambient entries first: the latest office state is what the agent can still act on.
  let full = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    const cost = entries[i]!.length + SEPARATOR.length;
    if (full || used + cost > budget) {
      full = true;
      continue;
    }
    keep[i] = true;
    used += cost;
  }
  let omitted = 0;
  let omittedChars = 0;
  entries.forEach((text, i) => {
    if (keep[i]) return;
    omitted++;
    omittedChars += text.length;
  });
  if (!omitted) return { text: whole, omitted: 0, omittedChars: 0 };
  const notice =
    `[GGO: ${omitted} older queued update${omitted === 1 ? "" : "s"} (${omittedChars.toLocaleString("en-US")} characters of office chat and status notices) arrived while your last turn ran and ${omitted === 1 ? "was" : "were"} left out to keep this turn under the provider's input limit. ` +
    "Owner steering is never left out. The newest updates follow in arrival order.]";
  return { text: [notice, ...entries.filter((_, i) => keep[i])].join(SEPARATOR), omitted, omittedChars };
}
