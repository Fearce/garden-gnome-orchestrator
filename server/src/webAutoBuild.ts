import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "./config.js";

const WEB_ROOT = join(config.serverRoot, "..", "web");
const POLL_MS = 5_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const OUTDATED_SLOP_MS = 1_000;
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", ".git"]);

type WebScan = {
  signature: string;
  newestMtimeMs: number;
};

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function lifecycleEvent(): string {
  return process.env.npm_lifecycle_event ?? "";
}

function shouldRunAutoBuild(): boolean {
  const event = lifecycleEvent();
  // `dev` and root `serve` run Vite separately; static web/dist is only authoritative in built mode.
  return !/(^|:)(dev|serve)(:|$)/.test(event);
}

function indexMtimeMs(): number | null {
  const indexPath = join(config.webDist, "index.html");
  try {
    return statSync(indexPath).mtimeMs;
  } catch {
    return null;
  }
}

function scanWebSources(): WebScan | null {
  if (!existsSync(WEB_ROOT)) return null;

  const entries: string[] = [];
  let newestMtimeMs = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const path = join(dir, entry.name);
      const stat = statSync(path);
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      entries.push(`${relative(WEB_ROOT, path)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    }
  };

  walk(WEB_ROOT);
  entries.sort();
  return { signature: entries.join("|"), newestMtimeMs };
}

function buildWeb(): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(npmBin(), ["run", "build"], {
      cwd: WEB_ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      console.error(`[web] auto-build failed to start: ${(err as Error).message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        if (stdout.trim()) console.error(stdout.trim());
        if (stderr.trim()) console.error(stderr.trim());
      }
      resolve(code === 0);
    });
  });
}

export function startWebAutoBuild(): void {
  if (!shouldRunAutoBuild()) return;

  let lastSignature: string | null = null;
  let building = false;
  let polling = false;
  let pending = false;
  let lastFailureAt = 0;

  const runBuild = async (reason: string): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }

    building = true;
    console.log(`[web] ${reason}; rebuilding web/dist...`);
    const ok = await buildWeb();
    building = false;

    if (ok) {
      lastFailureAt = 0;
      console.log("[web] rebuild complete; open clients will reload after their next version check.");
    } else {
      lastFailureAt = Date.now();
      console.error("[web] rebuild failed; will retry after the next frontend change or cooldown.");
    }

    if (pending) {
      pending = false;
      void poll("changes arrived during rebuild");
    }
  };

  async function poll(reason = "frontend change detected"): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const scan = scanWebSources();
      if (!scan) return;

      const previous = lastSignature;
      lastSignature = scan.signature;
      const distMtime = indexMtimeMs();
      const distMissing = distMtime === null;
      const sourceNewerThanDist = distMtime !== null && scan.newestMtimeMs > distMtime + OUTDATED_SLOP_MS;
      const changed = previous !== null && previous !== scan.signature;
      const retryReady = lastFailureAt === 0 || Date.now() - lastFailureAt >= RETRY_AFTER_FAILURE_MS;

      if (changed) {
        await runBuild(reason);
      } else if ((distMissing || sourceNewerThanDist) && retryReady) {
        await runBuild(distMissing ? "web/dist is missing" : "frontend sources are newer than web/dist");
      }
    } catch (err) {
      console.error(`[web] auto-build scan failed: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  }

  void poll("frontend sources are newer than web/dist");
  setInterval(() => void poll(), POLL_MS).unref();
}
