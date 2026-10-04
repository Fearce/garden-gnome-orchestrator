import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Starting a GGO server from the desktop app.
 *
 * The app runs the same supervisor `npm run serve --prefix server` runs (server/scripts/supervise.cjs),
 * DETACHED: it belongs to no window and outlives the app, so closing the desktop window can never stop
 * running agents. The app starts nothing while anything answers on the address, or when the checkout is
 * configured for a different port; behind that, the data-directory instance guard (exit 78) keeps a second
 * server from ever running beside the first.
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

const DEFAULT_PORT = 4317;

/** Where a started server's log lands. The supervisor writes it and loads no `.env`, so only the
 *  environment's DATA_DIR (relative to `server/`, its working directory) moves it. */
export function serverLogPath(checkout: string, env: NodeJS.ProcessEnv = process.env): string {
  const serverDir = join(checkout, "server");
  const dataDir = env.DATA_DIR ? resolve(serverDir, env.DATA_DIR) : join(serverDir, "data");
  return join(dataDir, "server.log");
}

/** The port a server started from this checkout listens on: PORT from the environment, else from
 *  `server/.env` (the server loads it without overriding the environment), else 4317. */
export function checkoutPort(checkout: string, env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.PORT ?? dotenvValue(join(checkout, "server"), "PORT") ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
}

/** One key of `server/.env`, read for that key only. */
function dotenvValue(serverDir: string, key: string): string | null {
  try {
    const line = readFileSync(join(serverDir, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    const value = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    return value || null;
  } catch {
    return null;
  }
}

/** The port an address points at, with the scheme's default when it names none. */
export function urlPort(server: string): number {
  const url = new URL(server);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** Is anything accepting connections on the server's port? A listener that does not answer as GGO is a
 *  port conflict the app must report rather than start a second server into. */
export function portInUse(server: string, timeoutMs = 1_500): Promise<boolean> {
  const port = urlPort(server);
  const host = new URL(server).hostname.replace(/^\[|\]$/g, "");
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

/** The paths travel in variables the script removes before starting the server, so no path is ever
 *  quoted into PowerShell source (it also treats ‘ ’ as quotes) or read as a wildcard (`[ ]`). */
const START_SCRIPT = [
  "$psi = New-Object System.Diagnostics.ProcessStartInfo",
  "$psi.FileName = $env:GGO_START_NODE",
  "$psi.Arguments = [char]34 + $env:GGO_START_SUPERVISOR + [char]34",
  "$psi.WorkingDirectory = $env:GGO_START_CWD",
  "$psi.UseShellExecute = $true",
  "$psi.WindowStyle = 'Hidden'",
  "Remove-Item Env:GGO_START_NODE, Env:GGO_START_SUPERVISOR, Env:GGO_START_CWD",
  "[System.Diagnostics.Process]::Start($psi).Id",
].join("; ");

/**
 * Windows: Node spawns every child with handle inheritance on, so a server spawned straight from this app
 * would inherit the app's own stdout/stderr and hold them open for as long as it runs; whatever launched
 * the app from a pipe (a script, a terminal tool) then waits on the server instead of the app.
 * ShellExecute (`UseShellExecute`) passes no handles, and PowerShell exits once it has the pid.
 */
function startThroughShell(node: string, supervisor: string, cwd: string): Promise<{ pid: number }> {
  const env = { ...serverEnv(process.env), GGO_START_NODE: node, GGO_START_SUPERVISOR: supervisor, GGO_START_CWD: cwd };
  return new Promise((done, fail) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", START_SCRIPT],
      { env, windowsHide: true, timeout: 30_000 },
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
    const child = spawn(node, [supervisor], { cwd, detached: true, stdio: "ignore", windowsHide: true, env: serverEnv(process.env) });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done({ pid: child.pid ?? 0 });
    });
  });
}
