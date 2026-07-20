import type { ChatScope } from "../types.js";

/**
 * CLI backends (Codex, Grok) have no office MCP tools. Implementors post by emitting a
 * `OFFICE[team|office]: <msg>` marker in assistant text; the runner intercepts it, strips it from the
 * task transcript, and posts through the real office chat backend.
 *
 * Matching is deliberately looser than "whole line only":
 * - Grok streaming-json often concatenates successive model turns WITHOUT newlines
 *   (`...done.OFFICE[team]: claiming fooI'll keep going`), so a `^...$` line regex silently drops posts.
 * - Models also copy the doctrine's backtick wrapping: `` `OFFICE[team]: msg` ``.
 * - Glued model turns after a claim (`claiming foo.Implementing bar…`) must NOT swallow the next turn
 *   into the chat body — end the body at a sentence-final punct glued to a capital letter, the next
 *   OFFICE marker, a newline, a hard length cap, or (when allowed) end-of-string.
 *
 * Completeness gate (`openEnded`):
 * - Grok streams tokens and interleaves `thought` events mid-answer. Harvesting on every thought with
 *   end-of-buffer-as-complete produced truncated team posts (`claimi`, literal `\n`) — Fen, 2026-07-20.
 * - Mid-segment harvests pass `openEnded: false` so a marker without a hard terminator stays in the
 *   buffer until more text arrives. Final flush (clean `end`) passes `openEnded: true`.
 *
 * Body is capped at {@link MAX_OFFICE_BODY} (coordination messages are one short line).
 */
// Only horizontal whitespace after the colon — `\s*` would eat the newline and pull the NEXT line into the body
// (`OFFICE[team]:\nAfter.` → body "After."), which both invents a post and steals transcript text.
const MARKER_RE = /`?OFFICE\[(team|office)\][ \t]*:[ \t]*/gi;
/** Soft cap — doctrine says office messages are a line or two; glued narration past this is not a claim. */
export const MAX_OFFICE_BODY = 280;

export interface ExtractOfficeChatOpts {
  /**
   * When true (default), a marker that runs to end-of-string is treated as complete (Codex whole
   * messages + Grok final flush). When false, an unterminated marker is left in `visible` so the
   * caller can accumulate more stream text — used for Grok mid-segment harvests.
   */
  openEnded?: boolean;
}

/**
 * Return how many characters of `text` starting at `i` belong to the office body (0 = stop before `i`).
 * Stops before the current index when a glued model-turn boundary is detected.
 */
function gluedTurnBoundaryAt(text: string, i: number, bodyStart: number): boolean {
  if (i <= bodyStart) return false;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  // "…services.Implementing…" / "…wiring.Next…" — sentence end with no space before the next turn.
  if (/[.!?…]/.test(prev) && /[A-Z]/.test(cur)) return true;
  // "…SCHEMA/HTMLImplementing…" — path-ish ALL-CAPS segment glued to a Capitalized word (no slash/space).
  // Require a `/` somewhere in the few chars before so plain `HTTPClient` claims still pass.
  if (/[A-Z]/.test(prev) && /[A-Z]/.test(cur) && /[a-z]/.test(text[i + 1] ?? "")) {
    const window = text.slice(Math.max(bodyStart, i - 24), i);
    if (/\/[A-Z]{2,}$/.test(window)) return true;
  }
  return false;
}

/** True when `body` is too junk-like to post (empty, lone escapes, control-only). */
export function isJunkOfficeBody(body: string): boolean {
  if (!body) return true;
  // Literal backslash-escapes the model sometimes emits as a "line" (`\n`, `\t`).
  if (/^\\[nrt]$/.test(body)) return true;
  // Pure punctuation / whitespace leftovers after trim.
  if (!/[A-Za-z0-9]/.test(body)) return true;
  return false;
}

export function extractOfficeChat(
  text: string,
  opts?: ExtractOfficeChatOpts,
): {
  visible: string;
  posts: Array<{ scope: ChatScope; body: string }>;
} {
  const openEnded = opts?.openEnded !== false;
  const posts: Array<{ scope: ChatScope; body: string }> = [];
  if (!text) return { visible: "", posts };

  let out = "";
  let cursor = 0;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const markerStart = m.index;
    const bodyStart = MARKER_RE.lastIndex;
    out += text.slice(cursor, markerStart);

    const taken = takeOfficeBody(text, bodyStart, openEnded);
    if (!taken.complete) {
      // Incomplete open marker — keep it (and everything after) in the buffer for more stream text.
      cursor = markerStart;
      MARKER_RE.lastIndex = text.length; // stop scanning
      break;
    }

    if (taken.body && !isJunkOfficeBody(taken.body)) {
      posts.push({
        scope: String(m[1]).toLowerCase() === "office" ? "general" : "project",
        body: taken.body,
      });
    }
    // Drop the marker (+ optional closing backtick); leave a newline so surrounding prose doesn't glue.
    // Junk / empty bodies still strip (don't leave `OFFICE[team]: \n` littering the transcript).
    out += "\n";
    cursor = taken.bodyEnd + (taken.trailingTick ? 1 : 0);
    MARKER_RE.lastIndex = cursor;
  }
  out += text.slice(cursor);

  // Mid-stream incomplete markers must keep exact trailing text (no trim) so the next token can
  // append. Final/open-ended extractions tidy whitespace for the transcript.
  const hasOpenMarker = !openEnded && endsWithOpenOfficeMarker(out);
  const visible = hasOpenMarker
    ? out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

  return { visible, posts };
}

/** Scan forward from `bodyStart` for the end of one office-bridge body. */
function takeOfficeBody(
  text: string,
  bodyStart: number,
  openEnded: boolean,
): { body: string; bodyEnd: number; trailingTick: boolean; complete: boolean } {
  const n = text.length;
  let i = bodyStart;
  let trailingTick = false;
  let complete = false;

  while (i < n) {
    const ch = text[i]!;

    // Hard stops: newline ends the marker line.
    if (ch === "\n" || ch === "\r") {
      complete = true;
      break;
    }

    // Optional closing backtick (model copied `` `OFFICE[team]: msg` ``).
    if (ch === "`") {
      trailingTick = true;
      complete = true;
      break;
    }

    // Next OFFICE marker — don't swallow it into this body.
    if (startsOfficeMarker(text, i)) {
      complete = true;
      break;
    }

    // Glued next model turn: stop before the capital so narration stays in the transcript.
    if (gluedTurnBoundaryAt(text, i, bodyStart)) {
      complete = true;
      break;
    }

    // Length cap: take up to MAX, then back off to a clean word boundary when possible.
    if (i - bodyStart >= MAX_OFFICE_BODY) {
      complete = true;
      break;
    }

    i++;
  }

  // Hit end-of-string without a hard terminator.
  if (!complete && i >= n) {
    complete = openEnded;
  }

  if (!complete) {
    return { body: "", bodyEnd: bodyStart, trailingTick: false, complete: false };
  }

  let bodyEnd = i;
  let body = text.slice(bodyStart, bodyEnd).trim();

  // If we hit the length cap mid-word, drop the incomplete trailing token so the chat stays readable.
  if (bodyEnd - bodyStart >= MAX_OFFICE_BODY && bodyEnd < n && !/\s/.test(text[bodyEnd] ?? " ")) {
    const lastSpace = body.lastIndexOf(" ");
    if (lastSpace > 40) {
      body = body.slice(0, lastSpace).trim();
      bodyEnd = bodyStart + text.slice(bodyStart, bodyEnd).lastIndexOf(" ");
    }
  }

  // Cap again after trim (leading spaces after the colon).
  if (body.length > MAX_OFFICE_BODY) body = body.slice(0, MAX_OFFICE_BODY).trim();

  return { body, bodyEnd, trailingTick, complete: true };
}

function startsOfficeMarker(text: string, i: number): boolean {
  // Optional leading backtick, then OFFICE[team|office]
  let j = i;
  if (text[j] === "`") j++;
  const slice = text.slice(j, j + 14).toLowerCase();
  return slice.startsWith("office[team]") || slice.startsWith("office[office]");
}

/** True when `text` ends with an OFFICE marker whose body has no hard terminator yet. */
export function endsWithOpenOfficeMarker(text: string): boolean {
  if (!text) return false;
  MARKER_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) last = m;
  if (!last) return false;
  const bodyStart = last.index + last[0].length;
  const taken = takeOfficeBody(text, bodyStart, false);
  return !taken.complete;
}
