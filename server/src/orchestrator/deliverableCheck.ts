import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "../db/db.js";
import type { Role, Thread } from "../types.js";

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

// ---------------------------------------------------------------------------
// Task-scoped Changes attribution (read-only diff drawer).
// Reuses the recorded-tool-call replay above, but WITHOUT the artifact filter: a task's git diff scope
// is its own source files too, not just documents. Kept self-contained here so the deliverable detector
// above is untouched.
// ---------------------------------------------------------------------------

// The agent roles that PRODUCE owner-facing output. QA is excluded: it reviews rather than produces, and
// its own scratch (a notes file, a diff dump) is not a task deliverable. Recorded as `Message["role"]`.
const PRODUCING_ROLES = new Set<Role | "user">(["implementor", "researcher", "planner"]);

// Bound the task-file set that scopes the Changes diff — its paths become `git diff -- <pathspec>` args,
// so an unbounded set could blow the command line. Real tasks touch a handful of files; a run that wrote
// more than this attributes a (conservative) subset, matching the module's under-report-not-over stance.
const MAX_TASK_FILES = 250;

/**
 * The absolute paths of files THIS task's producing agents wrote or modified, inside the task workspace.
 * Replays the same recorded tool calls as `detectUnsurfacedArtifacts` (deterministic, thread-attributed —
 * it reads only THIS run's own tool messages, never a filesystem scan that would pick up concurrent tasks
 * sharing the repo) but WITHOUT the artifact-extension/meta-doc filter: this set scopes the task's git
 * diff (source files included), so the Changes chip shows the task's OWN changes, not the whole dirty tree.
 * Paths are resolved absolute and confined to the workspace (mirroring the deliverable serve guard — a
 * path outside it isn't the task's own work in any surfaceable sense), de-duplicated, capped.
 */
export function collectTaskWrittenFiles(db: Db, thread: Thread): string[] {
  const wsKey = workspaceKey(thread.workspace);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of db.listMessages(thread.id)) {
    if (m.kind !== "tool" || !PRODUCING_ROLES.has(m.role)) continue;
    for (const path of taskWrittenPaths(m.content)) {
      const key = canonicalKey(thread.workspace, path);
      if (!isInsideWorkspace(wsKey, key)) continue; // out-of-workspace files aren't this task's own tree
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(absPath(thread.workspace, path));
      if (out.length >= MAX_TASK_FILES) return out;
    }
  }
  return out;
}

/** The absolute, resolved form of a written path (relative paths resolve against the workspace) — the
 *  shape gitService needs to relativize against the actual repo root. `canonicalKey` lowercases/slashes
 *  for MATCHING; this keeps the real path for git. */
function absPath(workspace: string, path: string): string {
  return resolve(isAbsolute(path) ? path : join(workspace, path));
}

// The mutation tools whose input carries a `file_path` first key. Unlike the deliverable detector, which
// counts only Write (a from-scratch create), TASK attribution counts every file the agent MUTATED, so
// Edit/MultiEdit belong here. Read/Grep/Glob also carry a `path`-ish field but are NOT mutations, so
// gating on this exact tool-name set is what keeps a merely-read file out of the diff scope.
const FILE_MUTATION_TOOLS = ["Write ", "Edit ", "MultiEdit "];

/** Every file path a single recorded tool call WROTE OR MODIFIED — the input to task-scoped git
 *  attribution. Covers Write/Edit/MultiEdit (`file_path`), NotebookEdit (`notebook_path`), and a shell
 *  command's redirect/output targets. No artifact-extension filter: a task's diff scope is its own
 *  source files too, not just documents. */
function taskWrittenPaths(content: string): string[] {
  const out: string[] = [];
  if (FILE_MUTATION_TOOLS.some((p) => content.startsWith(p))) {
    const fp = jsonStringField(content, "file_path");
    if (fp) out.push(fp);
  } else if (content.startsWith("NotebookEdit ")) {
    const np = jsonStringField(content, "notebook_path");
    if (np) out.push(np);
  }
  out.push(...shellArtifactTargets(content)); // gated internally on Bash/PowerShell
  return out;
}

/** Pull a JSON string value for `key` out of a (possibly 200-char-truncated) recorded tool input by
 *  regex — the input is truncated when recorded (safeJson), so a full JSON.parse isn't reliable, but the
 *  keys we read (`file_path`, `notebook_path`, `command`) are the FIRST key of their tool's input and so
 *  survive the cut. Returns the unescaped string, or null when the key isn't present. */
function jsonStringField(content: string, key: string): string | null {
  const m = content.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  const raw = m?.[1];
  if (raw == null) return null;
  try {
    return JSON.parse(`"${raw}"`) as string; // unescape JSON string escapes (e.g. \\ → \ on Windows)
  } catch {
    return raw.replace(/\\\\/g, "\\");
  }
}

// File-producing shell fragments. Each captures the destination token (bare or quoted). Ordered from
// most-common (redirect) to shell-specific.
const SHELL_TARGET_PATTERNS: RegExp[] = [
  // stdout redirection: `> f`, `>> f`. Excludes fd-dup (`2>&1`, `>&2`) and fd-prefixed (`1>`, `2>`).
  /(?:^|[^\d>&])>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;|&<>]+)/g,
  // explicit output flag used by many generators (pandoc, wkhtmltopdf, jq/csvkit -o, …): `-o f`.
  /(?:^|\s)(?:-o|--output(?:-file)?)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;|&<>]+)/g,
  // `tee [-a] f` — writes stdout to a file mid-pipeline.
  /(?:^|[|&;\s])tee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;|&<>]+)/g,
  // PowerShell producers, path positional or via -Path/-FilePath/-LiteralPath.
  /(?:Out-File|Set-Content|Add-Content|Export-Csv|Export-Excel|ConvertTo-Html)\s+(?:-(?:File|Literal)?Path[:\s]+)?("[^"]+"|'[^']+'|[^\s;|&<>]+)/gi,
];

/** Destination files a shell tool call writes to. Empty for a non-shell tool. */
function shellArtifactTargets(content: string): string[] {
  const cmd = shellCommand(content);
  if (cmd == null) return [];
  const out: string[] = [];
  for (const re of SHELL_TARGET_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) != null) {
      if (m[1] == null) continue;
      const target = stripQuotes(m[1]);
      if (target) out.push(target);
    }
  }
  return out;
}

/** The `command` string of a `Bash`/`PowerShell` tool call, unescaped, or null for any other tool. Like
 *  the Write path, the recorded input is truncated to 200 chars (safeJson) with a trailing "…", and
 *  `command` is the first key — so it's extracted by regex tolerant of a missing closing quote. */
function shellCommand(content: string): string | null {
  if (!content.startsWith("Bash ") && !content.startsWith("PowerShell ")) return null;
  // Greedy up to the closing JSON quote, or to end-of-string if truncation severed it (`"?`).
  const m = content.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
  const raw = m?.[1];
  if (raw == null) return null;
  const trimmed = raw.replace(/…$/, ""); // drop the truncation ellipsis if it landed inside the command
  try {
    return JSON.parse(`"${trimmed}"`) as string;
  } catch {
    // Truncation can leave a half-formed escape that fails JSON.parse; unescape the common ones directly.
    return trimmed
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
}

/** Strip a single layer of matching surrounding quotes from a captured shell token. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Canonical key for the workspace root itself, in the same normalized form as `canonicalKey`. */
function workspaceKey(workspace: string): string {
  return resolve(workspace).replace(/\\/g, "/").toLowerCase();
}

/** True if a canonical path key lies within the workspace (the root itself, or a descendant). Both args
 *  must already be `canonicalKey`/`workspaceKey` output (resolved, /-slashed, lowercased); the `/`
 *  boundary stops `…/foo` from matching a sibling `…/foobar`. */
function isInsideWorkspace(wsKey: string, key: string): boolean {
  return key === wsKey || key.startsWith(wsKey.endsWith("/") ? wsKey : wsKey + "/");
}
