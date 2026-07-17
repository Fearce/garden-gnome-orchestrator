import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "../db/db.js";
import type { Thread } from "../types.js";

// Deterministic backstop for deliverable emission. Emitting a deliverable is a discretionary
// `post_deliverable` tool call the implementor can simply forget — so a task can produce a real
// owner-facing artifact (a report, a CSV, a rendered image) and finish without surfacing it. This
// module recovers, from the run's OWN recorded tool calls and deliverable findings (no model
// judgment), the files the implementor WROTE that look like artifacts but were never surfaced. The
// list is handed to the QA gate as a concrete "did you forget these?" hint — QA verifies each and
// fails the review on a genuine unsurfaced artifact, which bounces the task back to the implementor
// to emit it. It is deliberately NOT an auto-emit: surfacing every changed file would spam the
// console with ordinary source edits (which the deliverables feature explicitly excludes).

// Extensions that denote an owner-facing artifact — a document, dataset, or media file worth opening
// from the console — as opposed to source/config/build output the owner never views there. Kept
// high-precision: source (.ts/.py/.css…), config (.json/.yaml), and lockfiles are excluded, so the
// hint QA receives is a short list of likely-forgotten artifacts, not a re-dump of the whole diff.
const ARTIFACT_EXTS = new Set([
  "md", "markdown", "csv", "tsv", "pdf", "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
  "webm", "mp4", "mov", "xlsx", "xls", "docx", "pptx",
]);

// Path fragments (already lowercased, forward-slashed) whose files are generated/vendored/VCS noise
// no one surfaces by hand — never flag a match even if the extension looks artifact-like.
const IGNORED_FRAGMENTS = ["/node_modules/", "/dist/", "/build/", "/.git/", "/coverage/", "/.next/", "/out/"];

// Repo meta-docs are support files, not owner-facing deliverables — surfacing them as cards would be
// noise. Matched on the filename stem (no extension), lowercased.
const META_DOC_STEMS = new Set([
  "readme", "changelog", "contributing", "license", "licence", "code_of_conduct",
  "claude", "agents", "security", "authors", "notice", "codeowners",
]);

// Bound the hint so a pathological run that wrote hundreds of docs can't bloat the QA kickoff.
const MAX_CANDIDATES = 20;

/**
 * The artifact files the implementor produced on this thread but did not surface as deliverables.
 * Reads only persisted state — the recorded `tool` messages (each stored as `${name} ${json(input)}`)
 * and the thread's deliverable findings — so it is fully deterministic and safe to call at QA time.
 * Returns display paths (as the implementor wrote them), de-duplicated, oldest-write first, capped.
 */
export function detectUnsurfacedArtifacts(db: Db, thread: Thread): string[] {
  const surfaced = new Set<string>();
  for (const f of db.listFindings(thread.id)) {
    if (f.kind === "deliverable" && f.path) surfaced.add(canonicalKey(thread.workspace, f.path));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of db.listMessages(thread.id)) {
    if (m.role !== "implementor" || m.kind !== "tool") continue;
    const path = writtenPath(m.content);
    if (!path || !looksLikeArtifact(path)) continue;
    const key = canonicalKey(thread.workspace, path);
    if (surfaced.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * The `file_path` of a `Write` tool call, or null. Only `Write` (a file created from scratch) is a
 * strong "produced an artifact" signal; `Edit` mutates an existing — usually source — file. The tool
 * input is truncated to 200 chars when recorded (safeJson), so the path is pulled by regex rather than
 * a full JSON.parse — `file_path` is the first key of the Write input, so it survives the truncation.
 */
function writtenPath(content: string): string | null {
  if (!content.startsWith("Write ")) return null;
  const m = content.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const raw = m?.[1];
  if (raw == null) return null;
  try {
    return JSON.parse(`"${raw}"`) as string; // unescape JSON string escapes (e.g. \\ → \ on Windows)
  } catch {
    return raw.replace(/\\\\/g, "\\");
  }
}

/** True if a written path looks like an owner-facing artifact by extension, skipping generated dirs,
 *  scratch/preview files (leading underscore, a convention for throwaway HTML), and repo meta-docs. */
function looksLikeArtifact(path: string): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  if (IGNORED_FRAGMENTS.some((frag) => norm.includes(frag))) return false;
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (base.startsWith("_")) return false; // `_gnome-demo.html`, `__preview.html` — scratch, not a deliverable
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // no extension, or a dotfile (".env") — not an artifact
  if (META_DOC_STEMS.has(base.slice(0, dot))) return false; // README.md / CLAUDE.md / LICENSE — support, not output
  return ARTIFACT_EXTS.has(base.slice(dot + 1));
}

/** A comparison key that matches a written path to a surfaced deliverable path regardless of whether
 *  either was given absolute or workspace-relative: resolve to absolute, then normalize slashes + case. */
function canonicalKey(workspace: string, path: string): string {
  const abs = isAbsolute(path) ? path : join(workspace, path);
  return resolve(abs).replace(/\\/g, "/").toLowerCase();
}
