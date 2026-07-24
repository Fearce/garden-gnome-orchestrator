/*
 * Unit test for the enriched crash logger (crashLog.ts).
 *
 * Asserts the three things the fresh-crash investigation showed were missing when crashes vanished without
 * a trace: every fault entry carries (1) a memory snapshot, (2) an uptime, and (3) the registered
 * active-work context — so the NEXT in-process fault is diagnosable from crash.log alone.
 *
 * DATA_DIR must be set BEFORE crashLog (→ config) is imported, so the module is pulled in dynamically after
 * we point it at a throwaway dir (ESM top-level imports would run too early).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(resolve(tmpdir(), "orch-crashlog-"));
process.env.DATA_DIR = dir;

const { logCrash, registerCrashContext, memorySnapshot, startMemoryMonitor, SUPERVISED_RESTART_CODE } = await import(
  "../crashLog.js"
);

const crashLogPath = resolve(dir, "crash.log");
let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string, detail?: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\nA. memorySnapshot carries rss / heap / uptime");
{
  const snap = memorySnapshot();
  check(/rss=\d+MB/.test(snap), "reports rss");
  check(/heapUsed=\d+MB/.test(snap), "reports heapUsed");
  check(/uptime=\d+s/.test(snap), "reports uptime", snap);
}

console.log("\nB. logCrash writes label + stack + memory + registered context");
{
  registerCrashContext("active-work", () => "3 live agent run(s); 1 in-flight: abcd1234[implementing]");
  logCrash("uncaughtException", new Error("kaboom-marker"));
  const text = readFileSync(crashLogPath, "utf8");
  check(text.includes("uncaughtException"), "entry carries the label");
  check(text.includes("kaboom-marker"), "entry carries the error stack/message");
  check(/mem rss=\d+MB/.test(text), "entry carries the memory snapshot");
  check(text.includes("active-work:"), "entry carries the registered context label");
  check(text.includes("abcd1234[implementing]"), "entry carries the context provider's output");
}

console.log("\nC. a throwing context provider can't break the logger");
{
  registerCrashContext("boom-provider", () => {
    throw new Error("provider-fault");
  });
  let threw = false;
  try {
    logCrash("unhandledRejection", "some-reason");
  } catch {
    threw = true;
  }
  check(!threw, "logCrash swallows a provider fault");
  const text = readFileSync(crashLogPath, "utf8");
  check(text.includes("context provider threw"), "the faulty provider is noted, not fatal");
  check(text.includes("some-reason"), "the second entry still recorded its reason");
}

console.log("\nD. startMemoryMonitor is unref'd and returns a working stop handle");
{
  const stop = startMemoryMonitor(50);
  check(typeof stop === "function", "returns a stop function");
  await new Promise((r) => setTimeout(r, 120));
  let threw = false;
  try {
    stop();
  } catch {
    threw = true;
  }
  check(!threw, "stop() clears the timer without throwing");
}

console.log("\nE. the supervised-restart exit code is the agreed 75");
check(SUPERVISED_RESTART_CODE === 75, "SUPERVISED_RESTART_CODE === 75", String(SUPERVISED_RESTART_CODE));

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
