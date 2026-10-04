import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Starting a GGO server from the desktop app.
 *
 * The app runs the same supervisor `npm run serve --prefix server` runs (server/scripts/supervise.cjs),
 * DETACHED: it belongs to no window and outlives the app, so closing the desktop window can never stop
 * running agents. The data-directory instance guard plus the supervisor's duplicate-owner exit (78) make
 * a second start harmless; the app still checks first so it never even tries while a server answers.
 */

const SUPERVISOR = join("server", "scripts", "supervise.cjs");

export function isCheckout(dir: string): boolean {
  return existsSync(join(dir, SUPERVISOR)) && existsSync(join(dir, "server", "package.json")) && existsSync(join(dir, "web", "package.json"));
}

/** The checkout this copy of the app belongs to: a chosen folder first, else the nearest ancestor of the
 *  app (run from source: `<checkout>/desktop`; packaged: `<checkout>/desktop/release/win-unpacked`). */
export function findCheckout(chosen: string | null, startDirs: readonly string[]): string | null {
  if (chosen && isCheckout(chosen)) return chosen;
  for (const start of startDirs) {
    let dir = resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      if (isCheckout(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** A system Node.js for the server. Electron's own runtime cannot host it: the server's native modules
 *  are built against the system Node ABI. */
export function findNode(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32" && env.ProgramFiles) dirs.push(join(env.ProgramFiles, "nodejs"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** `server/data/server.log`, or the DATA_DIR the checkout's server/.env names. Read for that one key only. */
export function serverLogPath(checkout: string): string {
  const serverDir = join(checkout, "server");
  let dataDir = join(serverDir, "data");
  try {
    const line = readFileSync(join(serverDir, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => /^DATA_DIR=/.test(l));
    const value = line?.slice("DATA_DIR=".length).trim().replace(/^["']|["']$/g, "");
    if (value) dataDir = isAbsolute(value) ? value : resolve(serverDir, value);
  } catch {
    /* no server/.env: the default data directory */
  }
  return join(dataDir, "server.log");
}

/** Is anything accepting connections on the server's port? A listener that does not answer as GGO is a
 *  port conflict the app must report rather than start a second server into. */
export function portInUse(server: string, timeoutMs = 1_500): Promise<boolean> {
  const url = new URL(server);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (busy: boolean) => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The environment the server inherits: the user's, minus the Electron and npm-script variables of
 *  whatever launched this app, so the server behaves exactly as if started from a fresh terminal. */
function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(ELECTRON_|npm_|NODE_OPTIONS$|GGO_DESKTOP_)/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/** Launch the supervisor detached and let go of it. Resolves once the process exists (or fails to). */
export function startDetachedServer(checkout: string, node: string): Promise<{ pid: number }> {
  const supervisor = join(checkout, SUPERVISOR);
  const cwd = join(checkout, "server");
  return process.platform === "win32" ? startThroughShell(node, supervisor, cwd) : spawnDetached(node, supervisor, cwd);
}

/** Quote for a PowerShell single-quoted string. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Windows: Node spawns every child with handle inheritance on, so a server spawned straight from this app
 * would inherit the app's own stdout/stderr and hold them open for as long as it runs; whatever launched
 * the app from a pipe (a script, a terminal tool) then waits on the server instead of the app.
 * `Start-Process` starts it through ShellExecute, which passes no handles, then PowerShell exits.
 */
function startThroughShell(node: string, supervisor: string, cwd: string): Promise<{ pid: number }> {
  const script = `(Start-Process -FilePath ${psQuote(node)} -ArgumentList ${psQuote(`"${supervisor}"`)} -WorkingDirectory ${psQuote(cwd)} -WindowStyle Hidden -PassThru).Id`;
  return new Promise((done, fail) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: serverEnv(process.env), windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        const pid = Number(stdout.trim());
        if (error || !Number.isInteger(pid) || pid <= 0) return fail(new Error(stderr.trim() || error?.message || "PowerShell did not start the server"));
        done({ pid });
      },
    );
  });
}

function spawnDetached(node: string, supervisor: string, cwd: string): Promise<{ pid: number }> {
  return new Promise((done, fail) => {
    const child = spawn(node, [supervisor], { cwd, detached: true, stdio: "ignore", env: serverEnv(process.env) });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done({ pid: child.pid ?? 0 });
    });
  });
}
