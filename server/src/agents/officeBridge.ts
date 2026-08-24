import { NOTE_MAX_CHARS, type ChatScope } from "../types.js";

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

// CLI backends cannot call the in-process `post_operator_note` MCP tool either. They use this
// deliberately boring, standalone wire form instead:
//
//   OPERATOR_NOTE: Review PR #42 | https://github.com/acme/repo/pull/42
//
// Keep the wire allowance comfortably above the 255-character body cap: a perfectly valid branch or
// PR URL can itself be several hundred characters. The note service is still the canonical enforcement
// point for NOTE_MAX_CHARS and URL validation; this is only a streaming-buffer safety bound.
const OPERATOR_NOTE_RE = /`?OPERATOR_NOTE[ \t]*:[ \t]*/gi;
const MAX_OPERATOR_NOTE_WIRE_CHARS = NOTE_MAX_CHARS + 700;

export interface ExtractOfficeChatOpts {
  /**
   * When true (default), a marker that runs to end-of-string is treated as complete (Codex whole
   * messages + Grok final flush). When false, an unterminated marker is left in `visible` so the
   * caller can accumulate more stream text — used for Grok mid-segment harvests.
   */
  openEnded?: boolean;
}

/** An owner-note emitted through a CLI text bridge. `url` is optional because the note service can also
 * lift an http(s) link from `body`, just like the real MCP tool does. */
export interface CliOperatorNote {
  body: string;
  url?: string;
}

export interface ExtractOperatorNotesOpts {
  /**
   * Same streaming contract as {@link ExtractOfficeChatOpts.openEnded}: a marker at the end of a live
   * Grok chunk is kept until a clean terminal flush so a partial PR sentence never becomes an owner note.
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

/**
 * Strip CLI `OPERATOR_NOTE:` lines from an assistant response and return the note payloads for the
 * orchestrator to post. This stays separate from {@link extractOfficeChat}: office messages carry a
 * scope, while owner notes carry an optional click target and have a different abuse bound.
 *
 * The optional ` | https://...` suffix is intentionally simple. It gives a model a reliably parseable
 * place for the click target without making it manufacture JSON in the middle of a final reply. If it
 * omits the suffix, the note service still recognizes an http(s) link written into the one-line body.
 */
export function extractOperatorNotes(
  text: string,
  opts?: ExtractOperatorNotesOpts,
): { visible: string; notes: CliOperatorNote[] } {
  const openEnded = opts?.openEnded !== false;
  const notes: CliOperatorNote[] = [];
  if (!text) return { visible: "", notes };

  let out = "";
  let cursor = 0;
  OPERATOR_NOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPERATOR_NOTE_RE.exec(text)) !== null) {
    const markerStart = m.index;
    const bodyStart = OPERATOR_NOTE_RE.lastIndex;
    out += text.slice(cursor, markerStart);

    const taken = takeOperatorNoteBody(text, bodyStart, openEnded);
    if (!taken.complete) {
      cursor = markerStart;
      OPERATOR_NOTE_RE.lastIndex = text.length;
      break;
    }

    // Same junk bound as the office bridge, and for the same reason: a model that emits a bare marker
    // or a literal `\n` as its "line" would otherwise put an unreadable row on the owner's list — and
    // the note list is the one surface whose whole value is that every row is worth clicking.
    const raw = taken.body.trim();
    if (raw && !isJunkOfficeBody(raw)) notes.push(splitOperatorNote(raw));
    // Keep prose either side of a stripped marker from gluing together. A later trim collapses an
    // unnecessary edge newline, matching the office bridge's transcript behavior.
    out += "\n";
    cursor = taken.bodyEnd + (taken.trailingTick ? 1 : 0);
    OPERATOR_NOTE_RE.lastIndex = cursor;
  }
  out += text.slice(cursor);

  const hasOpenMarker = !openEnded && endsWithOpenOperatorNoteMarker(out);
  const visible = hasOpenMarker
    ? out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
  return { visible, notes };
}

/** True when a Grok stream ends inside an incomplete `OPERATOR_NOTE:` line. */
export function endsWithOpenOperatorNoteMarker(text: string): boolean {
  if (!text) return false;
  OPERATOR_NOTE_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = OPERATOR_NOTE_RE.exec(text)) !== null) last = m;
  if (!last) return false;
  const bodyStart = last.index + last[0].length;
  return !takeOperatorNoteBody(text, bodyStart, false).complete;
}

function splitOperatorNote(raw: string): CliOperatorNote {
  // Use the last separator so a terse prose label can itself contain a pipe. An invalid suffix stays in
  // the body; `OperatorNotes` then applies its normal validation/link-discovery rules rather than losing
  // the entire note because a CLI model made one formatting mistake.
  const divider = raw.lastIndexOf(" | ");
  if (divider >= 0) {
    const body = raw.slice(0, divider).trim();
    const candidate = raw.slice(divider + 3).trim();
    if (body && /^https?:\/\//i.test(candidate)) return { body, url: candidate };
  }
  return { body: raw };
}

/** Scan a single `OPERATOR_NOTE:` payload. Newline/backtick/next marker end it; an in-flight Grok
 * chunk is deliberately incomplete until the final clean flush, just like OFFICE markers. */
function takeOperatorNoteBody(
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
    if (ch === "\n" || ch === "\r") {
      complete = true;
      break;
    }
    if (ch === "`") {
      trailingTick = true;
      complete = true;
      break;
    }
    if (startsOperatorNoteMarker(text, i)) {
      complete = true;
      break;
    }
    if (i - bodyStart >= MAX_OPERATOR_NOTE_WIRE_CHARS) {
      complete = true;
      break;
    }
    i++;
  }
  if (!complete && i >= n) complete = openEnded;
  if (!complete) return { body: "", bodyEnd: bodyStart, trailingTick: false, complete: false };
  return { body: text.slice(bodyStart, i).trim(), bodyEnd: i, trailingTick, complete: true };
}

function startsOperatorNoteMarker(text: string, i: number): boolean {
  let j = i;
  if (text[j] === "`") j++;
  return /^operator_note[ \t]*:/i.test(text.slice(j));
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
