import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";

// Persistent so a crash is diagnosable regardless of how the process was spawned
// (the script-hub launcher runs it detached and does not capture stdout/stderr).
const CRASH_LOG = resolve(config.dataDir, "crash.log");
const MAX_BYTES = 5 * 1024 * 1024;

function entry(label: string, err: unknown): string {
  const e = err as { stack?: string; message?: string } | undefined;
  const body = e?.stack ?? e?.message ?? (typeof err === "string" ? err : JSON.stringify(err));
  return `\n[${new Date().toISOString()}] ${label}\n${body}\n`;
}

/** Append a labelled stack to the crash log (rotating once over MAX_BYTES) and stderr. Never throws. */
export function logCrash(label: string, err: unknown): void {
  const text = entry(label, err);
  try {
    // eslint-disable-next-line no-console
    console.error(text);
  } catch {
    // stderr may be a closed/broken pipe under the detached launcher — the disk
    // append below is the durable sink and must run regardless.
  }
  try {
    mkdirSync(dirname(CRASH_LOG), { recursive: true });
    try {
      if (statSync(CRASH_LOG).size > MAX_BYTES) renameSync(CRASH_LOG, `${CRASH_LOG}.1`);
    } catch {
      // first write (no log yet) or a locked rotation target — fall through and append anyway
    }
    appendFileSync(CRASH_LOG, text);
  } catch {
    // logging must never itself crash the guard
  }
}

/**
 * Last-resort process guards. This server supervises long-running autonomous
 * agents, so a stray rejection in one fire-and-forget async path (a ping timer,
 * a WS handler, an agent pipeline `void this.run()`) must not silently take down
 * the whole console. An unhandledRejection is logged and swallowed — the
 * supervisor keeps running and the underlying bug stays visible in crash.log. An
 * uncaughtException may have left state corrupt, so it is logged and the process
 * exits for the keep-alive supervisor to restart cleanly.
 */
export function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));
  process.on("uncaughtException", (err) => {
    logCrash("uncaughtException", err);
    process.exit(1);
  });
}
