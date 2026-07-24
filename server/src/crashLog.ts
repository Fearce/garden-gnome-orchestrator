import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import { config } from "./config.js";

// Persistent so a crash is diagnosable regardless of how the process was spawned
// (the supervisor / script-hub launcher runs it detached and does not capture stdout/stderr).
const CRASH_LOG = resolve(config.dataDir, "crash.log");
const MAX_BYTES = 5 * 1024 * 1024;

/** Exit code a supervised process uses to request a restart from its supervisor (server/scripts/supervise.cjs).
 *  Distinct from a crash (non-zero/signal) so the supervisor respawns WITHOUT counting it toward crash-loop
 *  backoff. Mirrored as a literal `75` in supervise.cjs — keep the two in sync. */
export const SUPERVISED_RESTART_CODE = 75;

/** Extra context appended to every crash entry — registered by the owners of live state (e.g. ThreadManager
 *  contributes the active-task snapshot) so a crash record shows what the process was DOING when it died. */
const contextProviders: Array<{ label: string; fn: () => string }> = [];

/** Register a provider whose string is appended to every crash entry. Never let a provider throw into the
 *  logger — each call is guarded. */
export function registerCrashContext(label: string, fn: () => string): void {
  contextProviders.push({ label, fn });
}

const MB = 1024 * 1024;
const mb = (n: number): number => Math.round(n / MB);

/** A one-line memory + uptime snapshot — the single most useful datum for telling an OOM apart from a
 *  logic fault after the fact. */
export function memorySnapshot(): string {
  const m = process.memoryUsage();
  let limitMb = 0;
  try {
    limitMb = mb(getHeapStatistics().heap_size_limit);
  } catch {
    // v8 stats unavailable — omit the ceiling rather than fail the snapshot
  }
  const pct = limitMb ? ` (${Math.round((mb(m.heapUsed) / limitMb) * 100)}% of ${limitMb}MB limit)` : "";
  return (
    `mem rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB ` +
    `ext=${mb(m.external)}MB${pct}  uptime=${Math.round(process.uptime())}s  pid=${process.pid}`
  );
}

function contextBlock(): string {
  if (contextProviders.length === 0) return "";
  const parts: string[] = [];
  for (const p of contextProviders) {
    try {
      const text = p.fn();
      if (text && text.trim()) parts.push(`${p.label}: ${text.trim()}`);
    } catch (e) {
      parts.push(`${p.label}: <context provider threw: ${(e as Error)?.message ?? e}>`);
    }
  }
  return parts.length ? `\n${parts.join("\n")}` : "";
}

function entry(label: string, err: unknown): string {
  const e = err as { stack?: string; message?: string } | undefined;
  const body = e?.stack ?? e?.message ?? (typeof err === "string" ? err : JSON.stringify(err));
  return `\n[${new Date().toISOString()}] ${label}\n${memorySnapshot()}${contextBlock()}\n${body}\n`;
}

/** Append a labelled stack to the crash log (rotating once over MAX_BYTES) and stderr. Never throws. */
export function logCrash(label: string, err: unknown): void {
  writeRaw(entry(label, err));
}

/** Append an already-formatted line (with its own timestamp handling) — used for lifecycle records
 *  (signals, exit, memory high-water) that aren't faults but belong in the same durable log. */
function writeRaw(text: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(text);
  } catch {
    // stderr may be a closed/broken pipe under a detached launcher — the disk append below is the durable
    // sink and must run regardless.
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

/** A lifecycle note (not a fault): timestamped one-liner with the memory snapshot, so the log records
 *  WHY the process is going down (a forwarded signal, a clean exit) as well as how. */
function logLifecycle(label: string): void {
  writeRaw(`\n[${new Date().toISOString()}] ${label}\n${memorySnapshot()}${contextBlock()}\n`);
}

/**
 * Last-resort process guards. This server supervises long-running autonomous agents, so a stray rejection
 * in one fire-and-forget async path (a ping timer, a WS handler, an agent pipeline `void this.run()`) must
 * not silently take down the whole console. An unhandledRejection is logged with full memory + task context
 * and swallowed — the supervisor keeps running and the underlying bug stays visible in crash.log. An
 * uncaughtException may have left state corrupt, so it is logged and the process exits for the supervisor
 * to restart cleanly. Termination signals and the final `exit` are recorded too, so a kill or a graceful
 * shutdown leaves a durable trail — the thing that was missing when crashes vanished without a crash.log.
 */
export function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));
  process.on("uncaughtException", (err) => {
    logCrash("uncaughtException", err);
    process.exit(1);
  });

  // A Node warning (notably MaxListenersExceededWarning) is an early leak tell — record it, don't die.
  process.on("warning", (w) => logLifecycle(`warning: ${w.name}: ${w.message}`));

  // Termination signals: record that we were asked to stop (distinguishes an external kill / supervisor
  // shutdown from a crash) then exit cleanly. Without this a SIGTERM left zero trace.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logLifecycle(`signal ${sig} received — shutting down`);
      process.exit(0);
    });
  }

  // Synchronous last gasp. Fires for a clean exit or an explicit process.exit (incl. the supervised-restart
  // code); does NOT fire for an OOM abort (that path is captured by the supervisor watching this child).
  process.on("exit", (code) => {
    try {
      appendFileSync(CRASH_LOG, `\n[${new Date().toISOString()}] process exit code=${code}\n${memorySnapshot()}\n`);
    } catch {
      // exit handlers must never throw
    }
  });
}

const MEMORY_SAMPLE_MS = 60_000;
const HIGH_WATER_STEP_MB = 100; // only log when RSS climbs another 100MB above the last logged high-water
const HEAP_PRESSURE_PCT = 85; // warn loudly once heapUsed crosses this share of the V8 ceiling

/**
 * Periodic memory sampler. Records a durable high-water line each time RSS climbs a step higher than ever
 * seen, and a loud WARNING once heapUsed approaches the V8 heap ceiling — turning a silent OOM into a
 * visible trend in crash.log. Unref'd so it never keeps the process alive. Returns a stop handle for tests.
 */
export function startMemoryMonitor(intervalMs: number = MEMORY_SAMPLE_MS): () => void {
  let highWaterRssMb = 0;
  let warnedPressure = false;
  const heapLimitMb = (() => {
    try {
      return mb(getHeapStatistics().heap_size_limit);
    } catch {
      return 0;
    }
  })();
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    const rssMb = mb(m.rss);
    if (rssMb >= highWaterRssMb + HIGH_WATER_STEP_MB) {
      highWaterRssMb = rssMb;
      logLifecycle(`memory high-water rss=${rssMb}MB`);
    }
    const heapPct = heapLimitMb ? (mb(m.heapUsed) / heapLimitMb) * 100 : 0;
    if (heapPct >= HEAP_PRESSURE_PCT && !warnedPressure) {
      warnedPressure = true;
      logLifecycle(`WARNING memory pressure — heapUsed at ${Math.round(heapPct)}% of the ${heapLimitMb}MB ceiling; an OOM abort is imminent`);
    } else if (heapPct < HEAP_PRESSURE_PCT - 10) {
      warnedPressure = false; // re-arm once pressure clears, so a later climb warns again
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
