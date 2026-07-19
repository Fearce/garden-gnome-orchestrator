import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// Read-only git for the reader lane. The reader micro-pipeline gets git HISTORY without a shell: an
// allowlisted git_read MCP tool (see ../bus/gitReadServer.ts) that runs ONLY a handful of strictly
// read-only subcommands through a hardened, no-shell `runGit`. Enforcement lives HERE, not in the
// prompt — the allowlist plus the arg-denylist are the trust boundary, so a "read" can never become a
// write (commit/push/checkout/reset are rejected) or a shell-out. Self-contained by design: it depends
// on nothing but git itself, so the read lane carries no other infrastructure.

const GIT_TIMEOUT_MS = 15_000;
// Bound a pathological log/diff so a runaway repo can't blow the tool result or the model's context.
const OUTPUT_MAX_BYTES = 200_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`, resolving with its exit code + captured output (never rejects). Env hardening:
 *  GIT_TERMINAL_PROMPT=0 so a private remote fails fast instead of hanging on a credential prompt,
 *  GIT_OPTIONAL_LOCKS=0 so a read never races an index lock a concurrent process holds. No shell. */
function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", ["--no-pager", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < OUTPUT_MAX_BYTES * 2) stdout += c;
    });
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout, stderr: stderr + String((e as Error).message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

// ---- repo resolution --------------------------------------------------------------------------------

const repoRootCache = new Map<string, { at: number; root: string | null }>();
const REPO_ROOT_TTL_MS = 15_000;

/** Resolve the git repo a task's work lives in. A task's `workspace` is USUALLY the repo itself, but
 *  it's often the PARENT of a nested repo (e.g. workspace `…/claude-orchastrator` vs. the repo at
 *  `…/claude-orchastrator/claude-orchestrator`, per CLAUDE.md). So: (1) if the workspace is inside a
 *  repo, use that repo's top level; (2) else pick the best nested checkout one level down; (3) else null
 *  (not a repo — the caller surfaces a graceful "no git" state). Cached per workspace (negatives too). */
async function resolveRepoRoot(workspace: string): Promise<string | null> {
  if (!workspace) return null;
  const cached = repoRootCache.get(workspace);
  if (cached && Date.now() - cached.at < REPO_ROOT_TTL_MS) return cached.root;
  const root = await resolveRepoRootUncached(workspace);
  repoRootCache.set(workspace, { at: Date.now(), root });
  return root;
}

async function resolveRepoRootUncached(workspace: string): Promise<string | null> {
  if (!existsSync(workspace)) return null;
  const top = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();

  // Workspace isn't itself in a repo — look one level down for nested checkouts. A parent that holds
  // MORE THAN ONE nested repo is normal (sibling worktrees, a `-demo` checkout, a helper clone), so we
  // disambiguate rather than bail: prefer the nested repo whose folder name most resembles the
  // workspace's own folder (longest common prefix — tolerant of typo variants like "claude-orchastrator"
  // vs "claude-orchestrator"), then a real checkout over a linked worktree (.git dir vs .git file), then
  // the shorter name (the base repo over a "-demo"/"-lite" sibling).
  let candidates: { dir: string; name: string; gitIsDir: boolean }[];
  try {
    candidates = [];
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const gitPath = join(workspace, entry.name, ".git");
      if (!existsSync(gitPath)) continue;
      let gitIsDir = false;
      try {
        gitIsDir = statSync(gitPath).isDirectory();
      } catch {
        /* a .git file (worktree) — leave gitIsDir false */
      }
      candidates.push({ dir: join(workspace, entry.name), name: entry.name, gitIsDir });
    }
  } catch {
    return null; // unreadable dir
  }
  if (candidates.length === 0) return null;

  const leaf = basename(workspace.replace(/[\\/]+$/, "")).toLowerCase();
  candidates.sort((a, b) => {
    const pa = commonPrefixLen(leaf, a.name.toLowerCase());
    const pb = commonPrefixLen(leaf, b.name.toLowerCase());
    if (pa !== pb) return pb - pa;
    if (a.gitIsDir !== b.gitIsDir) return a.gitIsDir ? -1 : 1;
    return a.name.length - b.name.length;
  });

  const t = await runGit(candidates[0]!.dir, ["rev-parse", "--show-toplevel"]);
  return t.code === 0 && t.stdout.trim() ? t.stdout.trim() : null;
}

/** Length of the shared leading substring of two strings — the name-similarity signal for disambiguating
 *  sibling nested repos (a workspace named like its primary repo scores highest). */
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---- the read-only allowlist (the trust boundary) ---------------------------------------------------

/** The only git subcommands the reader may run — all strictly read-only (they cannot mutate the repo,
 *  index, refs, or remotes regardless of their arguments). Widening this set is a security decision. */
export const GIT_READ_SUBCOMMANDS = ["log", "show", "status", "diff"] as const;
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number];

// Even a read-only subcommand has a couple of args that escape read-only-ness: `git diff --output=<f>`
// writes the diff to a FILE, and `--ext-diff` runs an external diff driver (arbitrary configured command).
// Reject those so the reader can't turn a "read" into a write or a shell-out.
const GIT_READ_ARG_DENY = /^(--output(=|$)|-o$|--ext-diff$)/;

export interface GitReadResult {
  ok: boolean;
  /** Combined trimmed stdout (truncated to OUTPUT_MAX_BYTES), or "" on rejection/failure. */
  output: string;
  /** Human-readable reason when ok is false (rejected subcommand/arg, not-a-repo, or git failure). */
  error: string | null;
}

/** Validate a reader git request against the allowlist + arg-denylist WITHOUT running anything — the pure
 *  core the unit test exercises (writes like push/commit rejected, log/show/status/diff accepted). */
export function validateGitRead(subcommand: string, args: string[]): { ok: true } | { ok: false; error: string } {
  if (!GIT_READ_SUBCOMMANDS.includes(subcommand as GitReadSubcommand)) {
    return {
      ok: false,
      error: `git "${subcommand}" is not permitted in the read lane — only ${GIT_READ_SUBCOMMANDS.join(", ")} are allowed. If you need to modify or run anything, escalate to the full pipeline instead.`,
    };
  }
  const bad = args.find((a) => GIT_READ_ARG_DENY.test(a));
  if (bad) return { ok: false, error: `argument "${bad}" is not permitted — it can write a file or run an external command.` };
  return { ok: true };
}

/** Run an allowlisted read-only git subcommand in a task's repo and return its text output. Uses the
 *  hardened `runGit` (no shell, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0) and the parent-tolerant repo
 *  resolution above. Never throws — a rejection / non-repo / git error comes back as ok:false. */
export async function runReadonlyGit(workspace: string, subcommand: string, args: string[] = []): Promise<GitReadResult> {
  const v = validateGitRead(subcommand, args);
  if (!v.ok) return { ok: false, output: "", error: v.error };
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return { ok: false, output: "", error: "Not a git repository." };
  const res = await runGit(repoRoot, [subcommand, ...args]);
  const raw = res.stdout;
  const output = raw.length > OUTPUT_MAX_BYTES ? raw.slice(0, OUTPUT_MAX_BYTES) + "\n… (output truncated)" : raw;
  return {
    ok: res.code === 0,
    output: output.trim(),
    error: res.code === 0 ? null : (res.stderr.trim() || `git ${subcommand} exited ${res.code ?? "?"}`),
  };
}
