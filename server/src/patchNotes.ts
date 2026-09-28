import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildInfo } from "./buildInfo.js";
import { runChild } from "./childRunner.js";
import { config } from "./config.js";

// Patch notes are the orchestrator's own git history, read from the checkout it runs from. The repo
// already writes Conventional Commits, so a commit's type says whether it is a feature, a fix or a
// speed-up an operator will notice, or internal work (docs, tests, chores) they will not. No separate
// changelog to keep in sync: it cannot drift from what actually shipped.

const REPO_ROOT = resolve(config.serverRoot, "..");
const GIT_TIMEOUT_MS = 20_000;
export const PAGE_SIZE = 150;
const MAX_PAGE_SIZE = 500;
const UPCOMING_LIMIT = 200;
const PENDING_LIMIT = 1000;
/** What tsc compiles into the RUNNING server, minus what it compiles but never runs. Kept in step with
 *  `scripts/compiled-diff.cjs`'s SERVER_RUNTIME / SERVER_NOT_RUNTIME. */
const SERVER_RUNTIME = ["server/src", "server/tsconfig.json", ":(exclude)server/src/tests", ":(exclude)server/src/tools"];
/** What Vite bundles into `web/dist`. Kept byte-identical to `web/scripts/stamp-web-build.cjs`'s WEB_INPUT. */
const WEB_INPUT = ["web/src", "web/index.html", "web/vite.config.ts", "web/tsconfig.json"];
const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = ["%H", "%h", "%ct", "%s", "%b"].join("%x1f") + "%x1e";

export type PatchNoteKind = "feature" | "fix" | "perf" | "other" | "internal";

export interface PatchNote {
  sha: string;
  short: string;
  /** Commit time, epoch ms. */
  at: number;
  kind: PatchNoteKind;
  /** The Conventional Commit type (`feat`, `fix`…), or null for a free-form subject. */
  type: string | null;
  scope: string | null;
  breaking: boolean;
  /** The subject without its `type(scope):` prefix. */
  summary: string;
  /** The commit body with trailers (Co-Authored-By, Signed-off-by) removed; empty when there is none. */
  body: string;
}

export interface PatchNotesPage {
  /** The checkout's HEAD, full sha. */
  head: string | null;
  /** The commit the RUNNING server was built from. */
  running: string | null;
  /** Commits (full shas, first page only) that change code the running server or the served web bundle was
   *  built without: a server change above the server's build stamp, or a web change above web/dist's.
   *  Docs, tests and scripts are never pending — nothing has to be rebuilt for them to count. */
  pending: string[];
  branch: string | null;
  /** Commits the tracked upstream has that this checkout does not, newest first (first page only). */
  upcoming: PatchNote[];
  entries: PatchNote[];
  hasMore: boolean;
  /** Why the history could not be read (not a git checkout, git missing); null when fine. */
  error: string | null;
}

const KIND_BY_TYPE: Record<string, PatchNoteKind> = {
  feat: "feature",
  fix: "fix",
  perf: "perf",
  revert: "other",
  docs: "internal",
  test: "internal",
  tests: "internal",
  chore: "internal",
  refactor: "internal",
  style: "internal",
  build: "internal",
  ci: "internal",
};

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|change-id):/i;

/** One `git log` subject + body as a patch note. Exported for the gate. */
export function classifyCommit(subject: string, body: string): Pick<PatchNote, "kind" | "type" | "scope" | "breaking" | "summary" | "body"> {
  const cleanBody = stripTrailers(body);
  const breaking = /^BREAKING[ -]CHANGE:/m.test(body);
  const match = CONVENTIONAL.exec(subject.trim());
  if (!match) return { kind: "other", type: null, scope: null, breaking, summary: subject.trim(), body: cleanBody };
  const type = match[1]!.toLowerCase();
  return {
    kind: KIND_BY_TYPE[type] ?? "other",
    type,
    scope: match[2]?.trim() || null,
    breaking: breaking || match[3] === "!",
    summary: capitalise(match[4]!.trim()),
    body: cleanBody,
  };
}

function stripTrailers(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !TRAILER.test(line.trim()))
    .join("\n")
    .trim();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Parse `git log --format=LOG_FORMAT` output. Exported for the gate. */
export function parseLog(stdout: string): PatchNote[] {
  const notes: PatchNote[] = [];
  for (const record of stdout.split(RECORD)) {
    const [sha, short, seconds, subject, body] = record.replace(/^\s+/, "").split(FIELD);
    if (!sha || !short || !subject) continue;
    notes.push({ sha, short, at: Number(seconds) * 1000, ...classifyCommit(subject, body ?? "") });
  }
  return notes;
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await runChild("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: GIT_TIMEOUT_MS });
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
}

async function log(range: string, cwd: string, skip: number, limit: number): Promise<PatchNote[] | null> {
  const r = await git(["log", "--no-merges", `--format=${LOG_FORMAT}`, `--skip=${skip}`, `--max-count=${limit}`, range], cwd);
  return r.ok ? parseLog(r.stdout) : null;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

/** One page of patch notes, newest first. Upstream commits are listed on the first page only and read
 *  from the local tracking ref: the update poll already fetches, so opening the notes never hits the network. */
/** The commit `web/dist` was built from (`stamp-web-build.cjs`). Read per request, unlike the server's stamp:
 *  the web bundle is static and is rebuilt under a running server (the auto-builder does it). */
function webBuildCommit(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(config.webDist, ".build-info.json"), "utf8")) as { commit?: unknown };
    return typeof parsed.commit === "string" ? parsed.commit : null;
  } catch {
    return null;
  }
}

/** Commits above `stamp` touching `pathspec`. Null when that cannot be told (no stamp, or a stamp git no
 *  longer reaches after a rebase) — read as "unknown", never as "everything is pending". */
async function unbuilt(stamp: string | null, pathspec: string[], cwd: string): Promise<string[] | null> {
  if (!stamp) return null;
  const r = await git(["rev-list", "--no-merges", `--max-count=${PENDING_LIMIT}`, `${stamp}..HEAD`, "--", ...pathspec], cwd);
  return r.ok ? r.stdout.split(/\s+/).filter(Boolean) : null;
}

export async function readPatchNotes(
  opts: { skip?: number; limit?: number; cwd?: string; serverBuild?: string | null; webBuild?: string | null } = {},
): Promise<PatchNotesPage> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const skip = clampInt(opts.skip, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(opts.limit, PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const page: PatchNotesPage = { head: null, running: buildInfo()?.commit ?? null, pending: [], branch: null, upcoming: [], entries: [], hasMore: false, error: null };

  const head = await git(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], cwd);
  if (!head.ok) {
    page.error = head.stderr.trim() || "this install is not a git checkout, so there is no history to show";
    return page;
  }
  const [sha, branch] = head.stdout.trim().split(/\r?\n/);
  page.head = sha ?? null;
  page.branch = branch && branch !== "HEAD" ? branch : null;

  // One extra row tells us whether an older page exists without a second `rev-list --count`.
  const firstPage = skip === 0;
  const serverBuild = opts.serverBuild !== undefined ? opts.serverBuild : page.running;
  const webBuild = opts.webBuild !== undefined ? opts.webBuild : webBuildCommit();
  const [entries, upcoming, serverPending, webPending] = await Promise.all([
    log("HEAD", cwd, skip, limit + 1),
    firstPage ? log("HEAD..@{u}", cwd, 0, UPCOMING_LIMIT) : null,
    firstPage ? unbuilt(serverBuild, SERVER_RUNTIME, cwd) : null,
    firstPage ? unbuilt(webBuild, WEB_INPUT, cwd) : null,
  ]);
  if (!entries) {
    page.error = "git log failed on this checkout";
    return page;
  }
  page.hasMore = entries.length > limit;
  page.entries = entries.slice(0, limit);
  page.upcoming = upcoming ?? [];
  page.pending = [...new Set([...(serverPending ?? []), ...(webPending ?? [])])];
  return page;
}
