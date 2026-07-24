import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config } from "./config.js";
import { SUPERVISED_RESTART_CODE } from "./crashLog.js";

// Self-update from git: the orchestrator periodically `git fetch`es its own checkout and reports how
// many commits the tracked upstream is ahead, so the console can surface a quiet "update available"
// badge. Applying is always user-initiated (a click on that badge) — never automatic: it `git pull`s,
// rebuilds, and (when server code changed) bounces the process via the script-hub. The git working
// dir is the repo root, one level above the server folder (config.serverRoot === <repo>/server).

const REPO_ROOT = resolve(config.serverRoot, "..");
// Don't hammer the remote: a background poll re-fetches at most this often (a forced refresh from a
// manual check still goes through). Matches the client's "every few minutes" poll cadence.
const FETCH_THROTTLE_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 6 * 60_000;
// The script-hub that owns this server's process on the Windows deployment. Its atomic restart re-arms
// keepAlive and survives the caller being killed mid-restart (see CLAUDE.md "Deploying a change").
const HUB_URL = (process.env.SCRIPT_HUB_URL || "http://127.0.0.1:3939").replace(/\/$/, "");
const HUB_ID = process.env.SCRIPT_HUB_ID || "claude-orchestrator";

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
}

export interface ApplyResult {
  ok: boolean;
  /** Which step failed, when ok is false. */
  stage?: "pull" | "install" | "build";
  /** The server is being restarted by the hub; the client should wait for it to come back, then reload. */
  restarting: boolean;
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
  return { branch: null, behind: 0, ahead: 0, localSha: null, remoteSha: null, remoteSubject: null, checkedAt: 0, error: null };
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd = REPO_ROOT, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    // GIT_TERMINAL_PROMPT=0 makes a private remote fail fast instead of blocking on a credential
    // prompt (which would hang the poll forever); GIT_OPTIONAL_LOCKS=0 keeps a read from racing an
    // index lock held by a concurrent agent's git command.
    const child = spawn("git", args, {
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
    child.stdout.on("data", (c: string) => (stdout += c));
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
  return out;
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

async function hubReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${HUB_URL}/`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return !!r; // any HTTP response means the hub process is up (even a 404)
  } catch {
    return false;
  }
}

// Fire the atomic restart AFTER the apply response has flushed (the hub tree-kills this process, so we
// can't await it). The rebooted server auto-resumes in-flight tasks; the client polls health and reloads.
function scheduleRestart(): void {
  setTimeout(() => {
    void fetch(`${HUB_URL}/api/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: HUB_ID }),
    }).catch(() => {});
  }, 800);
}

// Under the process supervisor (server/scripts/supervise.cjs, the `serve` path) there is no script-hub —
// a self-restart is a clean exit with the agreed code, which the supervisor treats as a requested restart
// and respawns onto the freshly-built source without counting a crash. Fires after the apply response has
// flushed, mirroring scheduleRestart.
function scheduleSupervisedRestart(): void {
  setTimeout(() => process.exit(SUPERVISED_RESTART_CODE), 800);
}

/** Pull the latest upstream, install changed package sets, rebuild, and (if server code changed) restart. User-initiated only. */
export async function applyUpdate(): Promise<ApplyResult> {
  const res: ApplyResult = {
    ok: false,
    restarting: false,
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
    const before = (await runGit(["rev-parse", "HEAD"])).stdout.trim();

    const pull = await runGit(["pull", "--ff-only"], REPO_ROOT, GIT_TIMEOUT_MS);
    res.log += `$ git pull --ff-only\n${(pull.stdout + pull.stderr).trim()}\n`;
    if (pull.code !== 0) {
      res.stage = "pull";
      // The usual culprits: local edits, or the branch diverged so a fast-forward isn't possible.
      res.error = pull.stderr.trim() || "git pull failed (local changes or a diverged branch?)";
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

    // Backend code changed → the running process must restart to load it. Under the supervisor, exit with
    // the restart code and let it respawn; otherwise prefer the hub's atomic restart; if neither owns this
    // process, the web is already rebuilt, so report that the server side needs a manual restart rather
    // than silently leaving stale backend code running.
    if (res.serverChanged) {
      if (process.env.ORCH_SUPERVISED === "1") {
        res.restarting = true;
        scheduleSupervisedRestart();
      } else if (await hubReachable()) {
        res.restarting = true;
        scheduleRestart();
      } else {
        res.needsManualRestart = true;
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
