import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runChild } from "./childRunner.js";
import { config } from "./config.js";
import { restartRoute } from "./selfRestart.js";
import type { RestartRequestResult } from "./orchestrator/restartCoordinator.js";

// Self-update from git: the orchestrator periodically `git fetch`es its own checkout and reports how
// many commits the tracked upstream is ahead, so the console can surface a quiet "update available"
// badge. Applying is always user-initiated (a click on that badge) — never automatic: it `git pull`s,
// rebuilds, and (when server code changed) asks the planned-restart coordinator to bounce the process.
// The git working dir is the repo root, one level above server/ (config.serverRoot === <repo>/server).

const REPO_ROOT = resolve(config.serverRoot, "..");
// Don't hammer the remote: a background poll re-fetches at most this often (a forced refresh from a
// manual check still goes through). Matches the client's "every few minutes" poll cadence.
const FETCH_THROTTLE_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 6 * 60_000;

export interface UpdateStatus {
  /** The checked-out branch, or "HEAD" when detached. */
  branch: string | null;
  /** Commits the tracked upstream has that we don't — the badge shows when this is > 0. */
  behind: number;
  /** Local commits not yet pushed (informational; a non-zero value blocks a clean ff pull). */
  ahead: number;
  localSha: string | null;
  remoteSha: string | null;
  remoteSubject: string | null;
  /** When the last successful fetch+compare ran (epoch ms); 0 until the first one completes. */
  checkedAt: number;
  /** A human-readable reason the check is degraded (offline, detached HEAD, no upstream); null when fine. */
  error: string | null;
  /** Uncommitted local paths the upstream also changes. `git pull --ff-only` refuses to overwrite them,
   *  so while this is non-empty the update cannot apply until they are committed, stashed or discarded. */
  blockedBy: string[];
}

export interface ApplyResult {
  ok: boolean;
  /** Which step failed, when ok is false. */
  stage?: "pull" | "install" | "build";
  /** The local paths that stopped the pull, when that is why it failed. */
  blockedBy?: string[];
  /** The process supervisor has accepted an immediate restart; the client should wait, then reload. */
  restarting: boolean;
  /** The build is staged; current agents finish before the restart is fired. */
  restartDeferred: boolean;
  restartReason?: string;
  /** Server code changed but no hub was reachable to restart it — the owner must restart manually. */
  needsManualRestart: boolean;
  serverChanged: boolean;
  webChanged: boolean;
  /** How many commits were pulled in. */
  pulled: number;
  /** Trimmed stdout/stderr from the pull, any installs, and build, for surfacing in a failure. */
  log: string;
  error?: string;
}

function emptyStatus(): UpdateStatus {
  return { branch: null, behind: 0, ahead: 0, localSha: null, remoteSha: null, remoteSubject: null, checkedAt: 0, error: null, blockedBy: [] };
}

type PlannedRestart = (input: { label?: string; commit?: string; stampedAt?: number }) => RestartRequestResult;

function stagedBuildStamp(): { commit?: string; stampedAt?: number } {
  try {
    const parsed = JSON.parse(readFileSync(resolve(config.serverRoot, "dist", ".build-info.json"), "utf8")) as {
      commit?: unknown;
      at?: unknown;
    };
    return {
      ...(typeof parsed.commit === "string" ? { commit: parsed.commit } : {}),
      ...(typeof parsed.at === "number" ? { stampedAt: parsed.at } : {}),
    };
  } catch {
    return {};
  }
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd = REPO_ROOT, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  // Off the main event loop (see childRunner.ts): this poller alone spends four CreateProcess calls a
  // cycle, and on the owner's box each one blocked the whole server for up to 3.5 s.
  // GIT_TERMINAL_PROMPT=0 makes a private remote fail fast instead of blocking on a credential prompt
  // (which would hang the poll forever); GIT_OPTIONAL_LOCKS=0 keeps a read from racing an index lock
  // held by a concurrent agent's git command.
  const r = await runChild("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs,
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** Compare the working dir's HEAD against its tracked upstream (no network — read the local refs only;
 *  the caller fetches first). Exported so the ahead/behind logic can be unit-tested against a temp repo. */
export async function gitStatusAt(cwd = REPO_ROOT): Promise<UpdateStatus> {
  const out = emptyStatus();
  out.checkedAt = nowMs();

  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch.code !== 0) {
    out.error = branch.stderr.trim() || "not a git repository";
    return out;
  }
  out.branch = branch.stdout.trim();
  if (out.branch === "HEAD") out.error = "detached HEAD — can't track an upstream";

  const local = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  if (local.code === 0) out.localSha = local.stdout.trim();

  // --left-right --count of HEAD...@{u} prints "<ahead>\t<behind>" (left = ours, right = upstream's).
  const counts = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd);
  if (counts.code === 0) {
    const parts = counts.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(parts[0] ?? "", 10);
    const behind = Number.parseInt(parts[1] ?? "", 10);
    out.ahead = Number.isFinite(ahead) ? ahead : 0;
    out.behind = Number.isFinite(behind) ? behind : 0;
  } else if (!out.error) {
    out.error = "no upstream configured for this branch";
  }

  const remote = await runGit(["log", "-1", "--format=%h%x1f%s", "@{u}"], cwd);
  if (remote.code === 0) {
    const [sha, subject] = remote.stdout.trim().split("\x1f");
    out.remoteSha = sha || null;
    out.remoteSubject = subject || null;
  }
  if (out.behind > 0) out.blockedBy = await localChangesUpstreamTouches(cwd);
  return out;
}

function nulSeparated(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

/** The uncommitted paths a fast-forward to `@{u}` would have to overwrite: exactly the set that makes
 *  `git pull --ff-only` abort with "Your local changes ... would be overwritten". Any staged change and
 *  any unstaged edit blocks when the upstream changes that path; an untracked file blocks when the
 *  upstream adds one at the same path. An unstaged DELETION does not (git just checks the new version
 *  out), and dirt the upstream never touches rides the pull untouched. Both are left out on purpose:
 *  reporting them would refuse an update git itself would allow. */
async function localChangesUpstreamTouches(cwd: string): Promise<string[]> {
  const [upstream, staged, unstaged, untracked] = await Promise.all([
    runGit(["diff", "--name-only", "-z", "HEAD...@{u}"], cwd),
    runGit(["diff", "--name-only", "-z", "--cached", "HEAD"], cwd),
    runGit(["diff", "--name-only", "-z", "--diff-filter=d"], cwd),
    runGit(["ls-files", "-z", "--others", "--exclude-standard"], cwd),
  ]);
  if (upstream.code !== 0) return [];
  const incoming = new Set(nulSeparated(upstream.stdout));
  const local = [staged, unstaged, untracked].flatMap((r) => nulSeparated(r.stdout));
  return [...new Set(local.filter((path) => incoming.has(path)))].sort();
}

/** Why the checkout cannot fast-forward, in words the owner can act on; null when nothing stands in the way. */
export function updateBlocker(status: UpdateStatus, repoRoot = REPO_ROOT): string | null {
  if (status.ahead > 0 && status.behind > 0) {
    const commits = `${status.ahead} local commit${status.ahead === 1 ? "" : "s"}`;
    return `This checkout has ${commits} that the upstream does not, so it cannot fast-forward. Push or rebase ${status.ahead === 1 ? "it" : "them"} in ${repoRoot}, then update again.`;
  }
  const paths = status.blockedBy;
  if (!paths.length) return null;
  const shown = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
  const files = `${paths.length} file${paths.length === 1 ? " has" : "s have"}`;
  return `${files} uncommitted changes in ${repoRoot} that the update would overwrite: ${shown}${more}. Commit, stash or discard ${paths.length === 1 ? "it" : "them"}, then update again.`;
}

// Date.now is wrapped so the module stays mockable and the lint rule about bare Date.now in scripts
// doesn't apply here (this is server runtime, not a workflow script).
function nowMs(): number {
  return Date.now();
}

let cache: UpdateStatus = emptyStatus();
let refreshing: Promise<UpdateStatus> | null = null;
let applying = false;

/** Fetch the remote (throttled unless forced) then recompute ahead/behind. Concurrent calls share one
 *  in-flight fetch. Returns the freshly computed (or still-fresh cached) status. */
export async function refreshStatus(force = false): Promise<UpdateStatus> {
  if (refreshing) return refreshing;
  if (!force && cache.checkedAt && nowMs() - cache.checkedAt < FETCH_THROTTLE_MS) return cache;
  // A failed fetch (offline / private remote) isn't fatal — we still report the last-known local
  // comparison so the badge degrades gracefully instead of vanishing.
  const run = (async () => {
    await runGit(["fetch", "--quiet", "--prune"], REPO_ROOT, GIT_TIMEOUT_MS);
    cache = await gitStatusAt();
    return cache;
  })();
  refreshing = run;
  try {
    return await run;
  } finally {
    refreshing = null;
  }
}

/** Current cached status without forcing a network round-trip (kick a background refresh if stale). */
export function getStatus(): UpdateStatus {
  if (!applying && !refreshing && nowMs() - cache.checkedAt > FETCH_THROTTLE_MS) {
    void refreshStatus().catch(() => {});
  }
  return cache;
}

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolveP) => {
    let out = "";
    const child = spawn(npmBin(), args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onData = (c: string) => {
      out += c;
      if (out.length > 16_000) out = out.slice(-16_000); // keep a bounded tail of a noisy build
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref();
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, tail: out + String((e as Error).message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ ok: code === 0, tail: out.slice(-3000) });
    });
  });
}

function runBuild(): Promise<{ ok: boolean; tail: string }> {
  return runNpm(["run", "build"], REPO_ROOT, BUILD_TIMEOUT_MS);
}

function runInstall(cwd: string): Promise<{ ok: boolean; tail: string }> {
  return runNpm(["install", "--no-audit", "--no-fund"], cwd, INSTALL_TIMEOUT_MS);
}

const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);

function packageFileChanged(changed: string[], dir: "server" | "web"): boolean {
  const prefix = `${dir}/`;
  return changed.some((p) => p.startsWith(prefix) && PACKAGE_FILES.has(p.slice(prefix.length)));
}

function installTargets(changed: string[]): Array<{ label: string; cwd: string }> {
  const out: Array<{ label: string; cwd: string }> = [];
  if (packageFileChanged(changed, "server")) out.push({ label: "server", cwd: config.serverRoot });
  if (packageFileChanged(changed, "web")) out.push({ label: "web", cwd: resolve(REPO_ROOT, "web") });
  return out;
}

/** Mark `res` as a pull that cannot proceed when `status` says so; true when it did. */
function refuseBlocked(res: ApplyResult, status: UpdateStatus): boolean {
  const blocker = updateBlocker(status);
  if (!blocker) return false;
  res.stage = "pull";
  res.blockedBy = status.blockedBy;
  res.error = blocker;
  return true;
}

/** Pull the latest upstream, install changed package sets, rebuild, and (if server code changed) restart. User-initiated only. */
export async function applyUpdate(requestRestart: PlannedRestart): Promise<ApplyResult> {
  const res: ApplyResult = {
    ok: false,
    restarting: false,
    restartDeferred: false,
    needsManualRestart: false,
    serverChanged: false,
    webChanged: false,
    pulled: 0,
    log: "",
  };
  if (applying) {
    res.error = "an update is already in progress";
    return res;
  }
  applying = true;
  try {
    // Refuse up front, naming the files, rather than letting the pull abort with git's raw stderr: a
    // leftover edit in this shared checkout otherwise fails every click the same unexplained way.
    if (refuseBlocked(res, await refreshStatus(true))) return res;

    const before = (await runGit(["rev-parse", "HEAD"])).stdout.trim();

    const pull = await runGit(["pull", "--ff-only"], REPO_ROOT, GIT_TIMEOUT_MS);
    res.log += `$ git pull --ff-only\n${(pull.stdout + pull.stderr).trim()}\n`;
    if (pull.code !== 0) {
      // The pull fetched again, so a file dirtied or a commit pushed since the check can still stop it.
      cache = await gitStatusAt();
      if (refuseBlocked(res, cache)) return res;
      res.stage = "pull";
      res.error = pull.stderr.trim() || "git pull failed";
      return res;
    }

    const after = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
    let changed: string[] = [];
    if (before && after && before !== after) {
      changed = (await runGit(["diff", "--name-only", `${before}..${after}`])).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      res.serverChanged = changed.some((p) => p.startsWith("server/"));
      res.webChanged = changed.some((p) => p.startsWith("web/"));
      const count = await runGit(["rev-list", "--count", `${before}..${after}`]);
      res.pulled = Number.parseInt(count.stdout.trim(), 10) || 0;
    }

    for (const target of installTargets(changed)) {
      const install = await runInstall(target.cwd);
      res.log += `$ npm install --no-audit --no-fund (${target.label})\n${install.tail.trim()}\n`;
      if (!install.ok) {
        res.stage = "install";
        res.error = `npm install failed for ${target.label} - see the server log`;
        return res;
      }
    }

    // Rebuild web (so an open client reloads onto the new bundle) and server (keeps dist/ fresh for a
    // prod `npm start`). Cheap no-op when the pull brought nothing — but we still rebuild so a partial
    // earlier deploy is healed.
    const build = await runBuild();
    res.log += `$ npm run build\n${build.tail.trim()}\n`;
    if (!build.ok) {
      res.stage = "build";
      res.error = "rebuild failed — see the server log";
      return res;
    }

    res.ok = true;
    cache = await gitStatusAt(); // behind should now be 0

    // Backend code changed → stage one planned restart. Owner updates use the same drain as agent
    // deploys: the current cohort finishes and fresh work pauses, so clicking Update cannot kill an
    // active agent. If no process owner exists, report the one unavoidable manual step instead.
    if (res.serverChanged) {
      if ((await restartRoute()) === "none") {
        res.needsManualRestart = true;
      } else {
        const restart = requestRestart({ label: "owner update", ...stagedBuildStamp() });
        res.restarting = restart.outcome === "restarting";
        res.restartDeferred = restart.outcome === "deferred";
        res.restartReason = restart.reason;
      }
    }
    return res;
  } finally {
    applying = false;
  }
}

/** Start the background poll so the badge is warm without waiting on a client request. */
export function startUpdatePoll(): void {
  void refreshStatus(true).catch(() => {});
  setInterval(() => void refreshStatus(true).catch(() => {}), FETCH_THROTTLE_MS).unref();
}
