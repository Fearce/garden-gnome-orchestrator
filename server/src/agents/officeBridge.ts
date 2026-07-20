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
 *   OFFICE marker, a newline, a hard length cap, or end-of-string.
 *
 * Body is capped at {@link MAX_OFFICE_BODY} (coordination messages are one short line).
 */
// Only horizontal whitespace after the colon — `\s*` would eat the newline and pull the NEXT line into the body
// (`OFFICE[team]:\nAfter.` → body "After."), which both invents a post and steals transcript text.
const MARKER_RE = /`?OFFICE\[(team|office)\][ \t]*:[ \t]*/gi;
/** Soft cap — doctrine says office messages are a line or two; glued narration past this is not a claim. */
export const MAX_OFFICE_BODY = 280;

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

export function extractOfficeChat(text: string): {
  visible: string;
  posts: Array<{ scope: ChatScope; body: string }>;
} {
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

    const { body, bodyEnd, trailingTick } = takeOfficeBody(text, bodyStart);
    if (body) {
      posts.push({
        scope: String(m[1]).toLowerCase() === "office" ? "general" : "project",
        body,
      });
    }
    // Drop the marker (+ optional closing backtick); leave a newline so surrounding prose doesn't glue.
    out += "\n";
    cursor = bodyEnd + (trailingTick ? 1 : 0);
    MARKER_RE.lastIndex = cursor;
  }
  out += text.slice(cursor);

  const visible = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { visible, posts };
}

/** Scan forward from `bodyStart` for the end of one office-bridge body. */
function takeOfficeBody(
  text: string,
  bodyStart: number,
): { body: string; bodyEnd: number; trailingTick: boolean } {
  const n = text.length;
  let i = bodyStart;
  let trailingTick = false;

  while (i < n) {
    const ch = text[i]!;

    // Hard stops: newline ends the marker line.
    if (ch === "\n" || ch === "\r") break;

    // Optional closing backtick (model copied `` `OFFICE[team]: msg` ``).
    if (ch === "`") {
      trailingTick = true;
      break;
    }

    // Next OFFICE marker — don't swallow it into this body.
    if (startsOfficeMarker(text, i)) break;

    // Glued next model turn: stop before the capital so narration stays in the transcript.
    if (gluedTurnBoundaryAt(text, i, bodyStart)) break;

    // Length cap: take up to MAX, then back off to a clean word boundary when possible.
    if (i - bodyStart >= MAX_OFFICE_BODY) break;

    i++;
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

  return { body, bodyEnd, trailingTick };
}

function startsOfficeMarker(text: string, i: number): boolean {
  // Optional leading backtick, then OFFICE[team|office]
  let j = i;
  if (text[j] === "`") j++;
  const slice = text.slice(j, j + 14).toLowerCase();
  return slice.startsWith("office[team]") || slice.startsWith("office[office]");
}
