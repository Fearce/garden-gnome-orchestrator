import { NOTE_MAX_CHARS, type ChatScope } from "../types.js";

/**
 * CLI backends (Codex, Grok) have no in-process MCP tools. Three deliberately simple markers preserve
 * the side effects an implementor needs most: office chat, owner notes, and owner-facing deliverables.
 * The runner intercepts them, strips valid markers from the task transcript, and posts through the
 * same orchestrator services used by the real MCP tools.
 *
 * Matching is deliberately looser than "whole line only":
 * - Grok streaming-json often concatenates successive model turns WITHOUT newlines
 *   (`...done.OFFICE[team]: claiming fooI'll keep going`), so a `^...$` line regex silently drops posts.
 * - Models also copy the doctrine's backtick wrapping: `` `OFFICE[team]: msg` ``. An opening wrapper
 *   is tracked explicitly so ordinary Markdown inside an unwrapped message (`` `src/foo.ts` ``) stays
 *   content instead of being mistaken for the end of the bridge line.
 * - Glued model turns after a claim (`claiming foo.Implementing bar…`) must NOT swallow the next turn
 *   into the chat body — end the body at a sentence-final punct glued to a capital letter, the next
 *   OFFICE marker, a newline, or (when allowed) end-of-string.
 *
 * Completeness gate (`openEnded`):
 * - Grok streams tokens and interleaves `thought` events mid-answer. Harvesting on every thought with
 *   end-of-buffer-as-complete produced truncated team posts (`claimi`, literal `\n`) — Fen, 2026-07-20.
 * - Mid-segment harvests pass `openEnded: false` so a marker without a hard terminator stays in the
 *   buffer until more text arrives. Final flush (clean `end`) passes `openEnded: true`.
 *
 * Office bodies are never truncated here. The local DB/WebSocket path stores arbitrary SQLite TEXT,
 * while the Online Office transport losslessly chunks a long body at its own trust boundary. A parser
 * cap used to silently discard everything after 280 characters — including the exact Sol/Hilda messages
 * that motivated this contract.
 *
 * A normal marker still occupies one line, preserving the original bridge behavior. For a deliberate
 * multiline post, indent each continuation line by two spaces (or one tab):
 *
 *   OFFICE[team]: First line
 *     second line with `markdown`
 *     - a list item
 *
 * The indentation is transport syntax and is removed from the stored body. An unindented next line is
 * normal assistant narration and remains visible. Mid-stream extraction waits for a continuation block
 * to finish, so no prefix can be posted as an orphan message.
 */
// Only horizontal whitespace after the colon — `\s*` would eat the newline and pull the NEXT line into the body
// (`OFFICE[team]:\nAfter.` → body "After."), which both invents a post and steals transcript text.
const MARKER_RE = /`?OFFICE\[(team|office)\][ \t]*:[ \t]*/gi;

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

// Owner-facing files need the same bridge: without it a Codex/Grok implementor can create and commit a
// real artifact but cannot satisfy QA's mandatory deliverables check. Keep the payload line-oriented and
// human-writable rather than making the model escape a Windows path inside JSON:
//
//   DELIVERABLE: Provider connection guide | C:\repo\docs\providers.md
//
// The serving endpoint remains the security boundary: it resolves the real path, confines it to the task
// workspace, requires a regular file, and enforces the 25 MB cap. This parser only transports label+path.
const DELIVERABLE_RE = /`?DELIVERABLE[ \t]*:[ \t]*/gi;
const MAX_DELIVERABLE_WIRE_CHARS = 4096;

export interface ExtractOfficeChatOpts {
  /**
   * When true (default), a marker that runs to end-of-string is treated as complete (Codex whole
   * messages + Grok final flush). When false, an unterminated marker is left in `visible` so the
   * caller can accumulate more stream text — used for Grok mid-segment harvests.
   */
  openEnded?: boolean;
  /**
   * Grok can concatenate separate model turns without a delimiter, so its streaming path retains the
   * conservative punctuation/capital boundary detector. Codex gives us one completed AgentMessage at a
   * time and must disable that heuristic: punctuation is ordinary message data on that provider.
   */
  detectGluedTurns?: boolean;
}

/** An owner-note emitted through a CLI text bridge. `url` is optional because the note service can also
 * lift an http(s) link from `body`, just like the real MCP tool does. */
export interface CliOperatorNote {
  body: string;
  url?: string;
}

/** An owner-facing file emitted through the CLI text bridge. */
export interface CliDeliverable {
  label: string;
  path: string;
}

export interface ExtractOperatorNotesOpts {
  /**
   * Same streaming contract as {@link ExtractOfficeChatOpts.openEnded}: a marker at the end of a live
   * Grok chunk is kept until a clean terminal flush so a partial PR sentence never becomes an owner note.
   */
  openEnded?: boolean;
}

export interface ExtractDeliverablesOpts {
  /** Same streaming contract as the office/note extractors. */
  openEnded?: boolean;
}

/**
 * Extract every supported CLI side-channel in the one safe order used by both runners. Deliverables
 * run first so a complete marker glued after an unfinished OFFICE/OPERATOR_NOTE body is removed before
 * that earlier marker can swallow its path. Each individual extractor also preserves the other two
 * incomplete markers, which matters while Grok is still streaming a line.
 */
export function extractCliBridgeMessages(
  text: string,
  opts?: ExtractOfficeChatOpts,
): {
  visible: string;
  posts: Array<{ scope: ChatScope; body: string }>;
  notes: CliOperatorNote[];
  deliverables: CliDeliverable[];
} {
  const files = extractDeliverables(text, opts);
  const office = extractOfficeChat(files.visible, opts);
  const notes = extractOperatorNotes(office.visible, opts);
  return { visible: notes.visible, posts: office.posts, notes: notes.notes, deliverables: files.deliverables };
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

    const taken = takeOfficeBody(
      text,
      bodyStart,
      openEnded,
      m[0].startsWith("`"),
      opts?.detectGluedTurns !== false,
    );
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
  // The three extractors run CHAINED over one buffer, so each must respect the OTHER open markers as
  // well: trimming a buffer that ends inside the other's half-streamed body eats the trailing space the
  // next chunk appends to, gluing words together (`claiming db.tsand schema.ts`).
  const hasOpenMarker = !openEnded && endsWithOpenCliBridgeMarker(out);
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

  // Same all-markers rule as `extractOfficeChat` — see the comment there.
  const hasOpenMarker = !openEnded && endsWithOpenCliBridgeMarker(out);
  const visible = hasOpenMarker
    ? out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
  return { visible, notes };
}

/**
 * Strip valid `DELIVERABLE: label | path` markers and return their payloads. Unlike office/note junk,
 * a malformed deliverable marker is left visible: "deliverable:" is ordinary prose models sometimes
 * write, and silently deleting it when no parseable path follows would damage the final answer.
 */
export function extractDeliverables(
  text: string,
  opts?: ExtractDeliverablesOpts,
): { visible: string; deliverables: CliDeliverable[] } {
  const openEnded = opts?.openEnded !== false;
  const deliverables: CliDeliverable[] = [];
  if (!text) return { visible: "", deliverables };

  let out = "";
  let cursor = 0;
  DELIVERABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DELIVERABLE_RE.exec(text)) !== null) {
    const markerStart = m.index;
    const bodyStart = DELIVERABLE_RE.lastIndex;
    out += text.slice(cursor, markerStart);

    const taken = takeDeliverableBody(text, bodyStart, openEnded);
    if (!taken.complete) {
      cursor = markerStart;
      DELIVERABLE_RE.lastIndex = text.length;
      break;
    }

    const parsed = splitDeliverable(taken.body);
    const markerEnd = taken.bodyEnd + (taken.trailingTick ? 1 : 0);
    if (parsed) {
      deliverables.push(parsed);
      out += "\n";
    } else {
      // Not the bridge grammar: preserve the model's prose byte-for-byte.
      out += text.slice(markerStart, markerEnd);
    }
    cursor = markerEnd;
    DELIVERABLE_RE.lastIndex = cursor;
  }
  out += text.slice(cursor);

  const hasOpenMarker = !openEnded && endsWithOpenCliBridgeMarker(out);
  const visible = hasOpenMarker
    ? out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
  return { visible, deliverables };
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

function splitDeliverable(raw: string): CliDeliverable | null {
  // A path is far more likely than a short label to contain punctuation, so use the first explicit
  // separator and preserve the rest verbatim. Windows forbids `|` in filenames; on POSIX a literal
  // ` | ` remains legal but is sufficiently unusual that the documented unambiguous wire wins.
  const divider = raw.indexOf(" | ");
  if (divider < 0) return null;
  const label = raw.slice(0, divider).trim();
  const path = raw.slice(divider + 3).trim();
  if (isJunkOfficeBody(label) || !path) return null;
  return { label, path };
}

/** A Grok segment boundary is not represented in the text stream. When a standalone bridge line is
 * immediately followed by the next structured/narrative turn, recognize the end of a plausible file
 * path instead of appending that turn to the card path. The broad extension check is reserved for JSON
 * delimiters; capitalized prose uses the high-precision owner-facing extension set to avoid splitting a
 * legitimate mixed-case filename such as `report.v2Final.md`. */
function gluedDeliverableBoundaryAt(text: string, i: number, bodyStart: number): boolean {
  const cur = text[i]!;
  if (cur !== "{" && cur !== "[" && !/[A-Z]/.test(cur)) return false;
  const prefix = text.slice(bodyStart, i).trimEnd();
  if (cur === "{" || cur === "[") return /\.[A-Za-z0-9]{1,12}$/.test(prefix);
  return /\.(?:md|markdown|csv|tsv|pdf|html?|png|jpe?g|gif|webp|svg|ico|webm|mp4|mov|xlsx?|docx|pptx|txt|zip)$/i.test(prefix);
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
      // A triple fence belongs to the next structured JSON block; only consume a lone backtick that
      // closes the model's optional wrapping around the marker itself.
      trailingTick = !text.startsWith("```", i);
      complete = true;
      break;
    }
    if (startsOperatorNoteMarker(text, i)) {
      complete = true;
      break;
    }
    if (startsOfficeMarker(text, i) || startsDeliverableMarker(text, i)) {
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

/** Scan one deliverable payload. A later bridge marker terminates it even when Grok glued model turns. */
function takeDeliverableBody(
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
      // Preserve a glued fenced JSON block for structured-role parsing.
      trailingTick = !text.startsWith("```", i);
      complete = true;
      break;
    }
    if (startsDeliverableMarker(text, i) || startsOfficeMarker(text, i) || startsOperatorNoteMarker(text, i)) {
      complete = true;
      break;
    }
    if (gluedDeliverableBoundaryAt(text, i, bodyStart)) {
      complete = true;
      break;
    }
    if (i - bodyStart >= MAX_DELIVERABLE_WIRE_CHARS) {
      complete = true;
      break;
    }
    i++;
  }
  if (!complete && i >= n) complete = openEnded;
  if (!complete) return { body: "", bodyEnd: bodyStart, trailingTick: false, complete: false };
  return { body: text.slice(bodyStart, i).trim(), bodyEnd: i, trailingTick, complete: true };
}

function startsDeliverableMarker(text: string, i: number): boolean {
  let j = i;
  if (text[j] === "`") j++;
  return /^deliverable[ \t]*:/i.test(text.slice(j));
}

/** True when a Grok stream ends inside an incomplete deliverable line. */
export function endsWithOpenDeliverableMarker(text: string): boolean {
  if (!text) return false;
  DELIVERABLE_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = DELIVERABLE_RE.exec(text)) !== null) last = m;
  if (!last) return false;
  const bodyStart = last.index + last[0].length;
  return !takeDeliverableBody(text, bodyStart, false).complete;
}

function endsWithOpenCliBridgeMarker(text: string): boolean {
  return endsWithOpenOfficeMarker(text) || endsWithOpenOperatorNoteMarker(text) || endsWithOpenDeliverableMarker(text);
}

/** Scan forward from `bodyStart` for the end of one office-bridge body. */
function takeOfficeBody(
  text: string,
  bodyStart: number,
  openEnded: boolean,
  wrapped: boolean,
  detectGluedTurns: boolean,
): { body: string; bodyEnd: number; trailingTick: boolean; complete: boolean } {
  const n = text.length;
  let i = bodyStart;
  let lineStart = bodyStart;
  const bodyParts: string[] = [];
  let trailingTick = false;
  let complete = false;

  while (i < n) {
    const ch = text[i]!;

    // A continuation line indented by two spaces (or a tab) is an explicit, lossless multiline body.
    // Anything unindented remains normal narration, matching the bridge's original one-line contract.
    if (ch === "\n" || ch === "\r") {
      const newlineEnd = ch === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      const rest = text.slice(newlineEnd);
      // A live stream that currently ends at the newline (or after only one possible indent space) has
      // not revealed whether a continuation follows. Keep the whole marker buffered until it does.
      if (!openEnded && /^[ \t]?$/.test(rest)) {
        return { body: "", bodyEnd: bodyStart, trailingTick: false, complete: false };
      }
      const contentStart = continuationContentStart(text, newlineEnd);
      if (contentStart !== null) {
        bodyParts.push(text.slice(lineStart, i), "\n");
        lineStart = contentStart;
        i = contentStart;
        continue;
      }
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    // A backtick closes only a marker that actually OPENED with a wrapper. In an ordinary marker it is
    // Markdown content — the old unconditional stop produced "... improvement in" from a Sol claim
    // whose next byte was the opening backtick around `src/project/search.py`.
    if (wrapped && ch === "`" && isClosingOfficeWrapper(text, i, openEnded)) {
      trailingTick = true;
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    // Next OFFICE marker — don't swallow it into this body.
    if (startsOfficeMarker(text, i)) {
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    // An OPERATOR_NOTE marker on the same line ends this body too. The runners extract office chat
    // FIRST (so a reply carrying both markers delivers both), which means anything this body eats never
    // reaches `extractOperatorNotes` — and Grok withholds the segment-separating newline while an OFFICE
    // marker is open, so the two markers arrive glued far more often than they arrive on separate lines.
    // Without this stop the owner's note is silently lost AND its PR link is broadcast to the chatroom.
    if (startsOperatorNoteMarker(text, i)) {
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    // A deliverable marker on the same glued line is harvested first by the runners, but keep this
    // boundary too so direct extractor use and future ordering changes cannot leak a path into chat.
    if (startsDeliverableMarker(text, i)) {
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    // Glued next model turn: stop before the capital so narration stays in the transcript.
    if (detectGluedTurns && gluedTurnBoundaryAt(text, i, bodyStart)) {
      bodyParts.push(text.slice(lineStart, i));
      complete = true;
      break;
    }

    i++;
  }

  // Hit end-of-string without a hard terminator.
  if (!complete && i >= n) {
    complete = openEnded;
    if (complete) bodyParts.push(text.slice(lineStart, i));
  }

  if (!complete) {
    return { body: "", bodyEnd: bodyStart, trailingTick: false, complete: false };
  }

  return { body: bodyParts.join("").trim(), bodyEnd: i, trailingTick, complete: true };
}

/** Return the first content byte of an explicit continuation line, removing only its bridge indent. */
function continuationContentStart(text: string, lineStart: number): number | null {
  if (text[lineStart] === "\t") return lineStart + 1;
  if (text[lineStart] === " " && text[lineStart + 1] === " ") return lineStart + 2;
  return null;
}

/** A wrapped marker's closing backtick is the last one on its line. Earlier pairs belong to inline
 * Markdown (or a fenced continuation) and are message data. During a live stream, a candidate at the
 * current buffer edge stays open until the next chunk or terminal flush proves it really was outer
 * syntax; this is the same no-orphan rule used for an unterminated body. */
function isClosingOfficeWrapper(text: string, index: number, openEnded: boolean): boolean {
  const cr = text.indexOf("\r", index + 1);
  const lf = text.indexOf("\n", index + 1);
  const lineEnds = [cr, lf].filter((at) => at >= 0);
  const lineEnd = lineEnds.length ? Math.min(...lineEnds) : -1;
  const boundary = lineEnd < 0 ? text.length : lineEnd;
  const nextTick = text.indexOf("`", index + 1);
  if (nextTick >= 0 && nextTick < boundary) return false;
  if (index + 1 === text.length) return openEnded;
  if (lineEnd === index + 1) return true;
  // Permit punctuation outside the wrapper on an otherwise standalone line, but never consume it.
  return /^[\t .,;:!?)]*$/.test(text.slice(index + 1, boundary));
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
  const taken = takeOfficeBody(text, bodyStart, false, last[0].startsWith("`"), true);
  return !taken.complete;
}
