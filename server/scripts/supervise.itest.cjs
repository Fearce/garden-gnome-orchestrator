#!/usr/bin/env node
"use strict";
/*
 * Integration test for the process supervisor (supervise.cjs).
 *
 * Drives the REAL supervisor against a throwaway child script (via ORCH_SUPERVISE_TEST_CHILD) and asserts
 * the two behaviours that make the orchestrator survivable + diagnosable:
 *   1. A crashing child (non-zero exit) is RESTARTED, and each crash appends a structured record to
 *      crash.log with the child's stderr tail — the evidence that used to vanish.
 *   2. A child that exits with the supervised-restart code (75) is respawned WITHOUT a crash.log entry
 *      (it's an intentional bounce, not a fault).
 * Fast timings come from the ORCH_SUPERVISE_* env knobs so the whole thing runs in a few seconds.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let passed = 0;
let failed = 0;
const fail = (m) => {
  failed++;
  console.log(`  ✗ ${m}`);
};
const ok = (m) => {
  passed++;
  console.log(`  ✓ ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const superviseScript = path.join(__dirname, "supervise.cjs");

/** Run the supervisor with a given child script for `runMs`, then SIGTERM it and resolve. */
async function runSupervisor({ dataDir, childScript, runMs }) {
  const proc = spawn(process.execPath, [superviseScript], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ORCH_SUPERVISE_TEST_CHILD: childScript,
      ORCH_SUPERVISE_HEALTHY_MS: "60000", // treat every quick exit as a fast-fail (so backoff engages)
      ORCH_SUPERVISE_BACKOFF_BASE_MS: "150",
      ORCH_SUPERVISE_BACKOFF_MAX_MS: "600",
      ORCH_SUPERVISE_SETTLE_MS: "150",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c.toString()));
  proc.stderr.on("data", (c) => (out += c.toString()));
  await sleep(runMs);
  proc.kill("SIGTERM");
  // Give the supervisor its graceful-shutdown window to exit.
  await new Promise((resolve) => {
    const to = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, 4000);
    proc.on("exit", () => {
      clearTimeout(to);
      resolve();
    });
  });
  return out;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-supervise-"));

  // ---- Scenario 1: a crashing child is restarted and each crash is recorded ----------------------------
  console.log("\n1. Crashing child → restarted with crash.log record + stderr tail");
  {
    const dataDir = path.join(tmp, "crash");
    fs.mkdirSync(dataDir, { recursive: true });
    const counter = path.join(dataDir, "launches.txt");
    const childScript = path.join(tmp, "crasher.cjs");
    fs.writeFileSync(
      childScript,
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');` +
        `process.stderr.write('boom-from-child\\n');process.exit(1);`,
    );
    await runSupervisor({ dataDir, childScript, runMs: 2500 });

    const launches = fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0;
    check(launches >= 3, `child was respawned after each crash (launched ${launches}× in ~2.5s)`);

    const crashLog = path.join(dataDir, "crash.log");
    const crashText = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, "utf8") : "";
    check(/exited unexpectedly/.test(crashText), "crash.log records the unexpected exit");
    check(/code=1/.test(crashText), "crash.log captures the non-zero exit code");
    check(/boom-from-child/.test(crashText), "crash.log captures the child's stderr tail (the OOM-line analogue)");

    const serverLog = path.join(dataDir, "server.log");
    check(fs.existsSync(serverLog) && /boom-from-child/.test(fs.readFileSync(serverLog, "utf8")), "child stdio is teed to server.log");
  }

  // ---- Scenario 2: a supervised-restart exit (75) respawns WITHOUT a crash record ----------------------
  console.log("\n2. Exit code 75 (requested restart) → respawn, NOT counted as a crash");
  {
    const dataDir = path.join(tmp, "restart");
    fs.mkdirSync(dataDir, { recursive: true });
    const counter = path.join(dataDir, "launches.txt");
    const childScript = path.join(tmp, "restarter.cjs");
    // Stay up briefly so it isn't a fast-fail, then request a supervised restart.
    fs.writeFileSync(
      childScript,
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');` +
        `setTimeout(()=>process.exit(75),250);`,
    );
    await runSupervisor({ dataDir, childScript, runMs: 2500 });

    const launches = fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0;
    check(launches >= 2, `restart-requesting child was respawned (launched ${launches}×)`);

    const crashLog = path.join(dataDir, "crash.log");
    const crashText = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, "utf8") : "";
    check(!/exited unexpectedly/.test(crashText), "a requested restart (75) is NOT logged as a crash");
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows file locks — harmless */
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
