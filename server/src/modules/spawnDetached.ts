import { Worker } from "node:worker_threads";

export interface DetachedSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** stdout and stderr of the detached process are appended here. */
  logFile: string;
}

// A throwaway `node -e` launcher starts the real process and exits at once. With its parent gone, the
// process is no longer in GGO's process tree, so the tree-kill a GGO restart performs leaves it running.
// That is the point: a recording a user started must survive a deploy.
const LAUNCHER = `
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const spec = JSON.parse(process.argv[1]);
const fd = openSync(spec.logFile, "a");
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
child.on("error", (e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
child.on("spawn", () => { process.stdout.write(String(child.pid)); child.unref(); process.exit(0); });
`;

// Run on a worker thread: on Windows `spawn()` blocks the calling thread inside CreateProcessW, measured at
// hundreds of milliseconds on a loaded box, and the console's event loop must not pay that (see childRunner.ts).
const THREAD = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", workerData.launcher, JSON.stringify(workerData.spec)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
child.on("error", (e) => parentPort.postMessage({ ok: false, error: String(e && e.message || e) }));
child.on("close", (code) => {
  const pid = Number(out.trim());
  parentPort.postMessage(code === 0 && pid > 0 ? { ok: true, pid } : { ok: false, error: err.trim() || "launcher exited " + code });
});
`;

/** Start `spec` as an orphaned background process and resolve with its pid. */
export function spawnDetached(spec: DetachedSpawn, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const thread = new Worker(THREAD, { eval: true, workerData: { launcher: LAUNCHER, spec } });
    const timer = setTimeout(() => {
      void thread.terminate();
      reject(new Error(`starting the module worker took longer than ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    thread.once("message", (msg: { ok: boolean; pid?: number; error?: string }) => {
      clearTimeout(timer);
      void thread.terminate();
      if (msg.ok && msg.pid) resolve(msg.pid);
      else reject(new Error(msg.error || "the module worker did not start"));
    });
    thread.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** GGO's environment minus anything that looks like a credential. Workers drive cameras and devices; they
 *  never need the console's login password or provider tokens. */
export function workerEnvironment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/TOKEN|SECRET|PASSWORD|PASSPHRASE|API_?KEY|COOKIE|OAUTH|SESSION|CREDENTIAL/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
