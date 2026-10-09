import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runChild, runChildInProcess, type ChildResult } from "../childRunner.js";
import { runGit } from "../gitService.js";
import { isConfiguredCommitOnlyOrigin } from "../git/commitOnly.js";
import type { CodexLauncher } from "../agents/codexLauncher.js";
import type { RestartRequestResult } from "../orchestrator/restartCoordinator.js";
import type { CliAutoUpdateStatus, CliUpdateComponent } from "../types.js";

// Keeps the two agent CLIs GGO launches on their latest release, so a newly released model runs the day
// it ships instead of failing on a CLI that predates it (Codex rejected a new model until its CLI was
// upgraded; Claude's model/effort support moves with the runtime).
//
// Neither is ever installed in place. npm killed mid-install (a deploy restarts GGO many times a day)
// leaves a half-written package behind — for the Agent SDK that means GGO can't even boot. So each
// release is installed into a scratch STAGING folder, where a kill costs nothing, and the finished
// package folders are then swapped into place by rename, which takes milliseconds.
//  - Claude runs on the Claude Code binary BUNDLED with @anthropic-ai/claude-agent-sdk, a dependency of
//    this checkout (the global `claude` command is not what GGO launches). The new lockfile is resolved
//    in a copy of the package files, the packages it moves are staged and swapped in, then the tree is
//    typechecked, ONLY the two package files are committed and pushed, and GGO restarts through the
//    restart coordinator. A durable marker lets the next process finish or undo a bump a restart cut off.
//  - Codex is the global npm package, staged with `-g --prefix` and swapped in while no Codex run is live.

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CODEX_PACKAGE = "@openai/codex";
const CHECK_EVERY_MS = 6 * 60 * 60_000;
// Not at boot: a restart is often a deploy, and the first minutes after one belong to resuming agents.
const FIRST_CHECK_MS = 5 * 60_000;
// A Codex turn in flight, a tree that doesn't typecheck or a network blip is a passing condition.
const RETRY_SOON_MS = 20 * 60_000;
const REGISTRY_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const TYPECHECK_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
// An operator's global git hook suite runs on every commit and can take minutes on a loaded box. Killing git
// mid-commit strands .git/index.lock for every agent, so the deadline is generous.
const COMMIT_TIMEOUT_MS = 10 * 60_000;
// Another agent committing in this shared checkout holds index.lock for a few seconds.
const COMMIT_LOCK_RETRIES = 6;
const COMMIT_LOCK_WAIT_MS = 5_000;
const PACKAGE_FILES = ["server/package.json", "server/package-lock.json"];
const STATUS_KEY = "cli_auto_update_status";
const FAILED_SDK_KEY = "cli_auto_update_failed_sdk";
const INFLIGHT_KEY = "cli_auto_update_inflight";

export interface RegistryRelease {
  version: string;
  claudeCodeVersion?: string | null;
}

type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; long?: boolean }) => Promise<ChildResult>;

export interface CliAutoUpdaterDeps {
  repoRoot: string;
  serverRoot: string;
  /** Scratch space for staged installs; defaults to `<serverRoot>/data/cli-auto-update` (same volume,
   *  so the swap is a rename). */
  stageRoot?: string;
  /** NO_PUSH_REPO_PATTERN: a bump in a checkout whose remote matches it is committed, never pushed. */
  noPushRepoPattern?: string;
  kvGet: (key: string) => string | null | undefined;
  kvSet: (key: string, value: string) => void;
  enabled: () => boolean;
  /** Set when this process must never update anything — a lab, test or second instance on its own
   *  DATA_DIR shares the checkout and the global npm prefix with the real one. */
  standDownReason?: string | null;
  publish: (status: CliAutoUpdateStatus) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  codexLauncher: () => CodexLauncher;
  codexBusy: () => boolean;
  /** The Agent SDK version this process loaded at boot (not what is on disk now). */
  loadedSdkVersion: () => string | null;
  /** Checkout state from the self-update poller: fetches, then compares HEAD with its upstream. */
  upstream: () => Promise<{ branch: string | null; behind: number; error: string | null }>;
  /** Take the checkout for the swap + commit; null while an owner update is running. */
  claimCheckout: () => (() => void) | null;
  restartAvailable: () => Promise<boolean>;
  requestRestart: (label: string) => RestartRequestResult;
  fetchLatest?: (pkg: string) => Promise<RegistryRelease>;
  exec?: Exec;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A package folder moved aside by a swap, so the swap can be undone. `aside` is null for a new package. */
interface Swapped {
  live: string;
  aside: string | null;
}

/** The durable record of an Agent SDK bump between its swap and its commit. */
interface InflightBump {
  version: string;
  claudeCodeVersion: string | null;
  /** The package files as they were before the bump, restored verbatim on an undo. */
  before: { pkg: string; lock: string };
  /** Hashes of the package files the bump wrote; anything else there is someone else's edit. */
  wrote: { pkg: string; lock: string };
  swapped: Swapped[];
}

type Base = Omit<CliUpdateComponent, "state" | "detail" | "at">;

export function emptyCliAutoUpdateStatus(): CliAutoUpdateStatus {
  const blank = (): CliUpdateComponent => ({ installed: null, latest: null, state: "unknown", detail: "Not checked yet.", at: 0 });
  return { claude: { ...blank(), runtime: null }, codex: blank(), checkedAt: 0, nextCheckAt: 0 };
}

/** -1 / 0 / 1 for dotted numeric versions; null when either isn't one (a prerelease, say). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i]! - right[i]!);
  return 0;
}

const isStable = (v: string | null | undefined): boolean => compareVersions(v, v) !== null;

export async function fetchLatestRelease(pkg: string): Promise<RegistryRelease> {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the npm registry answered HTTP ${res.status}`);
  const body = (await res.json()) as { version?: unknown; claudeCodeVersion?: unknown };
  if (typeof body.version !== "string" || !isStable(body.version)) throw new Error("the npm registry named no stable version");
  return { version: body.version, claudeCodeVersion: typeof body.claudeCodeVersion === "string" ? body.claudeCodeVersion : null };
}

/** npm's own CLI script beside this Node, so npm runs without a shell (a `.cmd` can't be spawned bare). */
export function npmCommand(): { cmd: string; prefix: string[] } {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const script = candidates.find((p): p is string => !!p && /npm-cli\.js$/.test(p) && existsSync(p));
  if (script) return { cmd: process.execPath, prefix: [script] };
  return process.platform === "win32" ? { cmd: "cmd.exe", prefix: ["/d", "/s", "/c", "npm"] } : { cmd: "npm", prefix: [] };
}

interface LockEntry {
  version?: string;
  name?: string;
  os?: string[];
  cpu?: string[];
}

export interface LockChange {
  /** The lockfile key, e.g. `node_modules/@anthropic-ai/claude-agent-sdk` — also its path under server/. */
  key: string;
  name: string;
  version: string;
  /** What to ask npm for when staging it (an `npm:` alias when the lock installs it under another name). */
  spec: string;
}

/**
 * The top-level packages a new lockfile installs at a different version than the old one did, limited to
 * those this platform actually installs. `nested` lists changes inside another package's own
 * node_modules, which a folder swap can't express. `installed` names the version on disk for a key whose
 * lock entry did not move; a different answer still swaps it (a pulled lockfile is never installed).
 */
export function lockChanges(
  before: unknown,
  after: unknown,
  platform: string = process.platform,
  arch: string = process.arch,
  installed: (key: string) => string | null = () => null,
): { swap: LockChange[]; nested: string[] } {
  const packages = (lock: unknown): Record<string, LockEntry> => ((lock as { packages?: Record<string, LockEntry> })?.packages ?? {});
  const old = packages(before);
  const swap: LockChange[] = [];
  const nested: string[] = [];
  for (const [key, entry] of Object.entries(packages(after))) {
    if (!key.startsWith("node_modules/") || typeof entry.version !== "string") continue;
    const prior = old[key];
    const onDisk = installed(key);
    if (prior?.version === entry.version && prior?.name === entry.name && (onDisk === null || onDisk === entry.version)) continue;
    if (!fitsPlatform(entry, platform, arch)) continue;
    const name = key.slice("node_modules/".length);
    if (name.includes("/node_modules/")) {
      nested.push(name);
      continue;
    }
    const spec = entry.name && entry.name !== name ? `npm:${entry.name}@${entry.version}` : entry.version;
    swap.push({ key, name, version: entry.version, spec });
  }
  return { swap, nested };
}

function fitsPlatform(entry: LockEntry, platform: string, arch: string): boolean {
  const allows = (list: string[] | undefined, value: string): boolean => {
    if (!list?.length) return true;
    if (list.includes(`!${value}`)) return false;
    const positive = list.filter((v) => !v.startsWith("!"));
    return !positive.length || positive.includes(value);
  };
  return allows(entry.os, platform) && allows(entry.cpu, arch);
}

const defaultExec: Exec = (cmd, args, { cwd, timeoutMs, long }) =>
  // Minutes-long installs and typechecks would pin one of the two pool workers the git reads share.
  cmd === "git" ? runGit(cwd, args, timeoutMs) : long ? runChildInProcess(cmd, args, { cwd, timeoutMs }) : runChild(cmd, args, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });

function readManifest(file: string): { version: string | null; claudeCodeVersion: string | null; optionalDependencies: Record<string, string> } {
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; claudeCodeVersion?: unknown; optionalDependencies?: unknown };
    return {
      version: typeof body.version === "string" ? body.version : null,
      claudeCodeVersion: typeof body.claudeCodeVersion === "string" ? body.claudeCodeVersion : null,
      optionalDependencies: body.optionalDependencies && typeof body.optionalDependencies === "object" ? (body.optionalDependencies as Record<string, string>) : {},
    };
  } catch {
    return { version: null, claudeCodeVersion: null, optionalDependencies: {} };
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const hash = (text: string | null): string => createHash("sha256").update(text ?? "").digest("hex");

function tail(result: ChildResult): string {
  const text = `${result.stderr}\n${result.stdout}`.replace(/\s+/g, " ").trim();
  return (result.timedOut ? "timed out: " : "") + (text.length > 300 ? `…${text.slice(-300)}` : text || `exit ${result.code}`);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Remove the `.name-XXXX` copies npm (and a swap here) leaves when it replaces an install whose files are
 * in use. A copy whose binary is still running is left for a later pass: deleting around a live
 * executable kills the agent turn using it. Renaming is no probe (Windows lets a running exe's folder be
 * renamed), but opening the binary for writing is — Windows refuses that for a mapped image.
 */
export function sweepAsideCopies(scopeDir: string, packageName: string): number {
  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return 0;
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}-[A-Za-z0-9]+$`);
  let removed = 0;
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const dir = join(scopeDir, entry);
    if (process.platform === "win32" && binaryInUse(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* partly removed; the rest goes on the next pass */
    }
  }
  return removed;
}

function binaryInUse(dir: string): boolean {
  const walk = (at: string): boolean => {
    let names: Dirent[];
    try {
      names = readdirSync(at, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const name of names) {
      const path = join(at, name.name);
      if (name.isDirectory()) {
        if (walk(path)) return true;
      } else if (/\.(exe|dll|node)$/i.test(name.name)) {
        try {
          closeSync(openSync(path, "r+"));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
        }
      }
    }
    return false;
  };
  return walk(dir);
}

let asideSeq = 0;

/** A sibling name `sweepAsideCopies` recognises for this package folder. */
function asideName(live: string): string {
  return join(dirname(live), `.${basename(live)}-ggo${Date.now().toString(36)}${(asideSeq++).toString(36)}`);
}

/** A scanner (Defender) briefly holding a file refuses a rename; it clears within a second. Synchronous on
 *  purpose: nothing may spawn a CLI between the two renames of a swap. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

/** Move each staged folder into its live place, the live one aside. All or nothing. */
function swapIn(pairs: Array<{ live: string; staged: string }>): Swapped[] {
  const done: Swapped[] = [];
  try {
    for (const { live, staged } of pairs) {
      mkdirSync(dirname(live), { recursive: true });
      const aside = existsSync(live) ? asideName(live) : null;
      if (aside) renameWithRetry(live, aside);
      try {
        renameWithRetry(staged, live);
      } catch (error) {
        if (aside) renameWithRetry(aside, live);
        throw error;
      }
      done.push({ live, aside });
    }
    return done;
  } catch (error) {
    swapBack(done);
    throw error;
  }
}

/** Put the folders a swap moved aside back. The swapped-in copy is renamed aside for the sweep. */
function swapBack(swapped: Swapped[]): void {
  for (const { live, aside } of [...swapped].reverse()) {
    if (aside && !existsSync(aside)) continue;
    if (existsSync(live)) renameWithRetry(live, asideName(live));
    if (aside) renameWithRetry(aside, live);
  }
}

export class CliAutoUpdater {
  private status: CliAutoUpdateStatus;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private restartRequested = false;
  /** Set by a step that failed for a reason expected to clear (network, a lock, a busy file). */
  private retrySoon = false;
  private readonly exec: Exec;
  private readonly fetchLatest: (pkg: string) => Promise<RegistryRelease>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stageRoot: string;

  constructor(private readonly deps: CliAutoUpdaterDeps) {
    this.exec = deps.exec ?? defaultExec;
    this.fetchLatest = deps.fetchLatest ?? fetchLatestRelease;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.stageRoot = deps.stageRoot ?? join(deps.serverRoot, "data", "cli-auto-update");
    this.status = this.initialStatus();
    // Published at construction, before the server listens, so the first connect snapshot carries it.
    this.deps.publish(this.status);
  }

  start(): void {
    if (this.deps.standDownReason) return;
    this.schedule(this.deps.enabled() ? FIRST_CHECK_MS : null);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  current(): CliAutoUpdateStatus {
    return this.status;
  }

  /** The Settings toggle moved: check straight away when switched on, stand down when switched off. */
  toggled(on: boolean): void {
    if (this.deps.standDownReason) return;
    if (on) void this.checkNow();
    else this.schedule(null);
  }

  /** Run one full check (both CLIs). Concurrent callers share the check already in flight. */
  checkNow(): Promise<void> {
    if (this.deps.standDownReason) return Promise.resolve();
    if (!this.running) {
      this.running = this.check().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async check(): Promise<void> {
    if (!this.deps.enabled()) {
      this.schedule(null);
      return;
    }
    this.retrySoon = false;
    try {
      const codex = await this.updateCodex();
      this.set("codex", codex);
      // Switched off while Codex was checked: the Claude bump commits and restarts, so it must not start.
      if (this.deps.enabled()) {
        const claude = await this.updateClaude();
        this.set("claude", claude);
        this.retrySoon ||= claude.state === "waiting";
      }
      this.retrySoon ||= codex.state === "waiting";
    } catch (error) {
      this.deps.log("error", `CLI auto-update: the check crashed — ${reason(error)}`);
    }
    this.status = { ...this.status, checkedAt: this.now() };
    this.schedule(!this.deps.enabled() ? null : this.retrySoon ? RETRY_SOON_MS : CHECK_EVERY_MS);
  }

  private schedule(delayMs: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (delayMs !== null) {
      this.timer = setTimeout(() => void this.checkNow(), delayMs);
      this.timer.unref?.();
    }
    this.status = { ...this.status, nextCheckAt: delayMs === null ? 0 : this.now() + delayMs };
    this.save();
  }

  private set(which: "claude" | "codex", component: CliUpdateComponent): void {
    this.status = { ...this.status, [which]: component };
    this.save();
  }

  private save(): void {
    this.deps.kvSet(STATUS_KEY, JSON.stringify(this.status));
    this.deps.publish(this.status);
  }

  private initialStatus(): CliAutoUpdateStatus {
    const why = this.deps.standDownReason;
    if (!why) return this.restore();
    const unmanaged = (c: CliUpdateComponent): CliUpdateComponent => ({ ...c, state: "unmanaged", detail: why, at: this.now() });
    const blank = emptyCliAutoUpdateStatus();
    return { ...blank, claude: unmanaged(blank.claude), codex: unmanaged(blank.codex) };
  }

  private restore(): CliAutoUpdateStatus {
    const blank = emptyCliAutoUpdateStatus();
    try {
      const saved = JSON.parse(this.deps.kvGet(STATUS_KEY) ?? "") as Partial<CliAutoUpdateStatus>;
      // A state saved mid-flight belongs to a process that is gone; the next check rewrites it anyway.
      const settle = (c: CliUpdateComponent | undefined, fallback: CliUpdateComponent): CliUpdateComponent =>
        c && typeof c === "object" && typeof c.state === "string"
          ? c.state === "updating"
            ? { ...c, state: "unknown", detail: "An update was cut off by a restart; the next check finishes or undoes it." }
            : c
          : fallback;
      return { claude: settle(saved.claude, blank.claude), codex: settle(saved.codex, blank.codex), checkedAt: Number(saved.checkedAt) || 0, nextCheckAt: 0 };
    } catch {
      return blank;
    }
  }

  private component(fields: Omit<CliUpdateComponent, "at">): CliUpdateComponent {
    return { ...fields, at: this.now() };
  }

  /** A failure expected to clear by itself: reported as failed, looked at again soon, never banned. */
  private transient(fields: Omit<CliUpdateComponent, "at" | "state">): CliUpdateComponent {
    this.retrySoon = true;
    return this.component({ ...fields, state: "failed" });
  }

  private async latest(pkg: string): Promise<RegistryRelease | string> {
    try {
      return await this.fetchLatest(pkg);
    } catch (error) {
      return reason(error);
    }
  }

  private npm(args: string[], cwd: string): Promise<ChildResult> {
    const { cmd, prefix } = npmCommand();
    return this.exec(cmd, [...prefix, ...args, "--no-audit", "--no-fund"], { cwd, timeoutMs: INSTALL_TIMEOUT_MS, long: true });
  }

  private git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ChildResult> {
    return this.exec("git", args, { cwd: this.deps.repoRoot, timeoutMs });
  }

  /** A clean scratch folder under the stage root. */
  private freshStage(name: string): string {
    const dir = join(this.stageRoot, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---- Codex: the global npm install ----

  private async updateCodex(): Promise<CliUpdateComponent> {
    const launcher = this.deps.codexLauncher();
    if (launcher.source === "desktop") {
      return this.component({ installed: null, latest: null, state: "unmanaged", detail: "Codex runs from Codex Desktop, which updates itself." });
    }
    if (launcher.source === "npm-override") {
      return this.component({ installed: null, latest: null, state: "unmanaged", detail: `CODEX_BIN_JS points at ${launcher.path}; GGO leaves a pinned CLI alone.` });
    }
    if (!existsSync(launcher.path)) {
      return this.component({ installed: null, latest: null, state: "absent", detail: "The Codex CLI is not installed." });
    }
    const packageDir = resolve(dirname(launcher.path), "..");
    const installed = readManifest(join(packageDir, "package.json")).version;
    if (installed && !isStable(installed)) {
      return this.component({ installed, latest: null, state: "unmanaged", detail: `Codex ${installed} is a prerelease; GGO leaves a deliberately installed build alone.` });
    }
    const latest = await this.latest(CODEX_PACKAGE);
    if (typeof latest === "string") return this.transient({ installed, latest: null, detail: `Could not read the latest release: ${latest}` });
    const base = { installed, latest: latest.version };
    if (!this.deps.codexBusy()) sweepAsideCopies(dirname(packageDir), "codex");
    if ((compareVersions(installed, latest.version) ?? -1) >= 0) {
      return this.component({ ...base, state: "current", detail: `Codex CLI ${installed} is the latest release.` });
    }
    const waiting = (detail: string) => this.component({ ...base, state: "waiting", detail });
    if (this.deps.codexBusy()) return waiting(`Codex ${latest.version} is out; installing once no Codex agent is mid-turn.`);
    if (!this.deps.enabled()) return waiting("Auto-update was switched off before the install.");

    this.set("codex", this.component({ ...base, state: "updating", detail: `Downloading Codex CLI ${latest.version}…` }));
    const staged = await this.stageCodex(latest.version);
    if (typeof staged !== "string" || !existsSync(staged)) {
      const why = typeof staged === "string" ? "the staged copy vanished" : staged.error;
      this.deps.log("warn", `CLI auto-update: Codex ${latest.version} did not stage — ${why}`);
      return this.transient({ ...base, detail: `Downloading Codex ${latest.version} failed: ${why}` });
    }
    // Re-checked right before the swap: the renames below are synchronous, so nothing can launch Codex
    // between this check and the new copy being in place.
    if (this.deps.codexBusy()) return waiting(`Codex ${latest.version} is downloaded; swapping it in once no Codex agent is mid-turn.`);
    try {
      swapIn([{ live: packageDir, staged }]);
    } catch (error) {
      this.deps.log("warn", `CLI auto-update: swapping in Codex ${latest.version} failed — ${reason(error)}`);
      return this.transient({ ...base, detail: `Swapping in Codex ${latest.version} failed: ${reason(error)}. The previous CLI is untouched.` });
    }
    const after = readManifest(join(packageDir, "package.json")).version;
    sweepAsideCopies(dirname(packageDir), "codex");
    this.deps.log("info", `CLI auto-update: Codex CLI ${installed ?? "?"} → ${after}; the next Codex turn runs on it.`);
    return this.component({ installed: after, latest: latest.version, state: "updated", detail: `Updated from ${installed ?? "an unreadable version"}; new Codex turns run on ${after}.` });
  }

  /** Install the release into a global-style scratch prefix; the package folder it produced, or why not. */
  private async stageCodex(version: string): Promise<string | { error: string }> {
    const prefix = this.freshStage("codex");
    const install = await this.npm(["install", "-g", "--prefix", prefix, `${CODEX_PACKAGE}@${version}`], this.deps.serverRoot);
    if (install.code !== 0) return { error: tail(install) };
    const staged = [join(prefix, "node_modules", "@openai", "codex"), join(prefix, "lib", "node_modules", "@openai", "codex")].find((p) => existsSync(p));
    if (!staged) return { error: "npm reported success but the staged package is missing" };
    const manifest = readManifest(join(staged, "package.json"));
    if (manifest.version !== version) return { error: `the staged package is ${manifest.version ?? "unreadable"}, not ${version}` };
    const native = `@openai/codex-${process.platform}-${process.arch}`;
    if (native in manifest.optionalDependencies && !existsSync(join(staged, "node_modules", ...native.split("/")))) {
      return { error: `the staged package is missing its ${native} binary` };
    }
    return staged;
  }

  // ---- Claude: the Agent SDK dependency of this checkout ----

  private sdkManifest(): { version: string | null; claudeCodeVersion: string | null } {
    return readManifest(join(this.deps.serverRoot, "node_modules", ...SDK_PACKAGE.split("/"), "package.json"));
  }

  private packageFile(which: "pkg" | "lock"): string {
    return join(this.deps.serverRoot, which === "pkg" ? "package.json" : "package-lock.json");
  }

  private async updateClaude(): Promise<CliUpdateComponent> {
    const recovered = await this.recoverInterruptedBump();
    if (recovered) return recovered;
    const onDisk = this.sdkManifest();
    const base = { installed: onDisk.version, runtime: onDisk.claudeCodeVersion };
    this.sweepSdkAsides();
    if (!onDisk.version) {
      return this.component({ ...base, latest: null, state: "failed", detail: "The installed Agent SDK has no readable version — run npm install in server/." });
    }
    if (!isStable(onDisk.version)) {
      return this.component({ ...base, latest: null, state: "unmanaged", detail: `Agent SDK ${onDisk.version} is a prerelease; GGO leaves a deliberately pinned build alone.` });
    }
    const latest = await this.latest(SDK_PACKAGE);
    if (typeof latest === "string") return this.transient({ ...base, latest: null, detail: `Could not read the latest release: ${latest}` });
    const withLatest = { ...base, latest: latest.version };
    if ((compareVersions(onDisk.version, latest.version) ?? -1) >= 0) return this.loadIfStaged(withLatest);
    const banned = this.bannedDetail(latest.version);
    if (banned) return this.component({ ...withLatest, state: "failed", detail: banned });
    const blocker = await this.bumpBlocker();
    if (blocker) return this.component({ ...withLatest, state: "waiting", detail: blocker });
    return this.bumpSdk(withLatest, latest);
  }

  /** Old SDK folders a swap or npm moved aside; one whose claude.exe a live agent still runs stays. */
  private sweepSdkAsides(): void {
    const scope = join(this.deps.serverRoot, "node_modules", "@anthropic-ai");
    for (const name of ["claude-agent-sdk", `claude-agent-sdk-${process.platform}-${process.arch}`]) sweepAsideCopies(scope, name);
  }

  /** The recorded reason this exact release was refused, if it was. */
  private bannedDetail(version: string): string | null {
    try {
      const prior = JSON.parse(this.deps.kvGet(FAILED_SDK_KEY) ?? "") as { version?: string; detail?: string };
      return prior.version === version ? (prior.detail ?? `Agent SDK ${version} could not be applied; waiting for the next release.`) : null;
    } catch {
      return null;
    }
  }

  /** The SDK on disk is current but this process loaded an older one — a bump whose restart never
   *  happened. Load it, once per process, but only when the bump is committed (never someone's WIP). */
  private async loadIfStaged(base: Base): Promise<CliUpdateComponent> {
    const loaded = this.deps.loadedSdkVersion();
    const behind = (compareVersions(loaded, base.installed) ?? 0) < 0;
    if (!behind) {
      const sdk = `Agent SDK ${base.installed}`;
      return this.component({ ...base, state: "current", detail: `${base.runtime ? `Claude Code ${base.runtime} (${sdk})` : sdk} is the latest release.` });
    }
    const dirty = await this.git(["status", "--porcelain", "--", ...PACKAGE_FILES]);
    if (dirty.code !== 0 || dirty.stdout.trim()) {
      return this.component({ ...base, state: "waiting", detail: `Agent SDK ${base.installed} is on disk but uncommitted; GGO still runs ${loaded}.` });
    }
    return this.restartOnto(base, `Agent SDK ${base.installed} is installed; GGO still runs ${loaded}`);
  }

  private async restartOnto(base: Base, what: string): Promise<CliUpdateComponent> {
    if ((compareVersions(this.deps.loadedSdkVersion(), base.installed) ?? -1) >= 0) {
      return this.component({ ...base, state: "updated", detail: `${what}; GGO already runs it.` });
    }
    if (!(await this.deps.restartAvailable())) {
      return this.component({ ...base, state: "updated", detail: `${what}. Nothing supervises this server, so restart GGO to load it.` });
    }
    if (this.restartRequested) {
      return this.component({ ...base, state: "updated", detail: `${what}. A restart was already requested.` });
    }
    this.restartRequested = true;
    const restart = this.deps.requestRestart("Claude runtime auto-update");
    this.deps.log("info", `CLI auto-update: ${what} — restarting (${restart.reason}).`);
    return this.component({ ...base, state: "updated", detail: `${what}; restarting GGO to load it. Interrupted agents resume on it.` });
  }

  /** Why the checkout can't take an automatic dependency commit right now, or null when it can. */
  private async bumpBlocker(): Promise<string | null> {
    const dirty = await this.git(["status", "--porcelain", "--", ...PACKAGE_FILES]);
    if (dirty.code !== 0) return `git status failed: ${tail(dirty)}`;
    if (dirty.stdout.trim()) return "server/package.json or its lockfile has uncommitted changes; the bump waits so it never commits someone else's edit.";
    const upstream = await this.deps.upstream();
    if (!upstream.branch || upstream.branch === "HEAD") return "The checkout is on a detached HEAD; there is no branch to commit the bump to.";
    if (upstream.error) return `Could not confirm the checkout is up to date with its upstream: ${upstream.error}`;
    if (upstream.behind > 0) {
      return `The checkout is ${upstream.behind} commit${upstream.behind === 1 ? "" : "s"} behind its upstream; pull first (the upstream may already carry this bump).`;
    }
    return null;
  }

  private typecheck(): Promise<ChildResult> {
    const tsc = join(this.deps.serverRoot, "node_modules", "typescript", "bin", "tsc");
    return this.exec(process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], { cwd: this.deps.serverRoot, timeoutMs: TYPECHECK_TIMEOUT_MS, long: true });
  }

  private async bumpSdk(base: Base, to: RegistryRelease): Promise<CliUpdateComponent> {
    const target = `Agent SDK ${to.version}${to.claudeCodeVersion ? ` (Claude Code ${to.claudeCodeVersion})` : ""}`;
    const waiting = (detail: string) => this.component({ ...base, state: "waiting", detail });
    // The tree has to typecheck BEFORE the swap, or a failure after it can't be blamed on the SDK. First,
    // too: it is cheaper than the download it would otherwise repeat every retry.
    const baseline = await this.typecheck();
    if (baseline.code !== 0) return waiting("The working tree does not typecheck right now (an edit in progress), so a bump could not be verified; retrying soon.");
    this.set("claude", this.component({ ...base, state: "updating", detail: `Downloading ${target}…` }));
    const plan = await this.stageSdk(to.version);
    if ("error" in plan) {
      const detail = `${target} was not applied — ${plan.error}.`;
      this.deps.log("warn", `CLI auto-update: ${detail}`);
      if (plan.ban) {
        this.deps.kvSet(FAILED_SDK_KEY, JSON.stringify({ version: to.version, detail }));
        return this.component({ ...base, state: "failed", detail });
      }
      return this.transient({ ...base, detail });
    }
    if (!this.deps.enabled()) return waiting("Auto-update was switched off before the install.");
    const release = this.deps.claimCheckout();
    if (!release) return waiting("Waiting for the GGO update in progress to finish.");
    try {
      return await this.applySdk(base, to, plan);
    } finally {
      release();
    }
  }

  /**
   * Resolve the new lockfile in a copy of the package files and install every package it moves into a
   * scratch tree. Nothing in the checkout changes; `ban` marks a refusal that retrying won't cure.
   */
  private async stageSdk(version: string): Promise<{ before: { pkg: string; lock: string }; after: { pkg: string; lock: string }; staged: Array<{ key: string; dir: string }> } | { error: string; ban?: boolean }> {
    const before = { pkg: readText(this.packageFile("pkg")), lock: readText(this.packageFile("lock")) };
    if (before.pkg === null || before.lock === null) return { error: "server/package.json or its lockfile is unreadable" };
    const lockDir = this.freshStage("sdk-lock");
    writeFileSync(join(lockDir, "package.json"), before.pkg);
    writeFileSync(join(lockDir, "package-lock.json"), before.lock);
    const resolved = await this.npm(["install", "--package-lock-only", "--ignore-scripts", `${SDK_PACKAGE}@^${version}`], lockDir);
    if (resolved.code !== 0) return { error: `resolving it failed: ${tail(resolved)}` };
    const after = { pkg: readText(join(lockDir, "package.json")), lock: readText(join(lockDir, "package-lock.json")) };
    if (after.pkg === null || after.lock === null) return { error: "npm resolved it but wrote no package files" };

    let changes: ReturnType<typeof lockChanges>;
    try {
      changes = lockChanges(JSON.parse(before.lock), JSON.parse(after.lock), process.platform, process.arch, (key) => this.installedSdkPart(key));
    } catch (error) {
      return { error: `the resolved lockfile is unreadable: ${reason(error)}` };
    }
    if (changes.nested.length) {
      return { error: `it also moves nested dependencies (${changes.nested.slice(0, 4).join(", ")}), which only a manual npm install can place`, ban: true };
    }
    if (!changes.swap.some((c) => c.name === SDK_PACKAGE && c.version === version)) {
      return { error: `the resolved lockfile does not install ${SDK_PACKAGE}@${version}`, ban: true };
    }

    const pkgDir = this.freshStage("sdk-packages");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "ggo-sdk-stage", private: true, dependencies: Object.fromEntries(changes.swap.map((c) => [c.name, c.spec])) }, null, 2));
    // Peers are already in the live tree (or in the change set); without the flag npm would stage them too.
    const install = await this.npm(["install", "--legacy-peer-deps", "--no-package-lock"], pkgDir);
    if (install.code !== 0) return { error: `downloading it failed: ${tail(install)}` };
    const staged = changes.swap.map((c) => ({ key: c.key, dir: join(pkgDir, ...c.key.split("/")), version: c.version }));
    const wrong = staged.find((s) => readManifest(join(s.dir, "package.json")).version !== s.version);
    if (wrong) return { error: `the staged ${wrong.key.slice("node_modules/".length)} is not ${wrong.version}` };
    return { before: { pkg: before.pkg, lock: before.lock }, after: { pkg: after.pkg, lock: after.lock }, staged: staged.map(({ key, dir }) => ({ key, dir })) };
  }

  /** The installed version of the SDK or one of its platform packages; null for any other package. */
  private installedSdkPart(key: string): string | null {
    if (!key.startsWith(`node_modules/${SDK_PACKAGE}`) || key.includes("/node_modules/", "node_modules/".length)) return null;
    return readManifest(join(this.deps.serverRoot, ...key.split("/"), "package.json")).version;
  }

  /** Swap the staged packages in, write the new package files, then verify and commit. Holds the checkout. */
  private async applySdk(base: Base, to: RegistryRelease, plan: { before: { pkg: string; lock: string }; after: { pkg: string; lock: string }; staged: Array<{ key: string; dir: string }> }): Promise<CliUpdateComponent> {
    if (readText(this.packageFile("pkg")) !== plan.before.pkg || readText(this.packageFile("lock")) !== plan.before.lock) {
      this.retrySoon = true;
      return this.component({ ...base, state: "waiting", detail: "server/package.json changed while the release downloaded; trying again soon." });
    }
    const bump: InflightBump = {
      version: to.version,
      claudeCodeVersion: to.claudeCodeVersion ?? null,
      before: plan.before,
      wrote: { pkg: hash(plan.after.pkg), lock: hash(plan.after.lock) },
      swapped: [],
    };
    this.saveBump(bump);
    try {
      bump.swapped = swapIn(plan.staged.map((s) => ({ live: join(this.deps.serverRoot, ...s.key.split("/")), staged: s.dir })));
    } catch (error) {
      this.clearBump();
      return this.transient({ ...base, detail: `Swapping in Agent SDK ${to.version} failed: ${reason(error)}. The previous SDK is untouched.` });
    }
    this.saveBump(bump);
    writeFileSync(this.packageFile("pkg"), plan.after.pkg);
    writeFileSync(this.packageFile("lock"), plan.after.lock);
    return this.finishBump(bump, base);
  }

  /** Typecheck the swapped-in SDK and commit exactly the package files the bump wrote — or undo it. */
  private async finishBump(bump: InflightBump, base: Base): Promise<CliUpdateComponent> {
    const onDisk = this.sdkManifest();
    const target = `Agent SDK ${bump.version}${onDisk.claudeCodeVersion ? ` (Claude Code ${onDisk.claudeCodeVersion})` : ""}`;
    this.set("claude", this.component({ ...base, state: "updating", detail: `Verifying ${target}…` }));
    const check = await this.typecheck();
    if (check.code !== 0) {
      const undone = await this.undoBump(bump);
      // Banned only when the old SDK typechecks again: then the new one broke it, not someone's edit.
      const clean = undone ? await this.typecheck() : null;
      const detail = `${target} was not applied — the server no longer typechecks against it: ${tail(check)}.${undone ? " The previous version is back in place." : " Undoing it ALSO failed; run npm install in server/."}`;
      this.deps.log(undone ? "warn" : "error", `CLI auto-update: ${detail}`);
      if (clean?.code === 0) {
        this.deps.kvSet(FAILED_SDK_KEY, JSON.stringify({ version: bump.version, detail }));
        return this.component({ ...base, state: "failed", detail });
      }
      return this.transient({ ...base, detail });
    }
    if (!this.filesAreTheBumps(bump)) {
      await this.undoBump(bump);
      this.retrySoon = true;
      return this.component({ ...base, state: "waiting", detail: "server/package.json was edited during the bump; the bump was undone around that edit and retries soon." });
    }
    const now = { installed: onDisk.version, runtime: onDisk.claudeCodeVersion, latest: base.latest };
    if (hash(bump.before.pkg) === bump.wrote.pkg && hash(bump.before.lock) === bump.wrote.lock) {
      // The package files already carried this bump (pulled from another machine); only the tree moved.
      this.clearBump();
      this.sweepSdkAsides();
      this.deps.log("info", `CLI auto-update: installed ${target} from the committed lockfile.`);
      return this.restartOnto(now, `Installed ${target} from the committed lockfile`);
    }
    const message = `chore(deps): bump the Claude Agent SDK to ${bump.version}${onDisk.claudeCodeVersion ? ` (Claude Code ${onDisk.claudeCodeVersion})` : ""}`;
    const commit = await this.commit(message);
    if (commit.code !== 0) {
      const undone = await this.undoBump(bump);
      const detail = `${target} was not applied — git commit failed: ${tail(commit)}.${undone ? " The previous version is back in place." : " Undoing it ALSO failed; run npm install in server/."}`;
      this.deps.log("warn", `CLI auto-update: ${detail}`);
      return this.transient({ ...base, detail });
    }
    this.clearBump();
    this.sweepSdkAsides();
    const pushed = await this.push();
    this.deps.log("info", `CLI auto-update: committed "${message}"${pushed ? `; ${pushed}` : ""}.`);
    return this.restartOnto(now, `Updated to ${target}${pushed ? ` (${pushed})` : ""}`);
  }

  private filesAreTheBumps(bump: InflightBump): boolean {
    return hash(readText(this.packageFile("pkg"))) === bump.wrote.pkg && hash(readText(this.packageFile("lock"))) === bump.wrote.lock;
  }

  /**
   * Put the previous SDK back: the swapped folders, and the package files — verbatim when they are still
   * exactly what the bump wrote, otherwise only the SDK line, so a teammate's edit to the same file
   * survives (npm then re-resolves the lockfile around both).
   */
  private async undoBump(bump: InflightBump): Promise<boolean> {
    let ok = true;
    try {
      swapBack(bump.swapped);
    } catch (error) {
      ok = false;
      this.deps.log("error", `CLI auto-update: restoring the previous Agent SDK folders failed — ${reason(error)}`);
    }
    if (this.filesAreTheBumps(bump)) {
      writeFileSync(this.packageFile("pkg"), bump.before.pkg);
      writeFileSync(this.packageFile("lock"), bump.before.lock);
    } else {
      const line = this.revertSdkLine(bump);
      if (line === "failed") ok = false;
      if (line === "reverted") {
        const relock = await this.npm(["install", "--package-lock-only", "--ignore-scripts"], this.deps.serverRoot);
        if (relock.code !== 0) ok = false;
      }
    }
    this.clearBump();
    return ok;
  }

  /** Set the SDK dependency back to its previous spec in the current package.json, touching nothing else. */
  private revertSdkLine(bump: InflightBump): "unchanged" | "reverted" | "failed" {
    const current = readText(this.packageFile("pkg"));
    if (current === null) return "failed";
    const spec = (text: string): string | undefined => {
      try {
        return (JSON.parse(text) as { dependencies?: Record<string, string> }).dependencies?.[SDK_PACKAGE];
      } catch {
        return undefined;
      }
    };
    const was = spec(bump.before.pkg);
    const now = spec(current);
    if (!was || !now) return "failed";
    if (was === now) return "unchanged";
    const key = JSON.stringify(SDK_PACKAGE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(`(${key}\\s*:\\s*)${JSON.stringify(now).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (!line.test(current)) return "failed";
    writeFileSync(this.packageFile("pkg"), current.replace(line, `$1${JSON.stringify(was)}`));
    return "reverted";
  }

  /**
   * A bump the previous process started but never finished (a restart landed between its swap and its
   * commit). Finish it when the swapped SDK and the package files are exactly what it put there;
   * otherwise undo it. Null when there is nothing to recover.
   */
  private async recoverInterruptedBump(): Promise<CliUpdateComponent | null> {
    const bump = this.readBump();
    if (!bump) return null;
    const onDisk = this.sdkManifest();
    const base = { installed: onDisk.version, runtime: onDisk.claudeCodeVersion, latest: bump.version };
    const head = await this.git(["show", `HEAD:${PACKAGE_FILES[0]}`]);
    if (head.code === 0 && hash(head.stdout) === bump.wrote.pkg) {
      // Committed; the restart may have landed before the push did.
      this.clearBump();
      await this.push();
      return null;
    }
    const release = this.deps.claimCheckout();
    if (!release) return this.component({ ...base, state: "waiting", detail: "An interrupted Agent SDK bump resumes once the GGO update in progress finishes." });
    try {
      if (this.filesAreTheBumps(bump) && onDisk.version === bump.version) {
        this.deps.log("info", `CLI auto-update: finishing the Agent SDK ${bump.version} bump a restart interrupted.`);
        return await this.finishBump(bump, base);
      }
      const undone = await this.undoBump(bump);
      const restored = this.sdkManifest();
      const detail = `An Agent SDK ${bump.version} bump was interrupted before it was complete; ${undone ? "it was undone and retries soon" : "undoing it FAILED — run npm install in server/"}.`;
      this.deps.log(undone ? "warn" : "error", `CLI auto-update: ${detail}`);
      return this.transient({ installed: restored.version, runtime: restored.claudeCodeVersion, latest: bump.version, detail });
    } finally {
      release();
    }
  }

  private readBump(): InflightBump | null {
    try {
      const bump = JSON.parse(this.deps.kvGet(INFLIGHT_KEY) ?? "") as InflightBump;
      const valid =
        typeof bump?.version === "string" &&
        typeof bump.before?.pkg === "string" &&
        typeof bump.before?.lock === "string" &&
        Array.isArray(bump.swapped) &&
        bump.swapped.every((s) => typeof s.live === "string" && isAbsolute(s.live) && (s.aside === null || (typeof s.aside === "string" && isAbsolute(s.aside))));
      return valid ? bump : null;
    } catch {
      return null;
    }
  }

  private saveBump(bump: InflightBump): void {
    this.deps.kvSet(INFLIGHT_KEY, JSON.stringify(bump));
  }

  private clearBump(): void {
    this.deps.kvSet(INFLIGHT_KEY, "");
  }

  /** Commit only the two package files, riding out another agent's commit holding index.lock. */
  private async commit(message: string): Promise<ChildResult> {
    for (let attempt = 0; ; attempt++) {
      const started = this.now();
      const result = await this.git(["commit", "--only", "-m", message, "--", ...PACKAGE_FILES], COMMIT_TIMEOUT_MS);
      if (result.code === 0) return result;
      if (result.timedOut) {
        await this.clearOwnIndexLock(started, result);
        return result;
      }
      if (!/index\.lock/.test(result.stderr) || attempt + 1 >= COMMIT_LOCK_RETRIES) return result;
      await this.sleep(COMMIT_LOCK_WAIT_MS);
    }
  }

  /** A commit killed at its deadline leaves its index.lock behind, which blocks every agent's git. Only
   *  a lock created during that commit is ours, and only once git is really gone. */
  private async clearOwnIndexLock(started: number, result: ChildResult): Promise<void> {
    if (/never closed/.test(result.stderr)) return;
    const where = await this.git(["rev-parse", "--git-path", "index.lock"]);
    const path = where.stdout.trim();
    if (where.code !== 0 || !path) return;
    const lock = resolve(this.deps.repoRoot, path);
    try {
      if (statSync(lock).mtimeMs < started) return;
      rmSync(lock, { force: true });
      this.deps.log("warn", `CLI auto-update: removed the index.lock its timed-out commit left behind (${lock}).`);
    } catch {
      /* no lock left */
    }
  }

  /** Push the bump when the branch tracks a remote. Never to a NO_PUSH_REPO_PATTERN remote: the owner pushes those. */
  private async push(): Promise<string> {
    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.code !== 0) return "committed locally; the branch tracks no upstream";
    const remote = upstream.stdout.trim().split("/")[0] ?? "";
    const url = await this.git(["remote", "get-url", remote]);
    if (isConfiguredCommitOnlyOrigin(url.stdout, this.deps.noPushRepoPattern ?? "")) return "committed locally; commit-only remotes are pushed by hand";
    const push = await this.git(["push"], COMMIT_TIMEOUT_MS);
    if (push.code === 0) return `pushed to ${upstream.stdout.trim()}`;
    this.deps.log("warn", `CLI auto-update: the bump is committed but the push failed — ${tail(push)}`);
    return `committed; the push failed (${tail(push)})`;
  }
}
