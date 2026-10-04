import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { logLifecycle } from "../crashLog.js";
import { recordBlockingSpan } from "../eventLoopMonitor.js";

// Every SQLite call this server makes runs synchronously on its only thread, so a slow one IS an event-loop
// stall. Until this existed, crash.log said "event loop blocked 6x (worst 45.8s) — no tracked operation was
// in flight" for weeks: the self-profiler only ran for one 45s window per half hour and could not name the
// statement. Timing each statement costs two clock reads and names the culprit on the very next stall.

/** A statement this slow is reported. Well above a healthy indexed read (well under 10ms here). */
const SLOW_STATEMENT_MS = 250;
/** Distinct statements kept per report, by total time. */
const REPORT_TOP = 4;
const REPORT_MS = 60_000;

interface SlowEntry {
  label: string;
  count: number;
  totalMs: number;
  worstMs: number;
  caller: string;
}

let window = new Map<string, SlowEntry>();

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** The first two frames outside this module and better-sqlite3, e.g. `goalTurnActivity <- settleStep`. */
function callerOf(stack: string | undefined): string {
  const frames = (stack ?? "")
    .split("\n")
    .slice(1)
    .filter((line) => !/db[\\/]slowStatements\.|better-sqlite3|node:internal/.test(line))
    .map((line) => line.trim().replace(/^at\s+/, "").replace(/\s*\(.*$/, "").replace(/^(?:Db|Object)\./, ""))
    .filter(Boolean);
  return frames.slice(0, 2).join(" <- ") || "(unknown caller)";
}

/** Exported for the gate: what one slow call contributes to the period's report and the stall blame. */
export function recordSlowStatement(kind: string, sql: string, startedAt: number, endedAt: number, stack?: string): void {
  const ms = endedAt - startedAt;
  const caller = callerOf(stack);
  const label = `sqlite ${kind} in ${caller}: ${normalise(sql)}`;
  recordBlockingSpan(label, startedAt, endedAt);
  const entry = window.get(label) ?? { label, count: 0, totalMs: 0, worstMs: 0, caller };
  entry.count++;
  entry.totalMs += ms;
  entry.worstMs = Math.max(entry.worstMs, ms);
  window.set(label, entry);
}

function timer(slowMs: number) {
  return function timed<A extends unknown[], R>(kind: string, sql: string, run: (...args: A) => R): (...args: A) => R {
    return function (this: unknown, ...args: A): R {
      const startedAt = performance.now();
      try {
        return run.apply(this, args);
      } finally {
        const endedAt = performance.now();
        if (endedAt - startedAt >= slowMs) recordSlowStatement(kind, sql, startedAt, endedAt, new Error().stack);
      }
    };
  };
}

/**
 * Time every statement prepared on `raw`, plus `exec` and `pragma`. Purely observational: results, errors
 * and `this` binding pass through untouched. Call once, right after opening the connection.
 */
export function instrumentStatements(raw: Database.Database, slowMs: number = SLOW_STATEMENT_MS): void {
  const timed = timer(slowMs);
  const prepare = raw.prepare.bind(raw);
  raw.prepare = ((source: string) => {
    const statement = prepare(source);
    for (const method of ["run", "get", "all"] as const) {
      const original = statement[method] as (...args: unknown[]) => unknown;
      Object.defineProperty(statement, method, { value: timed(method, source, original), configurable: true });
    }
    return statement;
  }) as typeof raw.prepare;
  // A transaction's COMMIT (and any WAL checkpoint it triggers) runs inside better-sqlite3, not through a
  // prepared statement, so the transaction function as a whole is what gets timed.
  const transaction = raw.transaction.bind(raw);
  raw.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const tx = transaction(fn);
    const wrapped = timed("transaction", "(transaction)", tx) as typeof tx;
    for (const variant of ["deferred", "immediate", "exclusive"] as const) {
      Object.defineProperty(wrapped, variant, { value: timed(`${variant} transaction`, "(transaction)", tx[variant]) });
    }
    Object.defineProperty(wrapped, "default", { value: wrapped });
    Object.defineProperty(wrapped, "database", { value: raw });
    return wrapped;
  }) as typeof raw.transaction;
  raw.exec = timed("exec", "(exec)", raw.exec.bind(raw)) as typeof raw.exec;
  const pragma = raw.pragma.bind(raw);
  raw.pragma = ((source: string, options?: Database.PragmaOptions) =>
    timed("pragma", `PRAGMA ${source}`, () => pragma(source, options))()) as typeof raw.pragma;
}

/** The period's slow statements as one line, or null when there were none. Drains the window. */
export function drainSlowStatementReport(): string | null {
  const entries = [...window.values()];
  window = new Map();
  if (!entries.length) return null;
  const count = entries.reduce((sum, e) => sum + e.count, 0);
  const totalS = (entries.reduce((sum, e) => sum + e.totalMs, 0) / 1000).toFixed(1);
  const top = entries
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, REPORT_TOP)
    .map((e) => `${e.count}x ${(e.totalMs / 1000).toFixed(1)}s (worst ${(e.worstMs / 1000).toFixed(1)}s) ${e.label}`)
    .join(" | ");
  return `slow SQLite statements: ${count}, ${totalS}s on the event loop — ${top}`;
}

export function startSlowStatementReporter(reportMs: number = REPORT_MS): () => void {
  const timer = setInterval(() => {
    const line = drainSlowStatementReport();
    if (line) logLifecycle(line);
  }, reportMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
